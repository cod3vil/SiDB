// 设置：分页签 —— 通用 / AI / 更新。
// AI Key 经后端存入系统钥匙串，前端只存 key_configured 标记。

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc";
import type { Settings, McpStatus } from "@/ipc/types";
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
import { save as saveFileDialog, open as openFileDialog } from "@tauri-apps/plugin-dialog";

interface Props {
  onClose: () => void;
}

const PROVIDERS = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "custom", label: "OpenAI Compatible" },
];

type Tab = "general" | "ai" | "mcp" | "update" | "backup";

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
  const [maxIters, setMaxIters] = useState("20");
  const [maxTokens, setMaxTokens] = useState("4096");
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
        setMaxIters(String(s.ai.max_iters ?? 20));
        setMaxTokens(String(s.ai.max_tokens ?? 4096));
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
          max_iters: Math.min(50, Math.max(1, parseInt(maxIters || "0", 10) || 20)),
          max_tokens: Math.min(1000000, Math.max(256, parseInt(maxTokens || "0", 10) || 4096)),
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
    { key: "mcp", label: t("settings.mcp") },
    { key: "update", label: t("settings.tabUpdate") },
    { key: "backup", label: t("settings.tabBackup") },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="flex h-[580px] w-[480px] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
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
              <div className="grid grid-cols-2 gap-3 border-t border-border pt-3">
                <div className="space-y-1">
                  <Label>{t("settings.maxIters")}</Label>
                  <Input
                    value={maxIters}
                    onChange={(e) => setMaxIters(e.target.value.replace(/[^0-9]/g, ""))}
                    placeholder="20"
                  />
                  <p className="text-[11px] text-muted-foreground/70">{t("settings.maxItersHint")}</p>
                </div>
                <div className="space-y-1">
                  <Label>{t("settings.maxTokens")}</Label>
                  <Input
                    value={maxTokens}
                    onChange={(e) => setMaxTokens(e.target.value.replace(/[^0-9]/g, ""))}
                    placeholder="4096"
                  />
                  <p className="text-[11px] text-muted-foreground/70">{t("settings.maxTokensHint")}</p>
                </div>
              </div>
            </div>
          )}

          {tab === "mcp" && <McpTab onSyncSettings={(mcp) => setSettings((s) => (s ? { ...s, mcp } : s))} />}

          {tab === "update" && <UpdateTab autoCheck={autoCheck} setAutoCheck={setAutoCheck} />}

          {tab === "backup" && <BackupTab />}
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

/** MCP 本地服务：开关 / 端口 / 令牌 / 外部工具配置片段。 */
function McpTab({ onSyncSettings }: { onSyncSettings: (mcp: { enabled: boolean; port: number }) => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<McpStatus | null>(null);
  const [port, setPort] = useState("6544");
  const [busy, setBusy] = useState(false);
  const [showToken, setShowToken] = useState(false);

  useEffect(() => {
    ipc
      .mcpStatus()
      .then((s) => {
        setStatus(s);
        setPort(String(s.configured_port));
      })
      .catch((e) => toast.error(errorMessage(e)));
  }, []);

  const apply = async (enabled: boolean) => {
    const p = Math.min(65535, Math.max(0, parseInt(port || "0", 10) || 6544));
    setBusy(true);
    try {
      const s = await ipc.mcpSetEnabled(enabled, p);
      setStatus(s);
      setPort(String(s.configured_port));
      onSyncSettings({ enabled: s.enabled, port: s.configured_port });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const rotate = async () => {
    setBusy(true);
    try {
      const tk = await ipc.mcpRotateToken();
      setStatus((s) => (s ? { ...s, token: tk } : s));
      toast.success(t("settings.mcpTokenRotated"));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const copy = (s: string) => {
    void navigator.clipboard?.writeText(s).catch(() => undefined);
    toast.success(t("settings.mcpCopied"));
  };

  if (!status) return <div className="text-sm text-muted-foreground">…</div>;

  const effPort = status.running ? status.port : status.configured_port;
  const url = `http://127.0.0.1:${effPort}/mcp`;
  const token = status.token;
  const maskedToken = showToken ? token : `${token.slice(0, 6)}${"•".repeat(20)}`;
  const claudeCmd = `claude mcp add --transport http sidb ${url} --header "Authorization: Bearer ${token}"`;
  const jsonSnippet = JSON.stringify(
    { mcpServers: { sidb: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground/80">{t("settings.mcpIntro")}</p>

      <div className="flex items-center gap-2">
        <Checkbox
          checked={status.enabled}
          disabled={busy}
          onCheckedChange={(v) => void apply(Boolean(v))}
          id="mcp-enabled"
        />
        <Label htmlFor="mcp-enabled" className="cursor-pointer">
          {t("settings.mcpEnable")}
        </Label>
        <span
          className={cn(
            "ml-auto rounded px-1.5 py-0.5 text-[11px]",
            status.running ? "bg-emerald-500/15 text-emerald-500" : "bg-muted text-muted-foreground",
          )}
        >
          {status.running ? t("settings.mcpRunning", { port: status.port }) : t("settings.mcpStopped")}
        </span>
      </div>

      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1">
          <Label>{t("settings.mcpPort")}</Label>
          <Input value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))} placeholder="6544" />
        </div>
        {status.enabled && (
          <Button variant="outline" onClick={() => void apply(true)} disabled={busy}>
            {t("settings.mcpRestart")}
          </Button>
        )}
      </div>

      <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-600 dark:text-amber-400">
        {t("settings.mcpWarn")}
      </p>

      {/* 令牌 */}
      <div className="space-y-1">
        <Label>{t("settings.mcpToken")}</Label>
        <div className="flex items-center gap-1.5">
          <code className="flex-1 truncate rounded-md border border-border bg-muted/50 px-2 py-1.5 font-mono text-[11px]">
            {maskedToken}
          </code>
          <Button variant="ghost" size="icon" onClick={() => setShowToken((v) => !v)} title={t("settings.mcpReveal")}>
            <i className={showToken ? "ri-eye-off-line" : "ri-eye-line"} />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => copy(token)} title={t("settings.mcpCopy")}>
            <i className="ri-file-copy-line" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => void rotate()} disabled={busy} title={t("settings.mcpRotate")}>
            <i className="ri-refresh-line" />
          </Button>
        </div>
      </div>

      {/* 配置片段 */}
      <div className="space-y-2 border-t border-border pt-3">
        <p className="text-xs font-medium text-foreground">{t("settings.mcpConfigTitle")}</p>

        <SnippetBlock label="Endpoint" value={url} onCopy={() => copy(url)} copyLabel={t("settings.mcpCopy")} />
        <SnippetBlock label="Claude Code" value={claudeCmd} onCopy={() => copy(claudeCmd)} copyLabel={t("settings.mcpCopy")} />
        <SnippetBlock label={t("settings.mcpJsonLabel")} value={jsonSnippet} onCopy={() => copy(jsonSnippet)} copyLabel={t("settings.mcpCopy")} pre />
        <p className="text-[11px] text-muted-foreground/70">{t("settings.mcpOtherHint")}</p>
      </div>
    </div>
  );
}

function SnippetBlock({
  label,
  value,
  onCopy,
  copyLabel,
  pre,
}: {
  label: string;
  value: string;
  onCopy: () => void;
  copyLabel: string;
  pre?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <button className="text-[11px] text-primary hover:underline" onClick={onCopy}>
          {copyLabel}
        </button>
      </div>
      <div
        className={cn(
          "rounded-md border border-border bg-muted/50 px-2 py-1.5 font-mono text-[11px] text-foreground/90",
          pre ? "whitespace-pre-wrap" : "truncate",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function BackupTab() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  const doExport = async () => {
    const path = await saveFileDialog({
      defaultPath: "sidb.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (typeof path !== "string") return;
    setBusy(true);
    try {
      const n = await ipc.exportConfig(path);
      toast.success(t("settings.exported", { n }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    const path = await openFileDialog({ filters: [{ name: "JSON", extensions: ["json"] }] });
    if (typeof path !== "string") return;
    setBusy(true);
    try {
      const n = await ipc.importConfig(path);
      toast.success(t("settings.imported", { n }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label>{t("settings.exportTitle")}</Label>
        <p className="text-[11px] text-muted-foreground/80">{t("settings.exportHint")}</p>
        <Button variant="outline" onClick={doExport} disabled={busy}>
          <i className="ri-download-2-line" />
          {t("settings.exportBtn")}
        </Button>
      </div>
      <div className="space-y-1.5 border-t border-border pt-4">
        <Label>{t("settings.importTitle")}</Label>
        <p className="text-[11px] text-muted-foreground/80">{t("settings.importHint")}</p>
        <Button variant="outline" onClick={doImport} disabled={busy}>
          <i className="ri-upload-2-line" />
          {t("settings.importBtn")}
        </Button>
      </div>
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-600 dark:text-amber-400">
        <i className="ri-alert-line mr-1" />
        {t("settings.backupWarn")}
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
