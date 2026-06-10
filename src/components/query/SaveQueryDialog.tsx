// 保存查询：输入名称即可。

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  initialName?: string;
  onClose: () => void;
  onConfirm: (name: string) => void;
}

export function SaveQueryDialog({ initialName, onClose, onConfirm }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName ?? "");

  const submit = () => {
    if (name.trim()) onConfirm(name.trim());
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="w-[380px] overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">{t("editor.saveTitle")}</h2>
        </div>
        <div className="space-y-1 px-5 py-4">
          <Label>{t("editor.saveName")}</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            placeholder="my_query"
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border">
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={!name.trim()}>
            {t("editor.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
