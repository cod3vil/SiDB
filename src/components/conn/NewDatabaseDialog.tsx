// 新建数据库（可视化）：填库名（MySQL 可选字符集）→ 执行 CREATE DATABASE → 刷新树。

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc";
import { errorMessage } from "@/lib/error";
import { quoteIdent } from "@/lib/sql";
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
  onClose: () => void;
  onCreated: () => void;
}

const MYSQL_CHARSETS = ["utf8mb4", "utf8", "latin1", "gbk"];

export function NewDatabaseDialog({ connId, kind, quoteChar, onClose, onCreated }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [charset, setCharset] = useState("utf8mb4");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const isMysql = kind === "mysql";
  const sql =
    `CREATE DATABASE ${name.trim() ? quoteIdent(name.trim(), quoteChar) : "<name>"}` +
    (isMysql && name.trim() ? ` CHARACTER SET ${charset}` : "");

  const create = async () => {
    if (!name.trim()) {
      setErr(t("newobj.nameRequired"));
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await ipc.runSql(connId, "ddl", sql, 0, 1, null);
      onCreated();
    } catch (e) {
      setErr(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="w-[420px] overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">{t("newobj.dbTitle")}</h2>
        </div>
        <div className="space-y-3 px-5 py-4">
          <div className="space-y-1">
            <Label>{t("newobj.dbName")}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="my_database" />
          </div>
          {isMysql && (
            <div className="space-y-1">
              <Label>{t("newobj.charset")}</Label>
              <Select value={charset} onValueChange={setCharset}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MYSQL_CHARSETS.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="rounded-md border border-border bg-muted/50 px-2.5 py-2 font-mono text-[11px] text-muted-foreground">
            {sql}
          </div>
          {err && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {err}
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border">
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
