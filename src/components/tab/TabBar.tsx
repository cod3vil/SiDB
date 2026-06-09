// 查询标签栏：切换 / 新建 / 关闭（含右键菜单）。

import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

export interface TabMeta {
  id: string;
  title: string;
}

interface Props {
  tabs: TabMeta[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onNew: () => void;
}

export function TabBar({ tabs, activeId, onSelect, onClose, onCloseOthers, onNew }: Props) {
  const { t } = useTranslation();
  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-border bg-card/40">
      {tabs.map((tab) => (
        <ContextMenu key={tab.id}>
          <ContextMenuTrigger asChild>
            <div
              onClick={() => onSelect(tab.id)}
              onAuxClick={(e) => {
                if (e.button === 1) onClose(tab.id); // 中键关闭
              }}
              className={cn(
                "group flex shrink-0 items-center gap-1.5 border-r border-border px-3 text-xs cursor-pointer",
                tab.id === activeId
                  ? "bg-background text-foreground"
                  : "text-muted-foreground hover:bg-accent",
              )}
            >
              <i className="ri-terminal-box-line text-sm opacity-60" />
              <span className="max-w-[140px] truncate">{tab.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                className="ml-0.5 flex h-4 w-4 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100"
                title={t("tab.close")}
              >
                <i className="ri-close-line text-xs" />
              </button>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem icon="ri-close-line" onClick={() => onClose(tab.id)}>
              {t("tab.close")}
            </ContextMenuItem>
            <ContextMenuItem
              icon="ri-close-circle-line"
              disabled={tabs.length <= 1}
              onClick={() => onCloseOthers(tab.id)}
            >
              {t("tab.closeOthers")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      ))}
      <button
        onClick={onNew}
        title={t("tab.new")}
        className="flex w-9 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <i className="ri-add-line" />
      </button>
    </div>
  );
}
