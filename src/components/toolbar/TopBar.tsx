// 顶部工具栏（PRD §3.3）：连接 / 数据库 / schema / 表 选择器 + 执行 / 停止。
// 图标使用 remixicon。

import { useTranslation } from "react-i18next";

interface Option {
  value: string;
  label: string;
}

interface Props {
  connections: Option[];
  activeConn: string | null;
  onSelectConn: (id: string) => void;

  databases?: string[];
  activeDb: string | null;
  onSelectDb: (db: string) => void;

  schemas?: string[];
  activeSchema: string | null;
  onSelectSchema: (s: string) => void;

  tables: string[];
  onSelectTable: (name: string) => void;

  running: boolean;
  canRun: boolean;
  onRun: () => void;
  onCancel: () => void;
}

export function TopBar(p: Props) {
  const { t } = useTranslation();
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-neutral-800 bg-neutral-950/60 px-2">
      <Picker
        icon="ri-server-line"
        value={p.activeConn ?? ""}
        onChange={p.onSelectConn}
        placeholder={t("toolbar.selectConn")}
        options={p.connections}
      />
      {p.databases && p.databases.length > 0 && (
        <Picker
          icon="ri-database-2-line"
          value={p.activeDb ?? ""}
          onChange={p.onSelectDb}
          placeholder={t("toolbar.database")}
          options={p.databases.map((d) => ({ value: d, label: d }))}
        />
      )}
      {p.schemas && p.schemas.length > 0 && (
        <Picker
          icon="ri-stack-line"
          value={p.activeSchema ?? ""}
          onChange={p.onSelectSchema}
          placeholder={t("toolbar.schema")}
          options={p.schemas.map((s) => ({ value: s, label: s }))}
        />
      )}
      <Picker
        icon="ri-table-line"
        value=""
        onChange={p.onSelectTable}
        placeholder={t("toolbar.selectTable")}
        options={p.tables.map((n) => ({ value: n, label: n }))}
        disabled={p.tables.length === 0}
      />

      <div className="ml-auto flex items-center gap-1">
        <button
          onClick={p.onRun}
          disabled={!p.canRun || p.running}
          title={t("toolbar.run")}
          className="flex h-7 w-7 items-center justify-center rounded-md bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          <i className="ri-play-fill text-lg" />
        </button>
        <button
          onClick={p.onCancel}
          disabled={!p.running}
          title={t("toolbar.cancel")}
          className="flex h-7 w-7 items-center justify-center rounded-md bg-neutral-800 text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
        >
          <i className="ri-pause-line text-lg" />
        </button>
      </div>
    </div>
  );
}

function Picker({
  icon,
  value,
  onChange,
  placeholder,
  options,
  disabled,
}: {
  icon: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  options: Option[];
  disabled?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-800 px-2 ${
        disabled ? "opacity-50" : ""
      }`}
    >
      <i className={`${icon} text-sm text-neutral-500`} />
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="max-w-[160px] bg-transparent py-1.5 text-xs text-neutral-100 outline-none [&>option]:bg-neutral-800"
      >
        <option value="" disabled>
          {placeholder}
        </option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
