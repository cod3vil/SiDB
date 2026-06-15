// 顶部居中的 toast 堆叠容器。点击可手动关闭，否则定时自动消失。

import { useToasts, type ToastKind } from "@/stores/toast";
import { cn } from "@/lib/utils";

const ICON: Record<ToastKind, string> = {
  error: "ri-error-warning-line",
  info: "ri-information-line",
  success: "ri-checkbox-circle-line",
};

const TONE: Record<ToastKind, string> = {
  error: "border-destructive bg-destructive text-white",
  info: "border-transparent bg-foreground text-background",
  success: "border-emerald-600 bg-emerald-600 text-white",
};

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[100] flex flex-col items-center gap-2">
      {toasts.map((t) => (
        <button
          key={t.id}
          onClick={() => dismiss(t.id)}
          className={cn(
            "animate-toast-in pointer-events-auto flex max-w-[90vw] items-start gap-2 rounded-md border px-3.5 py-2.5 text-left text-sm font-medium shadow-xl",
            TONE[t.kind],
          )}
        >
          <i className={cn(ICON[t.kind], "mt-px shrink-0")} />
          <span className="break-words">{t.message}</span>
        </button>
      ))}
    </div>
  );
}
