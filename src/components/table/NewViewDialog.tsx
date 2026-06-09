// 新建视图（可视化）：视图名 + 定义（SELECT）→ 执行 CREATE VIEW → 刷新树。

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc";
import { errorMessage } from "@/lib/error";
import { qualifiedTable } from "@/lib/sql";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  connId: string;
  quoteChar: string;
  database: string | null;
  schema: string | null;
  onClose: () => void;
  onCreated: () => void;
}

export function NewViewDialog({ connId, quoteChar, database, schema, onClose, onCreated }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [def, setDef] = useState("SELECT * FROM table_name");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const qt = qualifiedTable(quoteChar, database, schema, name.trim() || "<view>");
  const sql = `CREATE VIEW ${qt} AS\n${def.trim() || "<select>"};`;

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[560px] overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">{t("newobj.viewTitle")}</h2>
        </div>
        <div className="space-y-3 px-5 py-4">
          <div className="space-y-1">
            <Label>{t("newobj.viewName")}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="my_view" />
          </div>
          <div className="space-y-1">
            <Label>{t("newobj.viewDef")}</Label>
            <textarea
              value={def}
              onChange={(e) => setDef(e.target.value)}
              spellCheck={false}
              rows={5}
              className="w-full resize-y rounded-md border border-input bg-background px-2.5 py-1.5 font-mono text-xs text-foreground outline-none focus:border-ring focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="rounded-md border border-border bg-muted/50 px-2.5 py-2 font-mono text-[11px] text-muted-foreground whitespace-pre-wrap">
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
