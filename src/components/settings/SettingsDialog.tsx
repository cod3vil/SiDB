// 设置：AI provider / model / API Key（key 经后端存入系统钥匙串，前端只存 key_configured 标记）。

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc";
import type { Settings } from "@/ipc/types";
import { errorMessage } from "@/lib/error";
import { toast } from "@/stores/toast";
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
  onClose: () => void;
}

const PROVIDERS = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "custom", label: "OpenAI Compatible" },
];

export function SettingsDialog({ onClose }: Props) {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [provider, setProvider] = useState("anthropic");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    ipc
      .getSettings()
      .then((s) => {
        setSettings(s);
        setProvider(s.ai.provider);
        setModel(s.ai.model);
        setBaseUrl(s.ai.base_url ?? "");
        setKeyConfigured(s.ai.key_configured);
      })
      .catch((e) => toast.error(errorMessage(e)));
  }, []);

  const needsBaseUrl = provider !== "anthropic";

  const test = async () => {
    if (!apiKey.trim()) {
      toast.error(t("settings.keyRequired"));
      return;
    }
    setTesting(true);
    try {
      await ipc.aiTestProvider({
        provider,
        api_key: apiKey.trim(),
        model: model.trim(),
        base_url: needsBaseUrl ? baseUrl.trim() || null : null,
      });
      setKeyConfigured(true);
      toast.success(t("settings.tested"));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      await ipc.setSettings({
        ...settings,
        ai: {
          provider,
          model: model.trim(),
          base_url: needsBaseUrl ? baseUrl.trim() || null : null,
          key_configured: keyConfigured,
        },
      });
      toast.success(t("settings.saved"));
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="w-[460px] overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">
            {t("settings.title")} · {t("settings.ai")}
          </h2>
        </div>

        <div className="space-y-3 px-5 py-4">
          <div className="space-y-1">
            <Label>{t("settings.provider")}</Label>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDERS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label>{t("settings.model")}</Label>
            <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-sonnet-4-6" />
          </div>

          {needsBaseUrl && (
            <div className="space-y-1">
              <Label>{t("settings.baseUrl")}</Label>
              <Input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
              />
            </div>
          )}

          <div className="space-y-1">
            <Label>{t("settings.apiKey")}</Label>
            <Input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={keyConfigured ? t("settings.keyConfigured") : "sk-…"}
            />
            <p className="text-[11px] text-muted-foreground/70">{t("settings.keyHint")}</p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-3 border-t border-border">
          <Button variant="outline" onClick={test} disabled={testing || saving}>
            {testing ? t("settings.testing") : t("settings.testConn")}
          </Button>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button onClick={save} disabled={saving || !settings}>
              {t("settings.save")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
