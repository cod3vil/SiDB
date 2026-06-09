// 新建表（可视化设计器）：表名 + 列（名/类型/长度/非空/主键/自增/默认）→ CREATE TABLE → 刷新树。

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc";
import { errorMessage } from "@/lib/error";
import { qualifiedTable, quoteIdent } from "@/lib/sql";
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
  database: string | null;
  schema: string | null;
  onClose: () => void;
  onCreated: () => void;
}

interface Column {
  id: number;
  name: string;
  type: string;
  length: string;
  notNull: boolean;
  pk: boolean;
  autoInc: boolean;
  def: string;
}

const TYPES: Record<string, string[]> = {
  mysql: ["INT", "BIGINT", "TINYINT", "SMALLINT", "DECIMAL", "FLOAT", "DOUBLE", "VARCHAR", "CHAR", "TEXT", "LONGTEXT", "DATE", "DATETIME", "TIMESTAMP", "TIME", "BOOLEAN", "JSON", "BLOB"],
  postgres: ["integer", "bigint", "smallint", "serial", "bigserial", "numeric", "real", "double precision", "varchar", "char", "text", "date", "timestamp", "timestamptz", "time", "boolean", "jsonb", "uuid", "bytea"],
  sqlite: ["INTEGER", "TEXT", "REAL", "NUMERIC", "BLOB"],
};

export function NewTableDialog({ connId, kind, quoteChar, database, schema, onClose, onCreated }: Props) {
  const { t } = useTranslation();
  const types = TYPES[kind] ?? TYPES.mysql;
  const idRef = useRef(2);
  const isMysql = kind === "mysql";

  const [tableName, setTableName] = useState("");
  const [columns, setColumns] = useState<Column[]>([
    { id: 1, name: "id", type: types[0], length: "", notNull: true, pk: true, autoInc: isMysql, def: "" },
  ]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const addColumn = () =>
    setColumns((cs) => [
      ...cs,
      { id: idRef.current++, name: "", type: types[0], length: "", notNull: false, pk: false, autoInc: false, def: "" },
    ]);
  const removeColumn = (id: number) => setColumns((cs) => cs.filter((c) => c.id !== id));
  const patch = (id: number, p: Partial<Column>) =>
    setColumns((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)));

  const buildSql = (): string => {
    const cols = columns.filter((c) => c.name.trim());
    const defs = cols.map((c) => {
      let s = `${quoteIdent(c.name.trim(), quoteChar)} ${c.type}`;
      if (c.length.trim()) s += `(${c.length.trim()})`;
      if (isMysql && c.autoInc) s += " AUTO_INCREMENT";
      if (c.notNull) s += " NOT NULL";
      if (c.def.trim()) s += ` DEFAULT ${c.def.trim()}`;
      return s;
    });
    const pks = cols.filter((c) => c.pk).map((c) => quoteIdent(c.name.trim(), quoteChar));
    if (pks.length) defs.push(`PRIMARY KEY (${pks.join(", ")})`);
    const qt = qualifiedTable(quoteChar, database, schema, tableName.trim() || "<table>");
    return `CREATE TABLE ${qt} (\n  ${defs.join(",\n  ")}\n);`;
  };

  const create = async () => {
    if (!tableName.trim()) {
      setErr(t("newobj.nameRequired"));
      return;
    }
    if (!columns.some((c) => c.name.trim())) {
      setErr(t("newobj.needColumn"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await ipc.runSql(connId, "ddl", buildSql(), 0, 1, null);
      onCreated();
    } catch (e) {
      setErr(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-[720px] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-5 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">{t("newobj.tableTitle")}</h2>
        </div>

        <div className="flex-1 space-y-3 overflow-auto px-5 py-4">
          <div className="space-y-1">
            <Label>{t("newobj.tableName")}</Label>
            <Input value={tableName} onChange={(e) => setTableName(e.target.value)} autoFocus placeholder="my_table" />
          </div>

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
            {isMysql && <span className="w-7 text-center" title={t("newobj.colAutoInc")}>AI</span>}
            <span className="w-6" />
          </div>

          {columns.map((c) => (
            <div key={c.id} className="flex items-center gap-1.5">
              <Input className="flex-1" value={c.name} onChange={(e) => patch(c.id, { name: e.target.value })} placeholder="column" />
              <div className="w-28">
                <Select value={c.type} onValueChange={(v) => patch(c.id, { type: v })}>
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {types.map((tp) => (
                      <SelectItem key={tp} value={tp}>
                        {tp}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Input className="w-14" value={c.length} onChange={(e) => patch(c.id, { length: e.target.value })} placeholder="—" />
              <Input className="w-20 flex-1" value={c.def} onChange={(e) => patch(c.id, { def: e.target.value })} placeholder="NULL" />
              <div className="flex w-7 justify-center">
                <input type="checkbox" className="h-3.5 w-3.5 accent-emerald-600" checked={c.pk} onChange={(e) => patch(c.id, { pk: e.target.checked })} />
              </div>
              <div className="flex w-7 justify-center">
                <input type="checkbox" className="h-3.5 w-3.5 accent-emerald-600" checked={c.notNull} onChange={(e) => patch(c.id, { notNull: e.target.checked })} />
              </div>
              {isMysql && (
                <div className="flex w-7 justify-center">
                  <input type="checkbox" className="h-3.5 w-3.5 accent-emerald-600" checked={c.autoInc} onChange={(e) => patch(c.id, { autoInc: e.target.checked })} />
                </div>
              )}
              <button
                onClick={() => removeColumn(c.id)}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-destructive"
                title={t("common.close")}
              >
                <i className="ri-delete-bin-line text-sm" />
              </button>
            </div>
          ))}

          <div className="space-y-1 pt-1">
            <Label>{t("newobj.previewSql")}</Label>
            <pre className="overflow-auto rounded-md border border-border bg-muted/50 px-2.5 py-2 font-mono text-[11px] text-muted-foreground whitespace-pre-wrap">
              {buildSql()}
            </pre>
          </div>

          {err && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {err}
            </div>
          )}
        </div>

        <div className="flex shrink-0 justify-end gap-2 px-5 py-3 border-t border-border">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={create} disabled={busy}>
            {busy ? t("newobj.creating") : t("newobj.create")}
          </Button>
        </div>
      </div>
    </div>
  );
}
