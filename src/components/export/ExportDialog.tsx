// 结果导出弹窗：选择格式（CSV / XLSX / SQL）与范围（全部 / 当前页 / 指定行数）。

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { ExportFormat, ExportScope } from "@/ipc/types";

interface Props {
  onClose: () => void;
  onConfirm: (opts: { format: ExportFormat; scope: ExportScope; limit: number }) => void;
}

const FORMATS: ExportFormat[] = ["csv", "xlsx", "sql"];

export function ExportDialog({ onClose, onConfirm }: Props) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [scope, setScope] = useState<ExportScope>("all");
  const [limit, setLimit] = useState("1000");

  const scopes: { key: ExportScope; label: string }[] = [
    { key: "all", label: t("export.scopeAll") },
    { key: "page", label: t("export.scopePage") },
    { key: "rows", label: t("export.scopeRows") },
  ];

  const submit = () =>
    onConfirm({ format, scope, limit: Math.max(1, parseInt(limit || "0", 10) || 0) });

  const disabled = scope === "rows" && (!limit || parseInt(limit, 10) <= 0);

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="w-[400px] overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">{t("export.title")}</h2>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="space-y-1.5">
            <Label>{t("export.format")}</Label>
            <div className="flex gap-1.5">
              {FORMATS.map((f) => (
                <button
                  key={f}
                  onClick={() => setFormat(f)}
                  className={cn(
                    "flex-1 rounded-md border px-2 py-1.5 text-xs font-medium uppercase",
                    format === f
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-accent",
                  )}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>{t("export.rows")}</Label>
            <div className="flex gap-1.5">
              {scopes.map((s) => (
                <button
                  key={s.key}
                  onClick={() => setScope(s.key)}
                  className={cn(
                    "flex-1 rounded-md border px-2 py-1.5 text-xs",
                    scope === s.key
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-accent",
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
            {scope === "rows" && (
              <Input
                value={limit}
                onChange={(e) => setLimit(e.target.value.replace(/[^0-9]/g, ""))}
                autoFocus
                placeholder="1000"
                className="mt-1.5"
              />
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border">
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={disabled}>
            {t("export.title")}
          </Button>
        </div>
      </div>
    </div>
  );
}
