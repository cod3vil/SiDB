// 导出进度浮层：右下角堆叠卡片，显示进度条 + 取消 / 关闭。

import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc";
import { useExports } from "@/stores/export";

export function ExportProgressLayer() {
  const { t } = useTranslation();
  const tasks = useExports((s) => s.tasks);
  const remove = useExports((s) => s.remove);
  if (tasks.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-3 right-3 z-[90] flex w-72 flex-col gap-2">
      {tasks.map((tk) => {
        const pct =
          tk.total && tk.total > 0 ? Math.min(100, Math.round((tk.written / tk.total) * 100)) : null;
        const running = tk.status === "running";
        return (
          <div
            key={tk.taskId}
            className="pointer-events-auto rounded-lg border border-border bg-card p-3 shadow-2xl"
          >
            <div className="mb-1.5 flex items-center gap-2">
              <i
                className={
                  running
                    ? "ri-download-2-line text-primary"
                    : tk.status === "done"
                      ? "ri-checkbox-circle-line text-emerald-500"
                      : tk.status === "cancelled"
                        ? "ri-close-circle-line text-muted-foreground"
                        : "ri-error-warning-line text-destructive"
                }
              />
              <span className="truncate text-xs font-medium text-foreground" title={tk.label}>
                {tk.label || t("export.title")}
              </span>
              <button
                onClick={() => {
                  if (running) void ipc.cancelExport(tk.taskId).catch(() => undefined);
                  else remove(tk.taskId);
                }}
                title={running ? t("common.cancel") : t("common.close")}
                className="ml-auto flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <i className={running ? "ri-close-line" : "ri-close-line"} />
              </button>
            </div>

            {running && (
              <div className="mb-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={pct == null ? "h-full w-1/3 animate-pulse bg-primary" : "h-full bg-primary transition-all"}
                  style={pct == null ? undefined : { width: `${pct}%` }}
                />
              </div>
            )}

            <div className="text-[11px] text-muted-foreground">
              {tk.status === "done"
                ? t("export.done", { n: tk.written })
                : tk.status === "cancelled"
                  ? t("export.cancelled", { n: tk.written })
                  : tk.status === "error"
                    ? tk.message || t("export.error")
                    : tk.total
                      ? `${tk.written} / ${tk.total}${pct != null ? ` (${pct}%)` : ""}`
                      : t("export.rowsWritten", { n: tk.written })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
