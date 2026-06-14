// 设置：分页签 —— 通用 / AI / 更新。
// AI Key 经后端存入系统钥匙串，前端只存 key_configured 标记。

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc";
import type { Settings } from "@/ipc/types";
import { errorMessage } from "@/lib/error";
import { toast } from "@/stores/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { checkUpdate, installUpdate, type Update } from "@/lib/update";
import { version as currentVersion } from "../../../package.json";

interface Props {
  onClose: () => void;
}

const PROVIDERS = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "custom", label: "OpenAI Compatible" },
];

type Tab = "general" | "ai" | "update";

export function SettingsDialog({ onClose }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("general");
  const [settings, setSettings] = useState<Settings | null>(null);

  // 通用
  const [pageSize, setPageSize] = useState("1000");
  const [fontSize, setFontSize] = useState("13");
  const [uppercase, setUppercase] = useState(false);
  const [autoCheck, setAutoCheck] = useState(true);

  // AI
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
        setPageSize(String(s.default_page_size));
        setFontSize(String(s.editor_font_size));
        setUppercase(s.auto_uppercase_keywords);
        setAutoCheck(s.auto_check_update);
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
        default_page_size: Math.max(1, parseInt(pageSize || "0", 10) || 1000),
        editor_font_size: Math.max(8, parseInt(fontSize || "0", 10) || 13),
        auto_uppercase_keywords: uppercase,
        auto_check_update: autoCheck,
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

  const tabs: { key: Tab; label: string }[] = [
    { key: "general", label: t("settings.tabGeneral") },
    { key: "ai", label: t("settings.ai") },
    { key: "update", label: t("settings.tabUpdate") },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="flex h-[460px] w-[480px] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">{t("settings.title")}</h2>
        </div>

        <div className="flex gap-1 border-b border-border px-3 pt-2">
          {tabs.map((tb) => (
            <button
              key={tb.key}
              onClick={() => setTab(tb.key)}
              className={cn(
                "rounded-t-md px-3 py-1.5 text-xs font-medium",
                tab === tb.key
                  ? "border-b-2 border-primary text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tb.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto px-5 py-4">
          {tab === "general" && (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label>{t("settings.defaultPageSize")}</Label>
                <Input
                  value={pageSize}
                  onChange={(e) => setPageSize(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="1000"
                />
              </div>
              <div className="space-y-1">
                <Label>{t("settings.fontSize")}</Label>
                <Input
                  value={fontSize}
                  onChange={(e) => setFontSize(e.target.value.replace(/[^0-9]/g, ""))}
                  placeholder="13"
                />
              </div>
              <label className="flex cursor-pointer select-none items-center gap-2 text-xs text-foreground">
                <Checkbox checked={uppercase} onCheckedChange={(c) => setUppercase(c === true)} />
                {t("settings.uppercase")}
              </label>
            </div>
          )}

          {tab === "ai" && (
            <div className="space-y-3">
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
              <Button variant="outline" onClick={test} disabled={testing || saving}>
                {testing ? t("settings.testing") : t("settings.testConn")}
              </Button>
            </div>
          )}

          {tab === "update" && <UpdateTab autoCheck={autoCheck} setAutoCheck={setAutoCheck} />}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={save} disabled={saving || !settings}>
            {t("settings.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function UpdateTab({
  autoCheck,
  setAutoCheck,
}: {
  autoCheck: boolean;
  setAutoCheck: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<
    "idle" | "checking" | "uptodate" | "available" | "downloading" | "error"
  >("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState("");

  const doCheck = async () => {
    setPhase("checking");
    setErr("");
    try {
      const u = await checkUpdate();
      if (!u) {
        setPhase("uptodate");
        return;
      }
      setUpdate(u);
      setPhase("available");
    } catch (e) {
      setErr(errorMessage(e));
      setPhase("error");
    }
  };

  const doInstall = async () => {
    if (!update) return;
    setPhase("downloading");
    setPct(0);
    try {
      await installUpdate(update, setPct);
      // 安装成功后会 relaunch，一般走不到这里。
    } catch (e) {
      setErr(errorMessage(e));
      setPhase("error");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{t("settings.currentVersion")}</span>
        <span className="font-mono text-xs text-foreground">v{currentVersion}</span>
      </div>

      <label className="flex cursor-pointer select-none items-center gap-2 text-xs text-foreground">
        <Checkbox checked={autoCheck} onCheckedChange={(c) => setAutoCheck(c === true)} />
        {t("settings.autoCheck")}
      </label>

      <div className="rounded-md border border-border bg-muted/30 p-3">
        {phase === "available" && update ? (
          <div className="space-y-2">
            <div className="text-xs font-medium text-foreground">
              {t("settings.updateAvailable", { v: update.version })}
            </div>
            {update.body && (
              <pre className="max-h-28 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">
                {update.body}
              </pre>
            )}
            <Button onClick={doInstall}>{t("settings.install")}</Button>
            <p className="text-[11px] text-muted-foreground/70">{t("settings.restartHint")}</p>
          </div>
        ) : phase === "downloading" ? (
          <div className="space-y-2">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={pct == null ? "h-full w-1/3 animate-pulse bg-primary" : "h-full bg-primary transition-all"}
                style={pct == null ? undefined : { width: `${pct}%` }}
              />
            </div>
            <div className="text-[11px] text-muted-foreground">
              {t("settings.downloading", { p: pct ?? 0 })}
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={doCheck} disabled={phase === "checking"}>
              {phase === "checking" ? t("settings.checking") : t("settings.checkNow")}
            </Button>
            <span className="text-xs text-muted-foreground">
              {phase === "uptodate"
                ? t("settings.upToDate")
                : phase === "error"
                  ? err || t("settings.updateError")
                  : ""}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
