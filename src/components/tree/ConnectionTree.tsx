// 对象浏览器（TDD §9 / PRD §3.2）：连接管理 + 能力驱动的懒加载树 + 过滤。
//
// 层级（由 DbCapabilities 决定，无 if mysql/pg/sqlite 硬编码）：
//   - PG（supports_schemas）：连接 → schema → [表/视图/函数/自定义查询] → 项
//   - MySQL（supports_multi_database）：连接 → 数据库 → [表/视图/函数/自定义查询] → 项
//   - SQLite：连接 → [表/视图/函数/自定义查询] → 项

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { confirm } from "@tauri-apps/plugin-dialog";
import { ipc } from "@/ipc";
import type { ConnConfig, DbCapabilities, RoutineInfo, TableInfo, TableRef } from "@/ipc/types";
import { useConnections } from "@/stores";
import { errorMessage } from "@/lib/error";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

/** 复制到剪贴板（webview 安全上下文）。 */
function copyText(s: string) {
  void navigator.clipboard?.writeText(s).catch(() => undefined);
}

export type NewObjectType = "database" | "table" | "view" | "function" | "query";

/** 树操作：避免逐层透传，深层节点经此消费。 */
const TreeCtx = createContext<{
  onShowDdl: (connId: string, table: TableRef) => void;
  onNewObject: (connId: string, database: string | null, schema: string | null, type: NewObjectType) => void;
}>({
  onShowDdl: () => undefined,
  onNewObject: () => undefined,
});

interface Props {
  onOpenTable: (connId: string, table: TableRef) => void;
  onShowDdl: (connId: string, table: TableRef) => void;
  onNewObject: (connId: string, database: string | null, schema: string | null, type: NewObjectType) => void;
  onNewConnection: () => void;
  onEditConnection: (cfg: ConnConfig) => void;
}

export function ConnectionTree({
  onOpenTable,
  onShowDdl,
  onNewObject,
  onNewConnection,
  onEditConnection,
}: Props) {
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
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("conn.connect")}
        </span>
        <button
          onClick={onNewConnection}
          title={t("conn.new")}
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-md bg-emerald-600 text-white hover:bg-emerald-500"
        >
          <i className="ri-add-line text-base" />
        </button>
      </div>

      {configs.length > 0 && (
        <input
          className="m-2 rounded-md border border-border bg-muted px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/70 outline-none focus:border-emerald-500"
          placeholder={t("tree.filter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      )}

      {error && (
        <div className="mx-2 mb-1 rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto px-1.5 pb-2">
        {configs.length === 0 ? (
          <EmptyState onNew={onNewConnection} />
        ) : (
          <TreeCtx.Provider value={{ onShowDdl, onNewObject }}>
            {filtered.map((cfg) => (
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
            ))}
          </TreeCtx.Provider>
        )}
      </div>
    </div>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <i className="ri-database-2-line text-2xl" />
      </div>
      <div className="text-sm font-medium text-foreground">{t("tree.empty")}</div>
      <div className="text-xs text-muted-foreground">{t("tree.emptyHint")}</div>
      <button
        onClick={onNew}
        className="mt-1 flex items-center gap-1 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
      >
        <i className="ri-add-line" />
        {t("conn.new")}
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
  iconColor,
  label,
  trailing,
  actions,
  onClick,
  onDoubleClick,
  title,
}: {
  depth: number;
  expanded?: boolean;
  hasChevron?: boolean;
  icon: string;
  iconColor?: string;
  label: string;
  trailing?: React.ReactNode;
  actions?: React.ReactNode;
  onClick?: () => void;
  onDoubleClick?: () => void;
  title?: string;
}) {
  return (
    <div
      className="group flex items-center gap-1.5 rounded-md py-1 pr-1.5 cursor-pointer hover:bg-accent"
      style={{ paddingLeft: 6 + depth * 12 }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={title}
    >
      <i
        className={`ri-arrow-${expanded ? "down" : "right"}-s-line w-3 shrink-0 text-xs text-muted-foreground ${
          hasChevron ? "" : "opacity-0"
        }`}
      />
      <i className={`${icon} shrink-0 text-[15px] ${iconColor ?? "text-muted-foreground"}`} />
      <span className="truncate flex-1 text-foreground">{label}</span>
      {actions}
      {trailing}
    </div>
  );
}

function Loading({ depth }: { depth: number }) {
  const { t } = useTranslation();
  return (
    <div className="py-1 text-xs text-muted-foreground" style={{ paddingLeft: 6 + depth * 12 + 22 }}>
      {t("tree.loading")}
    </div>
  );
}

function Hint({ depth, text }: { depth: number; text: string }) {
  return (
    <div className="py-1 text-xs text-muted-foreground/70" style={{ paddingLeft: 6 + depth * 12 + 22 }}>
      {text}
    </div>
  );
}

function ErrRow({ depth, msg }: { depth: number; msg: string }) {
  return (
    <div className="py-1 text-xs text-destructive" style={{ paddingLeft: 6 + depth * 12 + 22 }} title={msg}>
      {msg}
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
  const { onNewObject } = useContext(TreeCtx);
  const [expanded, setExpanded] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

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

  const ensureConnected = async () => {
    if (caps) return true;
    setConnecting(true);
    try {
      await onConnect();
      return true;
    } catch {
      return false;
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div>
            <Row
              depth={0}
              hasChevron
              expanded={expanded}
              icon="ri-server-line"
              iconColor={caps ? "text-emerald-400" : "text-muted-foreground"}
              label={cfg.name}
              title={cfg.name}
              onClick={toggle}
              trailing={
                connecting ? (
                  <span className="text-[10px] text-muted-foreground">{t("conn.connecting")}</span>
                ) : (
                  <span className="text-[10px] uppercase text-muted-foreground/70 group-hover:hidden">{cfg.kind}</span>
                )
              }
              actions={
                <span className="hidden items-center gap-0.5 group-hover:flex">
                  <IconBtn icon="ri-edit-line" title={t("conn.edit")} onClick={onEdit} />
                  <IconBtn icon="ri-delete-bin-line" title={t("conn.delete")} onClick={onDelete} />
                  {caps && (
                    <IconBtn icon="ri-shut-down-line" title={t("conn.disconnect")} onClick={onDisconnect} />
                  )}
                </span>
              }
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {caps ? (
            <ContextMenuItem icon="ri-shut-down-line" onClick={onDisconnect}>
              {t("conn.disconnect")}
            </ContextMenuItem>
          ) : (
            <ContextMenuItem
              icon="ri-plug-line"
              onClick={async () => {
                if (await ensureConnected()) setExpanded(true);
              }}
            >
              {t("conn.connect")}
            </ContextMenuItem>
          )}
          {caps?.supports_multi_database && (
            <ContextMenuItem
              icon="ri-database-2-line"
              onClick={() => onNewObject(cfg.id, null, null, "database")}
            >
              {t("tree.newDatabase")}
            </ContextMenuItem>
          )}
          <ContextMenuItem
            icon="ri-refresh-line"
            disabled={!caps}
            onClick={() => setRefreshKey((k) => k + 1)}
          >
            {t("tree.refresh")}
          </ContextMenuItem>
          <ContextMenuItem icon="ri-file-copy-line" onClick={() => copyText(cfg.name)}>
            {t("tree.copyName")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem icon="ri-edit-line" onClick={onEdit}>
            {t("conn.edit")}
          </ContextMenuItem>
          <ContextMenuItem icon="ri-delete-bin-line" destructive onClick={onDelete}>
            {t("conn.delete")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {expanded && caps && (
        <CapsChildren key={refreshKey} cfg={cfg} caps={caps} depth={1} onOpenTable={onOpenTable} />
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
    return <SchemaList cfg={cfg} depth={depth} onOpenTable={onOpenTable} />;
  }
  if (caps.supports_multi_database) {
    return <DatabaseList cfg={cfg} depth={depth} onOpenTable={onOpenTable} />;
  }
  // SQLite：无库/schema 层，直接四类。
  return (
    <Categories
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
  const [err, setErr] = useState<string | null>(null);
  const treeVersion = useConnections((s) => s.treeVersion);
  useEffect(() => {
    ipc
      .listDatabases(cfg.id)
      .then((list) => setDbs(list.map((d) => d.name)))
      .catch((e) => setErr(errorMessage(e)));
  }, [cfg.id, treeVersion]);

  if (err) return <ErrRow depth={depth} msg={err} />;
  if (dbs === null) return <Loading depth={depth} />;
  return (
    <>
      {dbs.map((db) => (
        <ContainerNode
          key={db}
          icon="ri-database-2-line"
          label={db}
          depth={depth}
          connId={cfg.id}
          listDatabase={db}
          listSchema={null}
          refDatabase={db}
          refSchema={null}
          onOpenTable={onOpenTable}
        />
      ))}
    </>
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
  const [err, setErr] = useState<string | null>(null);
  const treeVersion = useConnections((s) => s.treeVersion);
  useEffect(() => {
    ipc
      .listSchemas(cfg.id, cfg.database ?? "")
      .then(setSchemas)
      .catch((e) => setErr(errorMessage(e)));
  }, [cfg.id, cfg.database, treeVersion]);

  if (err) return <ErrRow depth={depth} msg={err} />;
  if (schemas === null) return <Loading depth={depth} />;
  return (
    <>
      {schemas.map((s) => (
        <ContainerNode
          key={s}
          icon="ri-stack-line"
          label={s}
          depth={depth}
          connId={cfg.id}
          listDatabase={cfg.database ?? ""}
          listSchema={s}
          refDatabase={cfg.database}
          refSchema={s}
          onOpenTable={onOpenTable}
        />
      ))}
    </>
  );
}

// 数据库 / schema 容器：展开后是「表/视图/函数/自定义查询」四类。
function ContainerNode({
  icon,
  label,
  depth,
  connId,
  listDatabase,
  listSchema,
  refDatabase,
  refSchema,
  onOpenTable,
}: {
  icon: string;
  label: string;
  depth: number;
  connId: string;
  listDatabase: string;
  listSchema: string | null;
  refDatabase: string | null;
  refSchema: string | null;
  onOpenTable: (connId: string, table: TableRef) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div>
            <Row
              depth={depth}
              hasChevron
              expanded={expanded}
              icon={icon}
              iconColor="text-sky-400"
              label={label}
              title={label}
              onClick={() => setExpanded((v) => !v)}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            icon="ri-refresh-line"
            onClick={() => {
              setExpanded(true);
              setRefreshKey((k) => k + 1);
            }}
          >
            {t("tree.refresh")}
          </ContextMenuItem>
          <ContextMenuItem icon="ri-file-copy-line" onClick={() => copyText(label)}>
            {t("tree.copyName")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {expanded && (
        <Categories
          key={refreshKey}
          connId={connId}
          listDatabase={listDatabase}
          listSchema={listSchema}
          refDatabase={refDatabase}
          refSchema={refSchema}
          depth={depth + 1}
          onOpenTable={onOpenTable}
        />
      )}
    </div>
  );
}

// ---- 四类分组 -------------------------------------------------------------

type CategoryProps = {
  connId: string;
  listDatabase: string;
  listSchema: string | null;
  refDatabase: string | null;
  refSchema: string | null;
  depth: number;
  onOpenTable: (connId: string, table: TableRef) => void;
};

function Categories(p: CategoryProps) {
  const { t } = useTranslation();
  return (
    <>
      <CategoryNode {...p} kind="tables" icon="ri-table-line" label={t("tree.tables")} />
      <CategoryNode {...p} kind="views" icon="ri-eye-line" label={t("tree.views")} />
      <CategoryNode {...p} kind="functions" icon="ri-function-line" label={t("tree.functions")} />
      <CategoryNode {...p} kind="queries" icon="ri-bookmark-line" label={t("tree.queries")} />
    </>
  );
}

function CategoryNode(
  p: CategoryProps & { kind: "tables" | "views" | "functions" | "queries"; icon: string; label: string },
) {
  const { t } = useTranslation();
  const { onNewObject } = useContext(TreeCtx);
  const treeVersion = useConnections((s) => s.treeVersion);
  const [expanded, setExpanded] = useState(false);
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [funcs, setFuncs] = useState<RoutineInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // 建表后（treeVersion 变化）若已展开则重新拉取。
  useEffect(() => {
    if (!expanded) return;
    if (p.kind === "tables" || p.kind === "views") {
      ipc.listTables(p.connId, p.listDatabase, p.listSchema).then(setTables).catch((e) => setErr(errorMessage(e)));
    } else if (p.kind === "functions") {
      ipc.listFunctions(p.connId, p.listDatabase, p.listSchema).then(setFuncs).catch((e) => setErr(errorMessage(e)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeVersion]);

  const newMeta: Record<typeof p.kind, { type: NewObjectType; label: string }> = {
    tables: { type: "table", label: t("tree.newTable") },
    views: { type: "view", label: t("tree.newView") },
    functions: { type: "function", label: t("tree.newFunction") },
    queries: { type: "query", label: t("tree.newQuery") },
  };

  const load = () => {
    if (p.kind === "tables" || p.kind === "views") {
      if (tables === null) {
        ipc
          .listTables(p.connId, p.listDatabase, p.listSchema)
          .then(setTables)
          .catch((e) => setErr(errorMessage(e)));
      }
    } else if (p.kind === "functions") {
      if (funcs === null) {
        ipc
          .listFunctions(p.connId, p.listDatabase, p.listSchema)
          .then(setFuncs)
          .catch((e) => setErr(errorMessage(e)));
      }
    }
  };

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    if (next) load();
  };

  const cdepth = p.depth + 1;
  const items =
    p.kind === "tables"
      ? tables?.filter((x) => x.kind === "table")
      : p.kind === "views"
        ? tables?.filter((x) => x.kind === "view")
        : undefined;

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div>
            <Row depth={p.depth} hasChevron expanded={expanded} icon={p.icon} label={p.label} onClick={toggle} />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            icon="ri-add-line"
            onClick={() => onNewObject(p.connId, p.refDatabase, p.refSchema, newMeta[p.kind].type)}
          >
            {newMeta[p.kind].label}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {expanded && (
        <>
          {err && <ErrRow depth={cdepth} msg={err} />}
          {/* 表 / 视图 */}
          {(p.kind === "tables" || p.kind === "views") &&
            !err &&
            (tables === null ? (
              <Loading depth={cdepth} />
            ) : items && items.length > 0 ? (
              items.map((tb) => (
                <TableItem
                  key={tb.name}
                  connId={p.connId}
                  table={{ database: p.refDatabase, schema: p.refSchema, name: tb.name }}
                  isView={p.kind === "views"}
                  depth={cdepth}
                  onOpenTable={p.onOpenTable}
                />
              ))
            ) : (
              <Hint depth={cdepth} text={t("grid.empty")} />
            ))}
          {/* 函数 */}
          {p.kind === "functions" &&
            !err &&
            (funcs === null ? (
              <Loading depth={cdepth} />
            ) : funcs.length > 0 ? (
              funcs.map((fn) => (
                <Row
                  key={fn.name}
                  depth={cdepth}
                  icon={fn.kind === "procedure" ? "ri-terminal-box-line" : "ri-function-line"}
                  iconColor="text-muted-foreground"
                  label={fn.name}
                  title={fn.name}
                />
              ))
            ) : (
              <Hint depth={cdepth} text={t("grid.empty")} />
            ))}
          {/* 自定义查询（保存的查询，功能待补） */}
          {p.kind === "queries" && <Hint depth={cdepth} text={t("tree.queriesEmpty")} />}
        </>
      )}
    </div>
  );
}

// 表 / 视图项：双击打开数据；右键菜单 = 打开数据 / 查看 DDL / 复制名称。
function TableItem({
  connId,
  table,
  isView,
  depth,
  onOpenTable,
}: {
  connId: string;
  table: TableRef;
  isView: boolean;
  depth: number;
  onOpenTable: (connId: string, table: TableRef) => void;
}) {
  const { t } = useTranslation();
  const { onShowDdl } = useContext(TreeCtx);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>
          <Row
            depth={depth}
            icon={isView ? "ri-eye-line" : "ri-table-2-line"}
            iconColor="text-muted-foreground"
            label={table.name}
            title={`${table.name}（${t("tree.openData")}：双击）`}
            onDoubleClick={() => onOpenTable(connId, table)}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem icon="ri-table-line" onClick={() => onOpenTable(connId, table)}>
          {t("tree.openData")}
        </ContextMenuItem>
        <ContextMenuItem icon="ri-file-code-line" onClick={() => onShowDdl(connId, table)}>
          {t("tree.viewDdl")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem icon="ri-file-copy-line" onClick={() => copyText(table.name)}>
          {t("tree.copyName")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function IconBtn({ icon, title, onClick }: { icon: string; title: string; onClick: () => void }) {
  return (
    <button
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <i className={`${icon} text-sm`} />
    </button>
  );
}
