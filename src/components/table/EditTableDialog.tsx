// 编辑表结构（设计表）：加载现有列 → 增/删/改名/改类型/非空/默认 → 生成 ALTER TABLE → 刷新树。
// 方言 ALTER 生成在 src/lib/alter.ts。SQLite 对已有列仅支持改名/删列，类型与约束输入禁用。

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc";
import type { TableRef } from "@/ipc/types";
import { errorMessage } from "@/lib/error";
import { TYPES, parseDbType } from "@/lib/sql";
import { buildAlterStatements, type ColEdit } from "@/lib/alter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

interface Row extends ColEdit {
  id: number;
  pk: boolean; // 只读展示，不参与 ALTER
}

const toColEdit = (r: Row): ColEdit => ({
  name: r.name,
  type: r.type,
  length: r.length,
  notNull: r.notNull,
  def: r.def,
  origName: r.origName,
});

export function EditTableDialog({ connId, kind, quoteChar, table, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const types = TYPES[kind] ?? TYPES.mysql;
  const isSqlite = kind === "sqlite";
  const idRef = useRef(1);

  const [loading, setLoading] = useState(true);
  const [original, setOriginal] = useState<ColEdit[]>([]);
  const [columns, setColumns] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    ipc
      .listColumns(connId, table)
      .then((cols) => {
        if (!alive) return;
        const rows: Row[] = cols.map((c) => {
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
        setColumns(rows);
        setOriginal(rows.map(toColEdit));
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

  const addColumn = () =>
    setColumns((cs) => [
      ...cs,
      { id: idRef.current++, name: "", type: types[0], length: "", notNull: false, pk: false, def: "", origName: null },
    ]);
  const removeColumn = (id: number) => setColumns((cs) => cs.filter((c) => c.id !== id));
  const patch = (id: number, p: Partial<Row>) =>
    setColumns((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));

  const stmts = loading ? [] : buildAlterStatements(kind, quoteChar, table, original, columns.map(toColEdit));
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

  // 已有列在 SQLite 下不可改类型/约束（只能改名/删列）。
  const lockMeta = (r: Row) => isSqlite && r.origName !== null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="flex max-h-[88vh] w-[760px] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-5 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">
            {t("editobj.title")}
            <span className="ml-2 font-mono text-xs text-muted-foreground">{table.name}</span>
          </h2>
        </div>

        <div className="flex-1 space-y-3 overflow-auto px-5 py-4">
          {loading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">{t("editobj.loading")}</div>
          ) : (
            <>
              {isSqlite && (
                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                  {t("editobj.sqliteLimited")}
                </div>
              )}

              {/* 列表头 */}
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
                    <Input
                      className="flex-1"
                      value={c.name}
                      onChange={(e) => patch(c.id, { name: e.target.value })}
                      placeholder="column"
                    />
                    <div className="w-28">
                      <Select value={c.type} onValueChange={(v) => patch(c.id, { type: v })} disabled={locked}>
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {typeOpts.map((tp) => (
                            <SelectItem key={tp} value={tp}>
                              {tp}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <Input
                      className="w-14"
                      value={c.length}
                      onChange={(e) => patch(c.id, { length: e.target.value })}
                      placeholder="—"
                      disabled={locked}
                    />
                    <Input
                      className="w-20 flex-1"
                      value={c.def}
                      onChange={(e) => patch(c.id, { def: e.target.value })}
                      placeholder="NULL"
                      disabled={locked}
                    />
                    <div className="flex w-7 justify-center">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-emerald-600"
                        checked={c.pk}
                        disabled
                        title={t("newobj.colPk")}
                      />
                    </div>
                    <div className="flex w-7 justify-center">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-emerald-600"
                        checked={c.notNull}
                        onChange={(e) => patch(c.id, { notNull: e.target.checked })}
                        disabled={locked}
                      />
                    </div>
                    <button
                      onClick={() => removeColumn(c.id)}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive"
                      title={t("editobj.dropColumn")}
                    >
                      <i className="ri-delete-bin-line text-sm" />
                    </button>
                  </div>
                );
              })}

              <div className="space-y-1 pt-1">
                <Label>{t("newobj.previewSql")}</Label>
                <pre className="overflow-auto rounded-md border border-border bg-muted/50 px-2.5 py-2 font-mono text-[11px] text-muted-foreground whitespace-pre-wrap">
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
