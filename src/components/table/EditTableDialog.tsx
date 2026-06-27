// 编辑表（设计表）：多标签 —— 字段 / 索引 / 外键 / 选项 / 注释。
// 各标签按「原快照 vs 当前编辑」差异生成 DDL（见 src/lib/alter.ts），合并预览并整体执行。
// 方言差异收敛在 alter.ts；SQLite 仅支持有限操作（类型/约束/外键/选项禁用）。

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc";
import type { TableRef, IndexInfo, ForeignKeyInfo, TableOptions } from "@/ipc/types";
import { errorMessage } from "@/lib/error";
import { TYPES, parseDbType } from "@/lib/sql";
import {
  buildAlterStatements,
  buildIndexStatements,
  buildForeignKeyStatements,
  buildOptionStatements,
  type ColEdit,
  type IdxEdit,
  type FkEdit,
} from "@/lib/alter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Props {
  connId: string;
  kind: string;
  quoteChar: string;
  table: TableRef;
  onClose: () => void;
  onSaved: () => void;
}

interface ColRow extends ColEdit {
  id: number;
  pk: boolean; // 只读展示
}
interface IdxRow extends IdxEdit {
  id: number;
}
interface FkRow extends FkEdit {
  id: number;
}

type Tab = "columns" | "indexes" | "fks" | "options" | "comment";

const toColEdit = (r: ColRow): ColEdit => ({
  name: r.name,
  type: r.type,
  length: r.length,
  notNull: r.notNull,
  def: r.def,
  origName: r.origName,
});
const toIdxEdit = (r: IdxRow): IdxEdit => ({ name: r.name, columns: r.columns, unique: r.unique, method: r.method, origName: r.origName });
const toFkEdit = (r: FkRow): FkEdit => ({
  name: r.name,
  columns: r.columns,
  refTable: r.refTable,
  refColumns: r.refColumns,
  origName: r.origName,
});

// 表选项常用候选（当前库实际值若不在列表内，渲染时会自动并入）。
const ENGINES = ["InnoDB", "MyISAM", "MEMORY", "ARCHIVE", "CSV", "Aria", "NDB"];
const CHARSETS = ["utf8mb4", "utf8", "latin1", "ascii", "gbk", "gb18030", "big5", "binary"];
const COLLATIONS: Record<string, string[]> = {
  utf8mb4: ["utf8mb4_general_ci", "utf8mb4_unicode_ci", "utf8mb4_0900_ai_ci", "utf8mb4_bin"],
  utf8: ["utf8_general_ci", "utf8_unicode_ci", "utf8_bin"],
  latin1: ["latin1_swedish_ci", "latin1_general_ci", "latin1_bin"],
  gbk: ["gbk_chinese_ci", "gbk_bin"],
  ascii: ["ascii_general_ci", "ascii_bin"],
};
const INDEX_METHODS: Record<string, string[]> = {
  mysql: ["BTREE", "HASH"],
  postgres: ["btree", "hash", "gin", "gist", "brin", "spgist"],
  sqlite: [],
};

/** 有序多列选择：已选列以可移除芯片按顺序展示，下拉追加未选列。 */
function ColumnsPicker({
  all,
  value,
  onChange,
  placeholder,
}: {
  all: string[];
  value: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const remaining = all.filter((c) => !value.includes(c));
  return (
    <div className="flex min-h-8 flex-1 flex-wrap items-center gap-1 rounded-md border border-border bg-background px-1.5 py-1">
      {value.map((c) => (
        <span key={c} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">
          {c}
          <button onClick={() => onChange(value.filter((x) => x !== c))} className="text-muted-foreground hover:text-destructive">
            <i className="ri-close-line" />
          </button>
        </span>
      ))}
      {remaining.length > 0 && (
        <Select value="" onValueChange={(v) => v && onChange([...value, v])}>
          <SelectTrigger className="h-6 w-auto gap-1 border-none bg-transparent px-1 text-xs text-muted-foreground">
            <SelectValue placeholder={value.length === 0 ? placeholder : "+"} />
          </SelectTrigger>
          <SelectContent>
            {remaining.map((c) => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

/** 带「当前值兜底」的单选：库里实际值不在候选中时并入列表。 */
function PickSelect({
  value,
  options,
  onChange,
  placeholder,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const opts = value && !options.includes(value) ? [value, ...options] : options;
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger className="h-8"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent>
        {opts.map((o) => (
          <SelectItem key={o} value={o}>{o}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function EditTableDialog({ connId, kind, quoteChar, table, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const types = TYPES[kind] ?? TYPES.mysql;
  const isSqlite = kind === "sqlite";
  const isMysql = kind === "mysql";
  const idRef = useRef(1);

  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("columns");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 字段
  const [origCols, setOrigCols] = useState<ColEdit[]>([]);
  const [columns, setColumns] = useState<ColRow[]>([]);
  // 索引
  const [origIdx, setOrigIdx] = useState<IndexInfo[]>([]);
  const [indexes, setIndexes] = useState<IdxRow[]>([]);
  // 外键
  const [origFk, setOrigFk] = useState<ForeignKeyInfo[]>([]);
  const [fks, setFks] = useState<FkRow[]>([]);
  // 选项 + 注释
  const EMPTY_OPTS: TableOptions = { engine: null, charset: null, collation: null, comment: null };
  const [origOpts, setOrigOpts] = useState<TableOptions>(EMPTY_OPTS);
  const [opts, setOpts] = useState<TableOptions>(EMPTY_OPTS);
  // 外键引用：可选表名列表 + 各引用表的列缓存。
  const [tableNames, setTableNames] = useState<string[]>([]);
  const [refCols, setRefCols] = useState<Record<string, string[]>>({});

  // 本表字段名（供索引 / 外键列选择）。
  const colNames = columns.map((c) => c.name.trim()).filter(Boolean);
  const idxMethods = INDEX_METHODS[kind] ?? [];

  // 按需加载某引用表的列。
  const loadRefCols = (tbl: string) => {
    const name = tbl.trim();
    if (!name || refCols[name]) return;
    ipc
      .listColumns(connId, { database: table.database, schema: table.schema, name })
      .then((cols) => setRefCols((m) => ({ ...m, [name]: cols.map((c) => c.name) })))
      .catch(() => undefined);
  };

  // 库内表名（外键引用表下拉）。
  useEffect(() => {
    if (isSqlite) return;
    ipc
      .listTables(connId, table.database ?? "", table.schema ?? null)
      .then((list) => setTableNames(list.map((x) => x.name)))
      .catch(() => undefined);
  }, [connId, table, isSqlite]);

  useEffect(() => {
    let alive = true;
    Promise.all([ipc.getTableSchema(connId, table), ipc.getTableOptions(connId, table).catch(() => EMPTY_OPTS)])
      .then(([schema, options]) => {
        if (!alive) return;
        const colRows: ColRow[] = schema.columns.map((c) => {
          const { type, length } = parseDbType(c.db_type);
          return {
            id: idRef.current++,
            name: c.name,
            type,
            length,
            notNull: !c.nullable,
            def: c.default ?? "",
            pk: c.is_primary_key,
            origName: c.name,
          };
        });
        setColumns(colRows);
        setOrigCols(colRows.map(toColEdit));

        // 主键索引不在此管理（由字段 PK 体现）。
        const idxList = schema.indexes.filter((i) => !i.primary);
        setOrigIdx(idxList);
        setIndexes(
          idxList.map((i) => ({ id: idRef.current++, name: i.name, columns: i.columns, unique: i.unique, method: "", origName: i.name })),
        );

        setOrigFk(schema.foreign_keys);
        setFks(
          schema.foreign_keys.map((f) => ({
            id: idRef.current++,
            name: f.name,
            columns: f.columns,
            refTable: f.ref_table,
            refColumns: f.ref_columns,
            origName: f.name,
          })),
        );
        // 预载现有外键引用表的列。
        for (const f of schema.foreign_keys) loadRefCols(f.ref_table);

        setOrigOpts(options);
        setOpts(options);
        setLoading(false);
      })
      .catch((e) => {
        if (!alive) return;
        setErr(errorMessage(e));
        setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [connId, table]);

  // ---- 字段操作 ----
  const addColumn = () =>
    setColumns((cs) => [
      ...cs,
      { id: idRef.current++, name: "", type: types[0], length: "", notNull: false, pk: false, def: "", origName: null },
    ]);
  const removeColumn = (id: number) => setColumns((cs) => cs.filter((c) => c.id !== id));
  const patchCol = (id: number, p: Partial<ColRow>) =>
    setColumns((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));
  const lockMeta = (r: ColRow) => isSqlite && r.origName !== null;

  // ---- 索引操作 ----
  const addIndex = () =>
    setIndexes((xs) => [...xs, { id: idRef.current++, name: "", columns: [], unique: false, method: "", origName: null }]);
  const removeIndex = (id: number) => setIndexes((xs) => xs.filter((x) => x.id !== id));
  const patchIdx = (id: number, p: Partial<IdxRow>) =>
    setIndexes((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)));

  // ---- 外键操作 ----
  const addFk = () =>
    setFks((xs) => [
      ...xs,
      { id: idRef.current++, name: "", columns: [], refTable: "", refColumns: [], origName: null },
    ]);
  const removeFk = (id: number) => setFks((xs) => xs.filter((x) => x.id !== id));
  const patchFk = (id: number, p: Partial<FkRow>) =>
    setFks((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } : x)));

  // ---- 合并 DDL ----
  const stmts = loading
    ? []
    : [
        ...buildAlterStatements(kind, quoteChar, table, origCols, columns.map(toColEdit)),
        ...buildIndexStatements(kind, quoteChar, table, origIdx, indexes.map(toIdxEdit)),
        ...(isSqlite ? [] : buildForeignKeyStatements(kind, quoteChar, table, origFk, fks.map(toFkEdit))),
        ...buildOptionStatements(kind, quoteChar, table, origOpts, opts),
      ];
  const hasChanges = stmts.length > 0;

  const save = async () => {
    if (!hasChanges) return;
    setBusy(true);
    setErr(null);
    try {
      await ipc.runSql(connId, "ddl", stmts.join("\n"), 0, 1, null);
      onSaved();
    } catch (e) {
      setErr(errorMessage(e));
      setBusy(false);
    }
  };

  const tabs: { key: Tab; label: string; hide?: boolean }[] = [
    { key: "columns", label: t("newobj.columns") },
    { key: "indexes", label: t("editobj.tabIndexes") },
    { key: "fks", label: t("editobj.tabForeignKeys"), hide: isSqlite },
    { key: "options", label: t("editobj.tabOptions"), hide: !isMysql },
    { key: "comment", label: t("editobj.tabComment"), hide: isSqlite },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="flex max-h-[88vh] w-[820px] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-5 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">
            {t("editobj.title")}
            <span className="ml-2 font-mono text-xs text-muted-foreground">{table.name}</span>
          </h2>
        </div>

        {/* 标签栏 */}
        {!loading && (
          <div className="flex shrink-0 items-stretch border-b border-border px-3">
            {tabs
              .filter((tb) => !tb.hide)
              .map((tb) => (
                <button
                  key={tb.key}
                  onClick={() => setTab(tb.key)}
                  className={cn(
                    "border-b-2 px-3 py-2 text-xs",
                    tab === tb.key
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {tb.label}
                </button>
              ))}
          </div>
        )}

        <div className="h-[460px] space-y-3 overflow-auto px-5 py-4">
          {loading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">{t("editobj.loading")}</div>
          ) : (
            <>
              {isSqlite && tab === "columns" && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                  {t("editobj.sqliteLimited")}
                </div>
              )}

              {/* ===== 字段 ===== */}
              {tab === "columns" && (
                <>
                  <div className="flex items-center justify-between">
                    <Label>{t("newobj.columns")}</Label>
                    <Button size="sm" variant="outline" onClick={addColumn}>
                      <i className="ri-add-line" />
                      {t("newobj.addColumn")}
                    </Button>
                  </div>
                  <div className="flex items-center gap-1.5 px-1 text-[10px] font-medium uppercase text-muted-foreground">
                    <span className="flex-1">{t("newobj.colName")}</span>
                    <span className="w-28">{t("newobj.colType")}</span>
                    <span className="w-14">{t("newobj.colLength")}</span>
                    <span className="w-20 flex-1">{t("newobj.colDefault")}</span>
                    <span className="w-7 text-center" title={t("newobj.colPk")}>PK</span>
                    <span className="w-7 text-center" title={t("newobj.colNotNull")}>NN</span>
                    <span className="w-6" />
                  </div>
                  {columns.map((c) => {
                    const locked = lockMeta(c);
                    const typeOpts = types.includes(c.type) ? types : [c.type, ...types];
                    return (
                      <div key={c.id} className="flex items-center gap-1.5">
                        <Input className="flex-1" value={c.name} onChange={(e) => patchCol(c.id, { name: e.target.value })} placeholder="column" />
                        <div className="w-28">
                          <Select value={c.type} onValueChange={(v) => patchCol(c.id, { type: v })} disabled={locked}>
                            <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {typeOpts.map((tp) => (
                                <SelectItem key={tp} value={tp}>{tp}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <Input className="w-14" value={c.length} onChange={(e) => patchCol(c.id, { length: e.target.value })} placeholder="—" disabled={locked} />
                        <Input className="w-20 flex-1" value={c.def} onChange={(e) => patchCol(c.id, { def: e.target.value })} placeholder="NULL" disabled={locked} />
                        <div className="flex w-7 justify-center">
                          <input type="checkbox" className="h-3.5 w-3.5 accent-emerald-600" checked={c.pk} disabled title={t("newobj.colPk")} />
                        </div>
                        <div className="flex w-7 justify-center">
                          <input type="checkbox" className="h-3.5 w-3.5 accent-emerald-600" checked={c.notNull} onChange={(e) => patchCol(c.id, { notNull: e.target.checked })} disabled={locked} />
                        </div>
                        <button onClick={() => removeColumn(c.id)} className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive" title={t("editobj.dropColumn")}>
                          <i className="ri-delete-bin-line text-sm" />
                        </button>
                      </div>
                    );
                  })}
                </>
              )}

              {/* ===== 索引 ===== */}
              {tab === "indexes" && (
                <>
                  <div className="flex items-center justify-between">
                    <Label>{t("editobj.tabIndexes")}</Label>
                    <Button size="sm" variant="outline" onClick={addIndex}>
                      <i className="ri-add-line" />
                      {t("editobj.addIndex")}
                    </Button>
                  </div>
                  <div className="flex items-center gap-1.5 px-1 text-[10px] font-medium uppercase text-muted-foreground">
                    <span className="w-36">{t("editobj.idxName")}</span>
                    <span className="flex-1">{t("editobj.idxColumns")}</span>
                    {idxMethods.length > 0 && <span className="w-24">{t("editobj.idxMethod")}</span>}
                    <span className="w-12 text-center">{t("editobj.idxUnique")}</span>
                    <span className="w-6" />
                  </div>
                  {indexes.length === 0 && <div className="px-1 py-2 text-xs text-muted-foreground/70">{t("editobj.noIndexes")}</div>}
                  {indexes.map((x) => (
                    <div key={x.id} className="flex items-center gap-1.5">
                      <Input className="w-36" value={x.name} onChange={(e) => patchIdx(x.id, { name: e.target.value })} placeholder="idx_name" />
                      <ColumnsPicker all={colNames} value={x.columns} onChange={(v) => patchIdx(x.id, { columns: v })} placeholder={t("editobj.pickColumns")} />
                      {idxMethods.length > 0 && (
                        <div className="w-24">
                          <Select value={x.method || undefined} onValueChange={(v) => patchIdx(x.id, { method: v })}>
                            <SelectTrigger className="h-8"><SelectValue placeholder="—" /></SelectTrigger>
                            <SelectContent>
                              {idxMethods.map((m) => (
                                <SelectItem key={m} value={m}>{m}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                      <div className="flex w-12 justify-center">
                        <input type="checkbox" className="h-3.5 w-3.5 accent-emerald-600" checked={x.unique} onChange={(e) => patchIdx(x.id, { unique: e.target.checked })} />
                      </div>
                      <button onClick={() => removeIndex(x.id)} className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive">
                        <i className="ri-delete-bin-line text-sm" />
                      </button>
                    </div>
                  ))}
                </>
              )}

              {/* ===== 外键 ===== */}
              {tab === "fks" && (
                <>
                  <div className="flex items-center justify-between">
                    <Label>{t("editobj.tabForeignKeys")}</Label>
                    <Button size="sm" variant="outline" onClick={addFk}>
                      <i className="ri-add-line" />
                      {t("editobj.addFk")}
                    </Button>
                  </div>
                  <div className="flex items-center gap-1.5 px-1 text-[10px] font-medium uppercase text-muted-foreground">
                    <span className="w-32">{t("editobj.fkName")}</span>
                    <span className="flex-1">{t("editobj.fkColumns")}</span>
                    <span className="w-28">{t("editobj.fkRefTable")}</span>
                    <span className="flex-1">{t("editobj.fkRefColumns")}</span>
                    <span className="w-6" />
                  </div>
                  {fks.length === 0 && <div className="px-1 py-2 text-xs text-muted-foreground/70">{t("editobj.noFks")}</div>}
                  {fks.map((x) => (
                    <div key={x.id} className="flex items-center gap-1.5">
                      <Input className="w-32" value={x.name} onChange={(e) => patchFk(x.id, { name: e.target.value })} placeholder="fk_name" />
                      <ColumnsPicker all={colNames} value={x.columns} onChange={(v) => patchFk(x.id, { columns: v })} placeholder={t("editobj.pickColumns")} />
                      <div className="w-28">
                        <Select
                          value={x.refTable || undefined}
                          onValueChange={(v) => {
                            loadRefCols(v);
                            patchFk(x.id, { refTable: v, refColumns: [] });
                          }}
                        >
                          <SelectTrigger className="h-8"><SelectValue placeholder={t("editobj.fkRefTable")} /></SelectTrigger>
                          <SelectContent>
                            {(x.refTable && !tableNames.includes(x.refTable) ? [x.refTable, ...tableNames] : tableNames).map((tn) => (
                              <SelectItem key={tn} value={tn}>{tn}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <ColumnsPicker all={refCols[x.refTable] ?? x.refColumns} value={x.refColumns} onChange={(v) => patchFk(x.id, { refColumns: v })} placeholder={t("editobj.fkRefColumns")} />
                      <button onClick={() => removeFk(x.id)} className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive">
                        <i className="ri-delete-bin-line text-sm" />
                      </button>
                    </div>
                  ))}
                </>
              )}

              {/* ===== 选项（MySQL）===== */}
              {tab === "options" && (
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label>{t("editobj.engine")}</Label>
                    <PickSelect value={opts.engine ?? ""} options={ENGINES} onChange={(v) => setOpts((o) => ({ ...o, engine: v }))} placeholder="InnoDB" />
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1 space-y-1">
                      <Label>{t("editobj.charset")}</Label>
                      <PickSelect
                        value={opts.charset ?? ""}
                        options={CHARSETS}
                        onChange={(v) => setOpts((o) => ({ ...o, charset: v, collation: null }))}
                        placeholder="utf8mb4"
                      />
                    </div>
                    <div className="flex-1 space-y-1">
                      <Label>{t("editobj.collation")}</Label>
                      <PickSelect
                        value={opts.collation ?? ""}
                        options={COLLATIONS[(opts.charset ?? "").trim()] ?? []}
                        onChange={(v) => setOpts((o) => ({ ...o, collation: v }))}
                        placeholder="utf8mb4_general_ci"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* ===== 注释 ===== */}
              {tab === "comment" && (
                <div className="space-y-1">
                  <Label>{t("editobj.tableComment")}</Label>
                  <textarea
                    value={opts.comment ?? ""}
                    onChange={(e) => setOpts((o) => ({ ...o, comment: e.target.value }))}
                    rows={4}
                    className="w-full resize-y rounded-md border border-border bg-background p-2 text-sm text-foreground outline-none focus:border-primary"
                    placeholder={t("editobj.commentPlaceholder")}
                  />
                </div>
              )}

              {/* 预览（所有标签共用，汇总全部改动） */}
              <div className="space-y-1 pt-1">
                <Label>{t("newobj.previewSql")}</Label>
                <pre className="max-h-40 overflow-auto rounded-md border border-border bg-muted/50 px-2.5 py-2 font-mono text-[11px] text-muted-foreground whitespace-pre-wrap">
                  {hasChanges ? stmts.join("\n") : t("editobj.noChange")}
                </pre>
              </div>

              {err && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {err}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-2 px-5 py-3 border-t border-border">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={save} disabled={busy || loading || !hasChanges}>
            {busy ? t("editobj.saving") : t("editobj.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
