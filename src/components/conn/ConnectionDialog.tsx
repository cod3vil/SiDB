// 连接管理对话框（PRD §3.1）：新建 / 编辑 / 测试 / 保存连接。
// SQLite 仅需文件路径；MySQL/PG 含主机端口凭证与可选 SSH 隧道。

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ipc } from "@/ipc";
import type { ConnConfig, ConnConfigInput, DbKind, SslMode } from "@/ipc/types";
import { errorMessage } from "@/lib/error";
import { Button } from "@/components/ui/button";
import { Input as UiInput } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select as UiSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Props {
  /** 传入则为编辑模式；否则新建。 */
  initial?: ConnConfig | null;
  onClose: () => void;
  onSaved: (cfg: ConnConfig) => void;
}

interface FormState {
  name: string;
  kind: DbKind;
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  schema: string;
  sslMode: SslMode;
  sqlitePath: string;
  // 高级（秒，0=不限制）
  connectTimeout: string;
  keepalive: string;
  readTimeout: string;
  writeTimeout: string;
  sshEnabled: boolean;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshAuth: "password" | "key";
  sshKeyPath: string;
  sshPassword: string;
  sshPassphrase: string;
}

const KIND_DEFAULTS: Record<DbKind, Partial<FormState>> = {
  mysql: { port: "3306", user: "root", sslMode: "prefer" },
  postgres: { port: "5432", user: "postgres", schema: "public", sslMode: "prefer" },
  sqlite: {},
};

function initState(initial?: ConnConfig | null): FormState {
  const base: FormState = {
    name: "",
    kind: "mysql",
    host: "127.0.0.1",
    port: "3306",
    user: "root",
    password: "",
    database: "",
    schema: "",
    sslMode: "prefer",
    sqlitePath: "",
    connectTimeout: "10",
    keepalive: "0",
    readTimeout: "0",
    writeTimeout: "0",
    sshEnabled: false,
    sshHost: "",
    sshPort: "22",
    sshUser: "",
    sshAuth: "password",
    sshKeyPath: "",
    sshPassword: "",
    sshPassphrase: "",
  };
  if (!initial) return base;
  return {
    ...base,
    name: initial.name,
    kind: initial.kind,
    host: initial.host ?? base.host,
    port: initial.port?.toString() ?? base.port,
    user: initial.user ?? base.user,
    database: initial.database ?? "",
    schema: initial.schema ?? "",
    sslMode: initial.ssl_mode ?? "prefer",
    sqlitePath: initial.sqlite_path ?? "",
    connectTimeout: initial.connect_timeout_secs?.toString() ?? "10",
    keepalive: initial.keepalive_secs?.toString() ?? "0",
    readTimeout: initial.read_timeout_secs?.toString() ?? "0",
    writeTimeout: initial.write_timeout_secs?.toString() ?? "0",
    sshEnabled: Boolean(initial.ssh),
    sshHost: initial.ssh?.host ?? "",
    sshPort: initial.ssh?.port?.toString() ?? "22",
    sshUser: initial.ssh?.user ?? "",
    sshAuth: initial.ssh?.auth ?? "password",
    sshKeyPath: initial.ssh?.key_path ?? "",
  };
}

const KINDS: DbKind[] = ["mysql", "postgres", "sqlite"];

export function ConnectionDialog({ initial, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const [f, setF] = useState<FormState>(() => initState(initial));
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [tab, setTab] = useState<"general" | "advanced" | "ssh">("general");

  const isSqlite = f.kind === "sqlite";
  const isPg = f.kind === "postgres";
  const set = (patch: Partial<FormState>) => setF((s) => ({ ...s, ...patch }));

  const pickKind = (kind: DbKind) => {
    setFeedback(null);
    if (kind === "sqlite" && tab === "ssh") setTab("general");
    set({ kind, ...KIND_DEFAULTS[kind] });
  };

  const tabs: { key: "general" | "advanced" | "ssh"; label: string }[] = [
    { key: "general", label: t("conn.tabGeneral") },
    { key: "advanced", label: t("conn.tabAdvanced") },
    ...(isSqlite ? [] : [{ key: "ssh" as const, label: t("conn.tabSsh") }]),
  ];

  const validate = (): string | null => {
    if (!f.name.trim()) return t("conn.nameRequired");
    if (isSqlite) {
      if (!f.sqlitePath.trim()) return t("conn.pathRequired");
    } else if (!f.host.trim()) {
      return t("conn.hostRequired");
    }
    return null;
  };

  const buildInput = (): ConnConfigInput => {
    const port = f.port.trim() ? Number(f.port) : null;
    const ssh =
      !isSqlite && f.sshEnabled
        ? {
            host: f.sshHost,
            port: Number(f.sshPort) || 22,
            user: f.sshUser,
            auth: f.sshAuth,
            key_path: f.sshAuth === "key" ? f.sshKeyPath || null : null,
          }
        : null;
    return {
      id: initial?.id,
      name: f.name.trim(),
      kind: f.kind,
      host: isSqlite ? null : f.host.trim(),
      port: isSqlite ? null : port,
      user: isSqlite ? null : f.user.trim() || null,
      password: isSqlite || !f.password ? null : f.password,
      database: f.database.trim() || null,
      schema: isPg ? f.schema.trim() || null : null,
      ssl_mode: isSqlite ? null : f.sslMode,
      connect_timeout_secs: f.connectTimeout.trim() ? Number(f.connectTimeout) : 10,
      keepalive_secs: Number(f.keepalive) || 0,
      read_timeout_secs: Number(f.readTimeout) || 0,
      write_timeout_secs: Number(f.writeTimeout) || 0,
      sqlite_path: isSqlite ? f.sqlitePath.trim() : null,
      ssh,
      ssh_password: ssh && f.sshAuth === "password" ? f.sshPassword : null,
      ssh_passphrase: ssh && f.sshAuth === "key" ? f.sshPassphrase || null : null,
    };
  };

  const onTest = async () => {
    const err = validate();
    if (err) {
      setTab("general");
      setFeedback({ ok: false, msg: err });
      return;
    }
    setTesting(true);
    setFeedback(null);
    try {
      await ipc.testConnection(buildInput());
      setFeedback({ ok: true, msg: t("conn.testOk") });
    } catch (e) {
      setFeedback({ ok: false, msg: errorMessage(e) });
    } finally {
      setTesting(false);
    }
  };

  const onSave = async () => {
    const err = validate();
    if (err) {
      setTab("general");
      setFeedback({ ok: false, msg: err });
      return;
    }
    setSaving(true);
    setFeedback(null);
    try {
      const cfg = await ipc.saveConnection(buildInput());
      onSaved(cfg);
    } catch (e) {
      setFeedback({ ok: false, msg: errorMessage(e) });
      setSaving(false);
    }
  };

  const browseSqlite = async () => {
    const picked = await openDialog({
      filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3", "db3"] }],
    });
    if (typeof picked === "string") set({ sqlitePath: picked });
  };

  const createSqlite = async () => {
    const picked = await saveDialog({
      filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] }],
    });
    if (typeof picked === "string") set({ sqlitePath: picked });
  };

  const browseKey = async () => {
    const picked = await openDialog({});
    if (typeof picked === "string") set({ sshKeyPath: picked });
  };

  const busy = testing || saving;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        className="flex h-[560px] max-h-[90vh] w-[460px] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 px-5 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">
            {initial ? t("conn.editTitle") : t("conn.newTitle")}
          </h2>
        </div>

        {/* Tab 栏 */}
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="shrink-0">
          <TabsList className="px-4 pt-2">
            {tabs.map((tb) => (
              <TabsTrigger key={tb.key} value={tb.key}>
                {tb.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-3">
          {/* 常规 */}
          {tab === "general" && (
            <>
              <div className="flex gap-1.5">
                {KINDS.map((k) => (
                  <button
                    key={k}
                    onClick={() => pickKind(k)}
                    className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium capitalize transition ${
                      f.kind === k
                        ? "bg-primary text-primary-foreground"
                        : "bg-secondary text-secondary-foreground hover:bg-accent"
                    }`}
                  >
                    {k}
                  </button>
                ))}
              </div>

              <Field label={t("conn.name")}>
                <Input value={f.name} onChange={(v) => set({ name: v })} placeholder="My Database" autoFocus />
              </Field>

              {isSqlite ? (
                <Field label={t("conn.sqlitePath")}>
                  <div className="flex gap-1.5">
                    <Input value={f.sqlitePath} onChange={(v) => set({ sqlitePath: v })} placeholder="/path/to/db.sqlite" />
                    <SmallButton onClick={browseSqlite}>{t("conn.browse")}</SmallButton>
                    <SmallButton onClick={createSqlite}>{t("conn.createFile")}</SmallButton>
                  </div>
                </Field>
              ) : (
                <>
                  <div className="flex gap-2">
                    <Field label={t("conn.host")} className="flex-1">
                      <Input value={f.host} onChange={(v) => set({ host: v })} />
                    </Field>
                    <Field label={t("conn.port")} className="w-24">
                      <Input value={f.port} onChange={(v) => set({ port: v })} />
                    </Field>
                  </div>
                  <div className="flex gap-2">
                    <Field label={t("conn.user")} className="flex-1">
                      <Input value={f.user} onChange={(v) => set({ user: v })} />
                    </Field>
                    <Field
                      label={`${t("conn.password")}${initial?.has_password ? t("conn.passwordKeep") : ""}`}
                      className="flex-1"
                    >
                      <Input type="password" value={f.password} onChange={(v) => set({ password: v })} />
                    </Field>
                  </div>
                  <div className="flex gap-2">
                    <Field label={t("conn.database")} className="flex-1">
                      <Input
                        value={f.database}
                        onChange={(v) => set({ database: v })}
                        placeholder={t("conn.databaseOptional")}
                      />
                    </Field>
                    {isPg && (
                      <Field label={t("conn.schema")} className="flex-1">
                        <Input value={f.schema} onChange={(v) => set({ schema: v })} />
                      </Field>
                    )}
                  </div>
                  <Field label={t("conn.sslMode")}>
                    <Select
                      value={f.sslMode}
                      onChange={(v) => set({ sslMode: v as SslMode })}
                      options={["disable", "prefer", "require"]}
                    />
                  </Field>
                </>
              )}
            </>
          )}

          {/* 高级 */}
          {tab === "advanced" && (
            <>
              <div className="flex gap-2">
                <Field label={t("conn.connectTimeout")} className="flex-1">
                  <Input value={f.connectTimeout} onChange={(v) => set({ connectTimeout: v })} />
                </Field>
                <Field label={t("conn.keepalive")} className="flex-1">
                  <Input value={f.keepalive} onChange={(v) => set({ keepalive: v })} />
                </Field>
              </div>
              <div className="flex gap-2">
                <Field label={t("conn.readTimeout")} className="flex-1">
                  <Input value={f.readTimeout} onChange={(v) => set({ readTimeout: v })} />
                </Field>
                <Field label={t("conn.writeTimeout")} className="flex-1">
                  <Input value={f.writeTimeout} onChange={(v) => set({ writeTimeout: v })} />
                </Field>
              </div>
              <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <i className="ri-information-line" />
                {t("conn.unlimitedHint")}
              </p>
            </>
          )}

          {/* SSH */}
          {tab === "ssh" && !isSqlite && (
            <>
              <label className="flex items-center gap-2 text-xs text-foreground cursor-pointer select-none">
                <Checkbox
                  checked={f.sshEnabled}
                  onCheckedChange={(c) => set({ sshEnabled: c === true })}
                />
                {t("conn.sshEnable")}
              </label>
              {f.sshEnabled && (
                <div className="space-y-3 rounded-lg border border-border bg-background/50 p-3">
                  <div className="flex gap-2">
                    <Field label={t("conn.sshHost")} className="flex-1">
                      <Input value={f.sshHost} onChange={(v) => set({ sshHost: v })} />
                    </Field>
                    <Field label={t("conn.sshPort")} className="w-20">
                      <Input value={f.sshPort} onChange={(v) => set({ sshPort: v })} />
                    </Field>
                  </div>
                  <Field label={t("conn.sshUser")}>
                    <Input value={f.sshUser} onChange={(v) => set({ sshUser: v })} />
                  </Field>
                  <Field label={t("conn.sshAuth")}>
                    <Select
                      value={f.sshAuth}
                      onChange={(v) => set({ sshAuth: v as "password" | "key" })}
                      options={["password", "key"]}
                      labels={{ password: t("conn.sshAuthPassword"), key: t("conn.sshAuthKey") }}
                    />
                  </Field>
                  {f.sshAuth === "password" ? (
                    <Field label={t("conn.sshAuthPassword")}>
                      <Input type="password" value={f.sshPassword} onChange={(v) => set({ sshPassword: v })} />
                    </Field>
                  ) : (
                    <>
                      <Field label={t("conn.sshKeyPath")}>
                        <div className="flex gap-1.5">
                          <Input value={f.sshKeyPath} onChange={(v) => set({ sshKeyPath: v })} />
                          <SmallButton onClick={browseKey}>{t("conn.browse")}</SmallButton>
                        </div>
                      </Field>
                      <Field label={t("conn.sshPassphrase")}>
                        <Input type="password" value={f.sshPassphrase} onChange={(v) => set({ sshPassphrase: v })} />
                      </Field>
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {feedback && (
            <div
              className={`rounded-md px-3 py-2 text-xs ${
                feedback.ok
                  ? "border border-emerald-600/40 bg-emerald-600/10 text-emerald-600 dark:text-emerald-400"
                  : "border border-destructive/40 bg-destructive/10 text-destructive"
              }`}
            >
              {feedback.msg}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2 px-5 py-3 border-t border-border">
          <Button variant="secondary" onClick={onTest} disabled={busy}>
            {testing ? t("conn.testing") : t("conn.test")}
          </Button>
          <div className="ml-auto flex gap-2">
            <Button variant="secondary" onClick={onClose} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button onClick={onSave} disabled={busy}>
              {saving ? t("conn.saving") : t("conn.save")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- 受控原子组件（基于 shadcn，保持紧凑） ------------------------------

function Field({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`space-y-1 ${className ?? ""}`}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function Input({
  value,
  onChange,
  type = "text",
  placeholder,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return (
    <UiInput
      type={type}
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function Select({
  value,
  onChange,
  options,
  labels,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  labels?: Record<string, string>;
}) {
  return (
    <UiSelect value={value} onValueChange={onChange}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {labels?.[o] ?? o}
          </SelectItem>
        ))}
      </SelectContent>
    </UiSelect>
  );
}

function SmallButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <Button type="button" variant="outline" size="sm" onClick={onClick}>
      {children}
    </Button>
  );
}
