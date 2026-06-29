// 顶部工具栏（PRD §3.3）：连接 / 数据库 / schema / 表 选择器 + 执行 / 停止。
// 控件基于 shadcn（Radix Select / Button），图标 remixicon。

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

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
  activeTable: string | null;
  onSelectTable: (name: string) => void;

  running: boolean;
  canRun: boolean;
  onRun: () => void;
  onCancel: () => void;
  canSave: boolean;
  onSave: () => void;
}

export function TopBar(p: Props) {
  const { t } = useTranslation();
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-card/60 px-2">
      <Picker
        icon="ri-server-line"
        value={p.activeConn ?? undefined}
        onChange={p.onSelectConn}
        placeholder={t("toolbar.selectConn")}
        options={p.connections}
      />
      {p.databases && p.databases.length > 0 && (
        <Picker
          icon="ri-database-2-line"
          value={p.activeDb ?? undefined}
          onChange={p.onSelectDb}
          placeholder={t("toolbar.database")}
          options={p.databases.map((d) => ({ value: d, label: d }))}
        />
      )}
      {p.schemas && p.schemas.length > 0 && (
        <Picker
          icon="ri-stack-line"
          value={p.activeSchema ?? undefined}
          onChange={p.onSelectSchema}
          placeholder={t("toolbar.schema")}
          options={p.schemas.map((s) => ({ value: s, label: s }))}
        />
      )}

      <div className="ml-auto flex items-center gap-1">
        <Button
          size="icon"
          variant="secondary"
          onClick={p.onSave}
          disabled={!p.canSave}
          title={`${t("editor.save")} (⌘/Ctrl+S)`}
        >
          <i className="ri-save-line text-base" />
        </Button>
        <Button size="icon" onClick={p.onRun} disabled={!p.canRun || p.running} title={t("toolbar.run")}>
          <i className="ri-play-fill text-base" />
        </Button>
        <Button
          size="icon"
          variant="secondary"
          onClick={p.onCancel}
          disabled={!p.running}
          title={t("toolbar.cancel")}
        >
          <i className="ri-pause-line text-base" />
        </Button>
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
  value: string | undefined;
  onChange: (v: string) => void;
  placeholder: string;
  options: Option[];
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger icon={icon} className="h-7 w-auto min-w-[8.5rem] max-w-[12rem]">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
