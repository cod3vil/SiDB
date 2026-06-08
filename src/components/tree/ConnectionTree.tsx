// 对象浏览器（TDD §9 / PRD §3.2）：懒加载树 + 过滤。

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc";
import type { ConnConfig, TableInfo, TableRef } from "@/ipc/types";
import { useConnections } from "@/stores";

interface Props {
  onOpenTable: (connId: string, table: TableRef) => void;
}

export function ConnectionTree({ onOpenTable }: Props) {
  const { t } = useTranslation();
  const { configs, connected, setConfigs, setConnected } = useConnections();
  const [filter, setFilter] = useState("");

  useEffect(() => {
    ipc.listConnections().then(setConfigs).catch(() => undefined);
  }, [setConfigs]);

  const onConnect = async (cfg: ConnConfig) => {
    const caps = await ipc.connect(cfg.id);
    setConnected(cfg.id, caps);
  };

  return (
    <div className="flex flex-col h-full text-sm">
      <input
        className="m-2 px-2 py-1 text-xs bg-neutral-800 border border-neutral-700 rounded"
        placeholder={t("tree.filter")}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <div className="flex-1 overflow-auto px-1">
        {configs
          .filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()))
          .map((cfg) => (
            <ConnNode
              key={cfg.id}
              cfg={cfg}
              isConnected={Boolean(connected[cfg.id])}
              onConnect={() => onConnect(cfg)}
              onOpenTable={onOpenTable}
            />
          ))}
      </div>
    </div>
  );
}

function ConnNode({
  cfg,
  isConnected,
  onConnect,
  onOpenTable,
}: {
  cfg: ConnConfig;
  isConnected: boolean;
  onConnect: () => void;
  onOpenTable: (connId: string, table: TableRef) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [tables, setTables] = useState<TableInfo[] | null>(null);

  const toggle = async () => {
    if (!isConnected) {
      await onConnect();
    }
    const next = !expanded;
    setExpanded(next);
    if (next && tables === null) {
      // SQLite 直接列表；MySQL/PG 需先选库，这里默认用配置库（简化）。
      const db = cfg.database ?? (cfg.kind === "sqlite" ? "main" : "");
      const list = await ipc.listTables(cfg.id, db, cfg.schema);
      setTables(list);
    }
  };

  return (
    <div>
      <div
        className="flex items-center gap-1 px-1 py-0.5 cursor-pointer hover:bg-neutral-800 rounded"
        onClick={toggle}
      >
        <span className="text-xs">{expanded ? "▼" : "▶"}</span>
        <span className={isConnected ? "text-emerald-400" : "text-neutral-300"}>●</span>
        <span className="truncate">{cfg.name}</span>
        <span className="text-[10px] text-neutral-500 ml-auto uppercase">{cfg.kind}</span>
      </div>
      {expanded && tables && (
        <div className="ml-5">
          {tables.map((tb) => (
            <div
              key={tb.name}
              className="px-1 py-0.5 cursor-pointer hover:bg-neutral-800 rounded truncate"
              onDoubleClick={() =>
                onOpenTable(cfg.id, {
                  database: cfg.database,
                  schema: cfg.schema,
                  name: tb.name,
                })
              }
              title={tb.name}
            >
              {tb.kind === "view" ? "👁 " : "▦ "}
              {tb.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
