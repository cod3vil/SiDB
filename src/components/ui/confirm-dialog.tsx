// 应用内确认弹窗（替代原生 confirm，避免与 Radix 菜单/ webview 焦点冲突）。

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

interface Props {
  message: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({ message, danger, onCancel, onConfirm }: Props) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="w-[360px] rounded-xl border border-border bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-sm text-foreground">{message}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button variant={danger ? "destructive" : "default"} onClick={onConfirm} autoFocus>
            {t("common.confirm")}
          </Button>
        </div>
      </div>
    </div>
  );
}
