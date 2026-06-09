// 对象浏览器（TDD §9 / PRD §3.2）：连接管理 + 能力驱动的懒加载树 + 过滤。
//
// 层级（由 DbCapabilities 决定，无 if mysql/pg/sqlite 硬编码）：
//   - PG（supports_schemas）：连接 → schema → [表/视图/函数/自定义查询] → 项
//   - MySQL（supports_multi_database）：连接 → 数据库 → [表/视图/函数/自定义查询] → 项
//   - SQLite：连接 → [表/视图/函数/自定义查询] → 项

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { confirm } from "@tauri-apps/plugin-dialog";
import { ipc } from "@/ipc";
import type { ConnConfig, DbCapabilities, RoutineInfo, TableInfo, TableRef } from "@/ipc/types";
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
          <i className="ri-add-line text-base" />
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
        <i className="ri-database-2-line text-2xl" />
      </div>
      <div className="text-sm font-medium text-neutral-300">{t("tree.empty")}</div>
      <div className="text-xs text-neutral-500">{t("tree.emptyHint")}</div>
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
      className="group flex items-center gap-1.5 rounded-md py-1 pr-1.5 cursor-pointer hover:bg-neutral-800"
      style={{ paddingLeft: 6 + depth * 12 }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={title}
    >
      <i
        className={`ri-arrow-${expanded ? "down" : "right"}-s-line w-3 shrink-0 text-xs text-neutral-500 ${
          hasChevron ? "" : "opacity-0"
        }`}
      />
      <i className={`${icon} shrink-0 text-[15px] ${iconColor ?? "text-neutral-400"}`} />
      <span className="truncate flex-1 text-neutral-200">{label}</span>
      {actions}
      {trailing}
    </div>
  );
}

function Loading({ depth }: { depth: number }) {
  const { t } = useTranslation();
  return (
    <div className="py-1 text-xs text-neutral-500" style={{ paddingLeft: 6 + depth * 12 + 22 }}>
      {t("tree.loading")}
    </div>
  );
}

function Hint({ depth, text }: { depth: number; text: string }) {
  return (
    <div className="py-1 text-xs text-neutral-600" style={{ paddingLeft: 6 + depth * 12 + 22 }}>
      {text}
    </div>
  );
}

function ErrRow({ depth, msg }: { depth: number; msg: string }) {
  return (
    <div className="py-1 text-xs text-red-400" style={{ paddingLeft: 6 + depth * 12 + 22 }} title={msg}>
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
        icon="ri-server-line"
        iconColor={caps ? "text-emerald-400" : "text-neutral-500"}
        label={cfg.name}
        title={cfg.name}
        onClick={toggle}
        trailing={
          connecting ? (
            <span className="text-[10px] text-neutral-500">{t("conn.connecting")}</span>
          ) : (
            <span className="text-[10px] uppercase text-neutral-600 group-hover:hidden">{cfg.kind}</span>
          )
        }
        actions={
          <span className="hidden items-center gap-0.5 group-hover:flex">
            <IconBtn icon="ri-edit-line" title={t("conn.edit")} onClick={onEdit} />
            <IconBtn icon="ri-delete-bin-line" title={t("conn.delete")} onClick={onDelete} />
            {caps && <IconBtn icon="ri-shut-down-line" title={t("conn.disconnect")} onClick={onDisconnect} />}
          </span>
        }
      />
      {expanded && caps && <CapsChildren cfg={cfg} caps={caps} depth={1} onOpenTable={onOpenTable} />}
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
  useEffect(() => {
    ipc
      .listDatabases(cfg.id)
      .then((list) => setDbs(list.map((d) => d.name)))
      .catch((e) => setErr(errorMessage(e)));
  }, [cfg.id]);

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
  useEffect(() => {
    ipc
      .listSchemas(cfg.id, cfg.database ?? "")
      .then(setSchemas)
      .catch((e) => setErr(errorMessage(e)));
  }, [cfg.id, cfg.database]);

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
  const [expanded, setExpanded] = useState(false);
  return (
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
      {expanded && (
        <Categories
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
  const [expanded, setExpanded] = useState(false);
  const [tables, setTables] = useState<TableInfo[] | null>(null);
  const [funcs, setFuncs] = useState<RoutineInfo[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

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
      <Row depth={p.depth} hasChevron expanded={expanded} icon={p.icon} label={p.label} onClick={toggle} />
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
                <Row
                  key={tb.name}
                  depth={cdepth}
                  icon={p.kind === "views" ? "ri-eye-line" : "ri-table-2-line"}
                  iconColor="text-neutral-500"
                  label={tb.name}
                  title={`${tb.name}（${t("tree.openData")}：双击）`}
                  onDoubleClick={() =>
                    p.onOpenTable(p.connId, {
                      database: p.refDatabase,
                      schema: p.refSchema,
                      name: tb.name,
                    })
                  }
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
                  iconColor="text-neutral-500"
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

function IconBtn({ icon, title, onClick }: { icon: string; title: string; onClick: () => void }) {
  return (
    <button
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex h-5 w-5 items-center justify-center rounded text-neutral-400 hover:bg-neutral-700 hover:text-neutral-100"
    >
      <i className={`${icon} text-sm`} />
    </button>
  );
}
