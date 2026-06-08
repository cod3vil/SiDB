// 对象浏览器（TDD §9 / PRD §3.2）：连接管理 + 能力驱动的懒加载树 + 过滤。
//
// 层级由 DbCapabilities 决定（不出现 if mysql/pg/sqlite 硬编码）：
//   - supports_schemas（PG）：连接 → schema → 表（当前连接库内）
//   - supports_multi_database（MySQL）：连接 → 数据库 → 表
//   - 其余（SQLite）：连接 → 表

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { confirm } from "@tauri-apps/plugin-dialog";
import { ipc } from "@/ipc";
import type { ConnConfig, DbCapabilities, TableInfo, TableRef } from "@/ipc/types";
import { useConnections } from "@/stores";
import { errorMessage } from "@/lib/error";

interface Props {
  onOpenTable: (connId: string, table: TableRef) => void;
  onNewConnection: () => void;
  onEditConnection: (cfg: ConnConfig) => void;
}

export function ConnectionTree({ onOpenTable, onNewConnection, onEditConnection }: Props) {
  const { t } = useTranslation();
  const { configs, connected, setConfigs, setConnected, setDisconnected } = useConnections();
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    ipc.listConnections().then(setConfigs).catch(() => undefined);
  }, [setConfigs]);

  useEffect(() => {
    reload();
  }, [reload]);

  const onConnect = async (cfg: ConnConfig) => {
    setError(null);
    try {
      const caps = await ipc.connect(cfg.id);
      setConnected(cfg.id, caps);
    } catch (e) {
      setError(errorMessage(e));
      throw e;
    }
  };

  const onDisconnect = async (cfg: ConnConfig) => {
    await ipc.disconnect(cfg.id).catch(() => undefined);
    setDisconnected(cfg.id);
  };

  const onDelete = async (cfg: ConnConfig) => {
    const ok = await confirm(t("conn.deleteConfirm", { name: cfg.name }), { kind: "warning" });
    if (!ok) return;
    await ipc.deleteConnection(cfg.id).catch((e) => setError(errorMessage(e)));
    setDisconnected(cfg.id);
    reload();
  };

  const filtered = configs.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="flex flex-col h-full text-sm">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-800">
        <span className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
          {t("conn.connect")}
        </span>
        <button
          onClick={onNewConnection}
          title={t("conn.new")}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-md bg-emerald-600 text-white hover:bg-emerald-500"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 2v10M2 7h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {configs.length > 0 && (
        <input
          className="m-2 rounded-md border border-neutral-700 bg-neutral-800 px-2.5 py-1.5 text-xs text-neutral-100 placeholder:text-neutral-600 outline-none focus:border-emerald-500"
          placeholder={t("tree.filter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}

      {error && (
        <div className="mx-2 mb-1 rounded-md border border-red-800/60 bg-red-950/50 px-2.5 py-1.5 text-[11px] text-red-300">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto px-1.5 pb-2">
        {configs.length === 0 ? (
          <EmptyState onNew={onNewConnection} />
        ) : (
          filtered.map((cfg) => (
            <ConnNode
              key={cfg.id}
              cfg={cfg}
              caps={connected[cfg.id] ?? null}
              onConnect={() => onConnect(cfg)}
              onDisconnect={() => onDisconnect(cfg)}
              onEdit={() => onEditConnection(cfg)}
              onDelete={() => onDelete(cfg)}
              onOpenTable={onOpenTable}
            />
          ))
        )}
      </div>
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-neutral-800 text-neutral-500">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
          <ellipse cx="12" cy="6" rx="7" ry="3" stroke="currentColor" strokeWidth="1.5" />
          <path d="M5 6v6c0 1.66 3.13 3 7 3s7-1.34 7-3V6M5 12v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </div>
      <div className="text-sm font-medium text-neutral-300">{t("tree.empty")}</div>
      <div className="text-xs text-neutral-500">{t("tree.emptyHint")}</div>
      <button
        onClick={onNew}
        className="mt-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
      >
        + {t("conn.new")}
      </button>
    </div>
  );
}

// ---- 行外观 ---------------------------------------------------------------

function Row({
  depth,
  expanded,
  hasChevron,
  icon,
  label,
  dim,
  trailing,
  actions,
  onClick,
  onDoubleClick,
  title,
}: {
  depth: number;
  expanded?: boolean;
  hasChevron?: boolean;
  icon: React.ReactNode;
  label: string;
  dim?: string;
  trailing?: React.ReactNode;
  actions?: React.ReactNode;
  onClick?: () => void;
  onDoubleClick?: () => void;
  title?: string;
}) {
  return (
    <div
      className="group flex items-center gap-1.5 rounded-md py-1 pr-1.5 cursor-pointer hover:bg-neutral-800"
      style={{ paddingLeft: 6 + depth * 12 }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={title}
    >
      <span className="w-3 shrink-0 text-[10px] text-neutral-500">
        {hasChevron ? (expanded ? "▼" : "▶") : ""}
      </span>
      <span className="shrink-0 text-neutral-500">{icon}</span>
      <span className="truncate flex-1 text-neutral-200">{label}</span>
      {actions}
      {dim && <span className="text-[10px] uppercase text-neutral-600 group-hover:hidden">{dim}</span>}
      {trailing}
    </div>
  );
}

function Loading({ depth }: { depth: number }) {
  const { t } = useTranslation();
  return (
    <div className="py-1 text-xs text-neutral-500" style={{ paddingLeft: 6 + depth * 12 + 18 }}>
      {t("tree.loading")}
    </div>
  );
}

function Empty({ depth }: { depth: number }) {
  const { t } = useTranslation();
  return (
    <div className="py-1 text-xs text-neutral-600" style={{ paddingLeft: 6 + depth * 12 + 18 }}>
      {t("grid.empty")}
    </div>
  );
}

// ---- 连接节点 -------------------------------------------------------------

function ConnNode({
  cfg,
  caps,
  onConnect,
  onDisconnect,
  onEdit,
  onDelete,
  onOpenTable,
}: {
  cfg: ConnConfig;
  caps: DbCapabilities | null;
  onConnect: () => Promise<void>;
  onDisconnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenTable: (connId: string, table: TableRef) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const toggle = async () => {
    if (!caps) {
      setConnecting(true);
      try {
        await onConnect();
      } catch {
        setConnecting(false);
        return;
      }
      setConnecting(false);
    }
    setExpanded((v) => !v);
  };

  return (
    <div>
      <Row
        depth={0}
        hasChevron
        expanded={expanded}
        icon={<span className={`block h-2 w-2 rounded-full ${caps ? "bg-emerald-400" : "bg-neutral-600"}`} />}
        label={cfg.name}
        dim={connecting ? undefined : cfg.kind}
        trailing={connecting ? <span className="text-[10px] text-neutral-500">{t("conn.connecting")}</span> : undefined}
        title={cfg.name}
        onClick={toggle}
        actions={
          <span className="hidden items-center gap-0.5 group-hover:flex">
            <IconBtn title={t("conn.edit")} onClick={onEdit}>✎</IconBtn>
            <IconBtn title={t("conn.delete")} onClick={onDelete}>🗑</IconBtn>
            {caps && <IconBtn title={t("conn.disconnect")} onClick={onDisconnect}>⏏</IconBtn>}
          </span>
        }
      />
      {expanded && caps && (
        <CapsChildren cfg={cfg} caps={caps} depth={1} onOpenTable={onOpenTable} />
      )}
    </div>
  );
}

function CapsChildren({
  cfg,
  caps,
  depth,
  onOpenTable,
}: {
  cfg: ConnConfig;
  caps: DbCapabilities;
  depth: number;
  onOpenTable: (connId: string, table: TableRef) => void;
}) {
  if (caps.supports_schemas) {
    // PG：列当前连接库的 schema。
    return <SchemaList cfg={cfg} depth={depth} onOpenTable={onOpenTable} />;
  }
  if (caps.supports_multi_database) {
    // MySQL：列有权限的数据库。
    return <DatabaseList cfg={cfg} depth={depth} onOpenTable={onOpenTable} />;
  }
  // SQLite：直接列表。
  return (
    <TableList
      connId={cfg.id}
      listDatabase="main"
      listSchema={null}
      refDatabase={null}
      refSchema={null}
      depth={depth}
      onOpenTable={onOpenTable}
    />
  );
}

// ---- 数据库层（MySQL）-----------------------------------------------------

function DatabaseList({
  cfg,
  depth,
  onOpenTable,
}: {
  cfg: ConnConfig;
  depth: number;
  onOpenTable: (connId: string, table: TableRef) => void;
}) {
  const [dbs, setDbs] = useState<string[] | null>(null);
  useEffect(() => {
    ipc
      .listDatabases(cfg.id)
      .then((list) => setDbs(list.map((d) => d.name)))
      .catch(() => setDbs([]));
  }, [cfg.id]);

  if (dbs === null) return <Loading depth={depth} />;
  if (dbs.length === 0) return <Empty depth={depth} />;
  return (
    <>
      {dbs.map((db) => (
        <DatabaseNode key={db} connId={cfg.id} db={db} depth={depth} onOpenTable={onOpenTable} />
      ))}
    </>
  );
}

function DatabaseNode({
  connId,
  db,
  depth,
  onOpenTable,
}: {
  connId: string;
  db: string;
  depth: number;
  onOpenTable: (connId: string, table: TableRef) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <Row
        depth={depth}
        hasChevron
        expanded={expanded}
        icon="🗄"
        label={db}
        title={db}
        onClick={() => setExpanded((v) => !v)}
      />
      {expanded && (
        <TableList
          connId={connId}
          listDatabase={db}
          listSchema={null}
          refDatabase={db}
          refSchema={null}
          depth={depth + 1}
          onOpenTable={onOpenTable}
        />
      )}
    </div>
  );
}

// ---- schema 层（PG）-------------------------------------------------------

function SchemaList({
  cfg,
  depth,
  onOpenTable,
}: {
  cfg: ConnConfig;
  depth: number;
  onOpenTable: (connId: string, table: TableRef) => void;
}) {
  const [schemas, setSchemas] = useState<string[] | null>(null);
  useEffect(() => {
    ipc
      .listSchemas(cfg.id, cfg.database ?? "")
      .then(setSchemas)
      .catch(() => setSchemas([]));
  }, [cfg.id, cfg.database]);

  if (schemas === null) return <Loading depth={depth} />;
  if (schemas.length === 0) return <Empty depth={depth} />;
  return (
    <>
      {schemas.map((s) => (
        <SchemaNode key={s} cfg={cfg} schema={s} depth={depth} onOpenTable={onOpenTable} />
      ))}
    </>
  );
}

function SchemaNode({
  cfg,
  schema,
  depth,
  onOpenTable,
}: {
  cfg: ConnConfig;
  schema: string;
  depth: number;
  onOpenTable: (connId: string, table: TableRef) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <Row
        depth={depth}
        hasChevron
        expanded={expanded}
        icon="◫"
        label={schema}
        title={schema}
        onClick={() => setExpanded((v) => !v)}
      />
      {expanded && (
        <TableList
          connId={cfg.id}
          listDatabase={cfg.database ?? ""}
          listSchema={schema}
          refDatabase={cfg.database}
          refSchema={schema}
          depth={depth + 1}
          onOpenTable={onOpenTable}
        />
      )}
    </div>
  );
}

// ---- 表层 -----------------------------------------------------------------

function TableList({
  connId,
  listDatabase,
  listSchema,
  refDatabase,
  refSchema,
  depth,
  onOpenTable,
}: {
  connId: string;
  listDatabase: string;
  listSchema: string | null;
  refDatabase: string | null;
  refSchema: string | null;
  depth: number;
  onOpenTable: (connId: string, table: TableRef) => void;
}) {
  const { t } = useTranslation();
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  useEffect(() => {
    ipc
      .listTables(connId, listDatabase, listSchema)
      .then(setTables)
      .catch(() => setTables([]));
  }, [connId, listDatabase, listSchema]);

  if (tables === null) return <Loading depth={depth} />;
  if (tables.length === 0) return <Empty depth={depth} />;
  return (
    <>
      {tables.map((tb) => (
        <Row
          key={tb.name}
          depth={depth}
          icon={<span className="text-neutral-500">{tb.kind === "view" ? "◉" : "▦"}</span>}
          label={tb.name}
          title={`${tb.name}（${t("tree.openData")}：双击）`}
          onDoubleClick={() =>
            onOpenTable(connId, { database: refDatabase, schema: refSchema, name: tb.name })
          }
        />
      ))}
    </>
  );
}

function IconBtn({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex h-5 w-5 items-center justify-center rounded text-[11px] text-neutral-400 hover:bg-neutral-700 hover:text-neutral-100"
    >
      {children}
    </button>
  );
}
