// 连接管理对话框（PRD §3.1）：新建 / 编辑 / 测试 / 保存连接。
// SQLite 仅需文件路径；MySQL/PG 含主机端口凭证与可选 SSH 隧道。

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ipc } from "@/ipc";
import type { ConnConfig, ConnConfigInput, DbKind, SslMode } from "@/ipc/types";
import { errorMessage } from "@/lib/error";

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

  const isSqlite = f.kind === "sqlite";
  const isPg = f.kind === "postgres";
  const set = (patch: Partial<FormState>) => setF((s) => ({ ...s, ...patch }));

  const pickKind = (kind: DbKind) => {
    setFeedback(null);
    set({ kind, ...KIND_DEFAULTS[kind] });
  };

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
      sqlite_path: isSqlite ? f.sqlitePath.trim() : null,
      ssh,
      ssh_password: ssh && f.sshAuth === "password" ? f.sshPassword : null,
      ssh_passphrase: ssh && f.sshAuth === "key" ? f.sshPassphrase || null : null,
    };
  };

  const onTest = async () => {
    const err = validate();
    if (err) {
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[460px] max-h-[88vh] overflow-auto rounded-xl border border-neutral-700 bg-neutral-850 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-neutral-700/70">
          <h2 className="text-sm font-semibold text-neutral-100">
            {initial ? t("conn.editTitle") : t("conn.newTitle")}
          </h2>
        </div>

        <div className="px-5 py-4 space-y-3">
          {/* 类型选择 */}
          <div className="flex gap-1.5">
            {KINDS.map((k) => (
              <button
                key={k}
                onClick={() => pickKind(k)}
                className={`flex-1 rounded-md px-3 py-1.5 text-xs font-medium capitalize transition ${
                  f.kind === k
                    ? "bg-emerald-600 text-white"
                    : "bg-neutral-800 text-neutral-300 hover:bg-neutral-750"
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

              {/* SSH 隧道 */}
              <label className="flex items-center gap-2 pt-1 text-xs text-neutral-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={f.sshEnabled}
                  onChange={(e) => set({ sshEnabled: e.target.checked })}
                  className="accent-emerald-600"
                />
                {t("conn.sshEnable")}
              </label>
              {f.sshEnabled && (
                <div className="space-y-3 rounded-lg border border-neutral-700/70 bg-neutral-900/50 p-3">
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
                  ? "bg-emerald-950/60 text-emerald-300 border border-emerald-800/60"
                  : "bg-red-950/60 text-red-300 border border-red-800/60"
              }`}
            >
              {feedback.msg}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 px-5 py-3 border-t border-neutral-700/70">
          <button
            onClick={onTest}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-xs font-medium bg-neutral-800 text-neutral-200 hover:bg-neutral-750 disabled:opacity-40"
          >
            {testing ? t("conn.testing") : t("conn.test")}
          </button>
          <div className="ml-auto flex gap-2">
            <button
              onClick={onClose}
              disabled={busy}
              className="rounded-md px-3 py-1.5 text-xs font-medium bg-neutral-800 text-neutral-300 hover:bg-neutral-750 disabled:opacity-40"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={onSave}
              disabled={busy}
              className="rounded-md px-4 py-1.5 text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40"
            >
              {saving ? t("conn.saving") : t("conn.save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- 小型受控原子组件 -----------------------------------------------------

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
    <label className={`block ${className ?? ""}`}>
      <span className="mb-1 block text-[11px] font-medium text-neutral-400">{label}</span>
      {children}
    </label>
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
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-emerald-500"
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
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-100 outline-none focus:border-emerald-500"
    >
      {options.map((o) => (
        <option key={o} value={o}>
          {labels?.[o] ?? o}
        </option>
      ))}
    </select>
  );
}

function SmallButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      type="button"
      className="shrink-0 rounded-md border border-neutral-700 bg-neutral-800 px-2.5 py-1.5 text-xs text-neutral-300 hover:bg-neutral-750"
    >
      {children}
    </button>
  );
}
