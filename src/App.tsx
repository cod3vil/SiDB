import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConnectionTree, type NewObjectType, type ExportStructureTarget } from "@/components/tree/ConnectionTree";
import { ExportDialog } from "@/components/export/ExportDialog";
import { ExportProgressLayer } from "@/components/export/ExportProgress";
import { ConnectionDialog } from "@/components/conn/ConnectionDialog";
import { NewDatabaseDialog } from "@/components/conn/NewDatabaseDialog";
import { NewTableDialog } from "@/components/table/NewTableDialog";
import { EditTableDialog } from "@/components/table/EditTableDialog";
import { NewViewDialog } from "@/components/table/NewViewDialog";
import { SaveQueryDialog } from "@/components/query/SaveQueryDialog";
import { TabBar } from "@/components/tab/TabBar";
import { Toaster } from "@/components/ui/toaster";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { AiPanel } from "@/components/ai/AiPanel";
import { TopBar } from "@/components/toolbar/TopBar";
import { SqlEditor } from "@/components/editor/SqlEditor";
import { ResultGrid } from "@/components/grid/ResultGrid";
import { ipc } from "@/ipc";
import type {
  ChangeSet,
  ConnConfig,
  DbCapabilities,
  ExportFormat,
  ExportScope,
  ResultSet,
  RoutineRef,
  RunResult,
  SavedQuery,
  TableRef,
} from "@/ipc/types";
import { useConnections } from "@/stores";
import { useAi } from "@/stores/ai";
import { useExports } from "@/stores/export";
import { toast } from "@/stores/toast";
import { save as saveFileDialog, open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { checkUpdate } from "@/lib/update";
import { errorMessage } from "@/lib/error";
import { LANGUAGES, setLanguage } from "@/i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type Theme, getTheme, applyTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { version } from "../package.json";

const PAGE_SIZE = 1000;

/** 一个查询标签：独立的连接上下文 + SQL + 结果。 */
interface QueryTab {
  id: string;
  title: string;
  connId: string | null;
  db: string | null;
  schema: string | null;
  databases: string[];
  schemas: string[];
  tables: string[];
  sql: string;
  results: RunResult[]; // 多语句：每条结果一个面板
  activeResult: number;
  running: boolean;
  error: string | null;
  browseTable: TableRef | null;
  page: number;
  savedQueryId?: string;
  /** 该 tab 为函数 tab（新增或编辑）：保存=执行/替换函数，而非收藏查询。 */
  creatingFunction?: boolean;
  /** 由「查看定义」打开的已存在函数：保存时交后端原地替换（PG CREATE OR REPLACE / MySQL DROP+CREATE）。 */
  functionRef?: RoutineRef;
}

/** 把表浏览的 ResultSet 包成 RunResult 行结果。 */
function rowsResult(rs: ResultSet): RunResult {
  return { type: "rows", ...rs };
}

type RowsResult = Extract<RunResult, { type: "rows" }>;
type AffectedResult = Extract<RunResult, { type: "affected" }>;
/** 结果面板：每个 SELECT 结果一个网格面板；所有非查询语句合并为一个「消息」面板。 */
type ResultPanel = { kind: "rows"; result: RowsResult } | { kind: "messages"; items: AffectedResult[] };

/** 把多语句结果归并成面板：rows 各自成面板，affected 全部并入一个消息面板（置于首个非查询语句处）。 */
function buildResultPanels(results: RunResult[]): ResultPanel[] {
  const panels: ResultPanel[] = [];
  let messages: { kind: "messages"; items: AffectedResult[] } | null = null;
  for (const r of results) {
    if (r.type === "rows") {
      panels.push({ kind: "rows", result: r });
    } else if (r.type === "affected") {
      if (!messages) {
        messages = { kind: "messages", items: [] };
        panels.push(messages);
      }
      messages.items.push(r);
    }
  }
  return panels;
}

/** 右键「新增函数/查询」时载入编辑器的模板（库/表/视图走可视化弹窗）。 */
function scaffoldSql(type: NewObjectType, kind?: string): string {
  switch (type) {
    case "function":
      if (kind === "postgres")
        return "CREATE FUNCTION new_function() RETURNS integer AS $$\nBEGIN\n  RETURN 0;\nEND;\n$$ LANGUAGE plpgsql;";
      if (kind === "sqlite") return "-- SQLite 不支持存储函数 / 存储过程";
      return "CREATE FUNCTION new_function() RETURNS INT\nBEGIN\n  RETURN 0;\nEND;";
    default:
      return "";
  }
}

export default function App() {
  const { t, i18n } = useTranslation();
  const { configs, connected, setConfigs, setConnected, bumpTree } = useConnections();

  const seqRef = useRef(1);
  const blankTab = (n: number, init: Partial<QueryTab> = {}): QueryTab => ({
    id: `tab-${n}`,
    title: t("tab.queryN", { n }),
    connId: null,
    db: null,
    schema: null,
    databases: [],
    schemas: [],
    tables: [],
    sql: "SELECT 1;",
    results: [],
    activeResult: 0,
    running: false,
    error: null,
    browseTable: null,
    page: 0,
    ...init,
  });

  const [tabs, setTabs] = useState<QueryTab[]>(() => [blankTab(1)]);
  const [activeTabId, setActiveTabId] = useState("tab-1");

  const [dialog, setDialog] = useState<{ cfg: ConnConfig | null; group?: string | null } | null>(null);
  const [dbDialog, setDbDialog] = useState<string | null>(null);
  const [tableDialog, setTableDialog] = useState<{
    connId: string;
    database: string | null;
    schema: string | null;
  } | null>(null);
  const [viewDialog, setViewDialog] = useState<{
    connId: string;
    database: string | null;
    schema: string | null;
  } | null>(null);
  const [editTableDialog, setEditTableDialog] = useState<{ connId: string; table: TableRef } | null>(null);

  const [saveDialog, setSaveDialog] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 结果导出弹窗上下文（打开时非空）。
  const [exportCtx, setExportCtx] = useState<{
    connId: string;
    source: { table: TableRef | null; sql: string | null };
    page: number;
    pageSize: number;
    tableName: string;
    label: string;
  } | null>(null);
  const aiOpen = useAi((s) => s.open);
  const toggleAi = useAi((s) => s.toggle);

  const [theme, setThemeState] = useState<Theme>(getTheme);
  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setThemeState(next);
    applyTheme(next);
  };

  // 编辑器 / 结果区分隔条高度（可拖拽）。
  const [editorHeight, setEditorHeight] = useState(240);
  const startDragSplit = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = editorHeight;
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(120, Math.min(startH + (ev.clientY - startY), window.innerHeight - 220));
      setEditorHeight(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  };

  // 左侧连接栏宽度（可拖右边缘）。
  const [leftWidth, setLeftWidth] = useState(256);
  const startDragLeftWidth = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = leftWidth;
    const onMove = (ev: MouseEvent) => {
      // 手柄在栏右侧：向右拖（clientX 变大）变宽。
      const next = Math.max(180, Math.min(startW + (ev.clientX - startX), Math.round(window.innerWidth * 0.6)));
      setLeftWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  // AI 侧栏宽度（可拖左边缘）。
  const [aiWidth, setAiWidth] = useState(384);
  const startDragAiWidth = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = aiWidth;
    const onMove = (ev: MouseEvent) => {
      // 手柄在面板左侧：向左拖（clientX 变小）变宽。
      const next = Math.max(300, Math.min(startW - (ev.clientX - startX), Math.round(window.innerWidth * 0.7)));
      setAiWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const activeTab = tabs.find((x) => x.id === activeTabId) ?? tabs[0];
  const updateTab = (id: string, patch: Partial<QueryTab>) =>
    setTabs((ts) => ts.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  // ---- tab 管理 -----------------------------------------------------------

  const addTab = () => {
    const n = ++seqRef.current;
    const a = activeTab;
    const tab = blankTab(n, {
      connId: a?.connId ?? null,
      db: a?.db ?? null,
      schema: a?.schema ?? null,
      databases: a?.databases ?? [],
      schemas: a?.schemas ?? [],
      tables: a?.tables ?? [],
      sql: "",
    });
    setTabs((ts) => [...ts, tab]);
    setActiveTabId(tab.id);
  };

  const closeTab = (id: string) => {
    const idx = tabs.findIndex((x) => x.id === id);
    const rest = tabs.filter((x) => x.id !== id);
    if (rest.length === 0) {
      const n = ++seqRef.current;
      const fresh = blankTab(n);
      setTabs([fresh]);
      setActiveTabId(fresh.id);
      return;
    }
    setTabs(rest);
    if (id === activeTabId) setActiveTabId((rest[idx - 1] ?? rest[0]).id);
  };

  const closeOthers = (id: string) => {
    setTabs((ts) => ts.filter((x) => x.id === id));
    setActiveTabId(id);
  };

  // ---- 上下文派生（基于当前激活 tab）-------------------------------------

  const caps = activeTab?.connId ? connected[activeTab.connId] : null;
  const cfg = configs.find((c) => c.id === activeTab?.connId) ?? null;
  const showDb = Boolean(caps?.supports_use_database);
  const showSchema = Boolean(caps?.supports_schemas);
  const refDatabase = showSchema ? (cfg?.database ?? null) : showDb ? (activeTab?.db ?? null) : null;
  const refSchema = showSchema ? (activeTab?.schema ?? null) : null;

  // ---- 命令式拉取上下文数据（避免切 tab 时闪烁/重置）---------------------

  const listTablesFor = async (
    connId: string,
    c: DbCapabilities,
    db: string | null,
    schema: string | null,
  ): Promise<string[]> => {
    if (c.supports_use_database && !db) return [];
    const conf = configs.find((x) => x.id === connId) ?? null;
    const listDb = c.supports_schemas ? (conf?.database ?? "") : (db ?? "main");
    const refS = c.supports_schemas ? schema : null;
    return ipc
      .listTables(connId, listDb, refS)
      .then((l) => l.map((x) => x.name))
      .catch(() => []);
  };

  const loadContext = async (
    connId: string,
    c: DbCapabilities,
    db: string | null,
    schema: string | null,
  ) => {
    const conf = configs.find((x) => x.id === connId) ?? null;
    let databases: string[] = [];
    let schemas: string[] = [];
    let outSchema = schema;
    if (c.supports_use_database) {
      databases = await ipc.listDatabases(connId).then((l) => l.map((d) => d.name)).catch(() => []);
    } else if (c.supports_schemas) {
      databases = conf?.database ? [conf.database] : [];
      schemas = await ipc.listSchemas(connId, conf?.database ?? "").catch(() => []);
      if (!outSchema) outSchema = schemas.includes("public") ? "public" : (schemas[0] ?? null);
    }
    const tables = await listTablesFor(connId, c, db, outSchema);
    return { databases, schemas, schema: outSchema, tables };
  };

  const ensureConnected = async (connId: string): Promise<DbCapabilities | null> => {
    let c = connected[connId];
    if (!c) {
      try {
        c = await ipc.connect(connId);
        setConnected(connId, c);
      } catch (e) {
        toast.error(errorMessage(e));
        return null;
      }
    }
    return c;
  };

  // ---- toolbar 操作（作用于激活 tab）------------------------------------

  const pickConn = async (connId: string) => {
    const tabId = activeTabId;
    updateTab(tabId, { error: null });
    const c = await ensureConnected(connId);
    if (!c) return;
    const ctx = await loadContext(connId, c, null, null);
    updateTab(tabId, { connId, db: null, ...ctx });
  };

  const pickDb = async (db: string) => {
    const tabId = activeTabId;
    const connId = activeTab?.connId;
    if (!connId || !caps) return;
    const tables = await listTablesFor(connId, caps, db, activeTab.schema);
    updateTab(tabId, { db, tables });
  };

  const pickSchema = async (schema: string) => {
    const tabId = activeTabId;
    const connId = activeTab?.connId;
    if (!connId || !caps) return;
    const tables = await listTablesFor(connId, caps, activeTab.db, schema);
    updateTab(tabId, { schema, tables });
  };

  // 左树点连接 / 库 / schema → 绑定到激活 tab，使工具栏联动（避免"未连接"错误）。
  const activateContext = async (connId: string, database: string | null, schema: string | null) => {
    const tabId = activeTabId;
    const c = await ensureConnected(connId);
    if (!c) return;
    const ctx = await loadContext(connId, c, database, schema);
    updateTab(tabId, {
      connId,
      db: database,
      schema: schema ?? ctx.schema ?? null,
      databases: ctx.databases,
      schemas: ctx.schemas,
      tables: ctx.tables,
      browseTable: null,
      error: null,
    });
  };

  const openTable = async (connId: string, table: TableRef) => {
    const tabId = activeTabId;
    const c = await ensureConnected(connId);
    if (!c) return;
    const ctx = await loadContext(connId, c, table.database ?? null, table.schema ?? null);
    updateTab(tabId, {
      connId,
      db: table.database ?? null,
      schema: table.schema ?? ctx.schema ?? null,
      databases: ctx.databases,
      schemas: ctx.schemas,
      tables: ctx.tables,
      browseTable: table,
      page: 0,
      error: null,
      title: table.name,
      creatingFunction: false,
      functionRef: undefined,
    });
    try {
      const rs = await ipc.openTableData(connId, table, 0, PAGE_SIZE);
      updateTab(tabId, { results: [rowsResult(rs)], activeResult: 0 });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const onSelectTable = (name: string) => {
    if (!activeTab?.connId) return;
    void openTable(activeTab.connId, { database: refDatabase, schema: refSchema, name });
  };

  const showDdl = async (connId: string, table: TableRef) => {
    const tabId = activeTabId;
    const c = await ensureConnected(connId);
    if (!c) return;
    const ctx = await loadContext(connId, c, table.database ?? null, table.schema ?? null);
    updateTab(tabId, {
      connId,
      db: table.database ?? null,
      schema: table.schema ?? ctx.schema ?? null,
      databases: ctx.databases,
      schemas: ctx.schemas,
      tables: ctx.tables,
      results: [],
      activeResult: 0,
      browseTable: null,
      error: null,
      creatingFunction: false,
      functionRef: undefined,
    });
    try {
      const ddl = await ipc.getTableDdl(connId, table);
      updateTab(tabId, { sql: ddl });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const showFunction = async (connId: string, routine: RoutineRef) => {
    const tabId = activeTabId;
    const c = await ensureConnected(connId);
    if (!c) return;
    const ctx = await loadContext(connId, c, routine.database ?? null, routine.schema ?? null);
    updateTab(tabId, {
      connId,
      db: routine.database ?? null,
      schema: routine.schema ?? ctx.schema ?? null,
      databases: ctx.databases,
      schemas: ctx.schemas,
      tables: ctx.tables,
      results: [],
      activeResult: 0,
      browseTable: null,
      error: null,
      // 标记为函数 tab：保存即原地更新该函数（见 saveFunction），而非另存为查询。
      creatingFunction: true,
      functionRef: routine,
    });
    try {
      const def = await ipc.getFunctionDdl(connId, routine);
      updateTab(tabId, { sql: def });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const newObject = (connId: string, database: string | null, schema: string | null, type: NewObjectType) => {
    if (type === "database") {
      setDbDialog(connId);
      return;
    }
    if (type === "table") {
      setTableDialog({ connId, database, schema });
      return;
    }
    if (type === "view") {
      setViewDialog({ connId, database, schema });
      return;
    }
    const tabId = activeTabId;
    const kind = configs.find((c) => c.id === connId)?.kind;
    updateTab(tabId, {
      connId,
      db: database ?? null,
      schema: schema ?? null,
      sql: scaffoldSql(type, kind),
      results: [],
      activeResult: 0,
      browseTable: null,
      error: null,
      creatingFunction: type === "function",
      // 新增函数无既有定义，走创建路径（非原地替换）。
      functionRef: undefined,
    });
    void (async () => {
      const c = connected[connId];
      if (!c) return;
      const ctx = await loadContext(connId, c, database ?? null, schema ?? null);
      updateTab(tabId, { databases: ctx.databases, schemas: ctx.schemas, tables: ctx.tables });
    })();
  };

  const runSql = async (): Promise<boolean> => {
    const tabId = activeTabId;
    const tab = tabs.find((x) => x.id === tabId);
    if (!tab) return false;
    if (!tab.connId) {
      updateTab(tabId, { error: t("editor.noConn") });
      return false;
    }
    updateTab(tabId, { running: true, error: null, browseTable: null });
    try {
      const results: RunResult[] = await ipc.runSql(
        tab.connId,
        tabId,
        tab.sql,
        0,
        PAGE_SIZE,
        connected[tab.connId]?.supports_use_database ? tab.db : null,
      );
      updateTab(tabId, { results, activeResult: 0, running: false });
      return true;
    } catch (e) {
      updateTab(tabId, { error: errorMessage(e), running: false });
      return false;
    }
  };

  // 函数 tab 的保存。保持 creatingFunction / functionRef 标记，使后续保存仍更新函数而非另存为查询。
  const saveFunction = async () => {
    const tab = activeTab;
    if (!tab?.connId) return;
    if (tab.functionRef) {
      // 编辑已存在函数：交后端原地替换（PG CREATE OR REPLACE；MySQL DROP+CREATE，整体执行不切分）。
      try {
        await ipc.replaceFunction(tab.connId, tab.functionRef, tab.sql);
      } catch (e) {
        updateTab(tab.id, { error: errorMessage(e) });
        toast.error(errorMessage(e));
        return;
      }
      updateTab(tab.id, { error: null });
      bumpTree();
      toast.success(t("editor.functionSaved"));
      return;
    }
    // 新增函数：整体执行定义创建（不切分、简单查询协议，兼容 MySQL routine DDL）。
    const db = connected[tab.connId]?.supports_use_database ? tab.db : null;
    try {
      await ipc.createFunction(tab.connId, db, tab.sql);
    } catch (e) {
      updateTab(tab.id, { error: errorMessage(e) });
      toast.error(errorMessage(e));
      return;
    }
    updateTab(tab.id, { error: null, results: [], activeResult: 0 });
    bumpTree();
    toast.success(t("editor.functionSaved"));
  };

  const cancelSql = async () => {
    const tab = activeTab;
    if (!tab?.connId) return;
    await ipc.cancelQuery(tab.connId, `${tab.id}:0`).catch(() => undefined);
  };

  // 运行给定 SQL 文本（AI 面板「运行」用）：直接执行并回填到编辑器，避免 setState 异步读到旧值。
  const runText = async (sqlText: string) => {
    const tabId = activeTabId;
    const tab = tabs.find((x) => x.id === tabId);
    if (!tab?.connId) {
      toast.error(t("editor.noConn"));
      return;
    }
    updateTab(tabId, { sql: sqlText, running: true, error: null, browseTable: null });
    try {
      const results = await ipc.runSql(
        tab.connId,
        tabId,
        sqlText,
        0,
        PAGE_SIZE,
        connected[tab.connId]?.supports_use_database ? tab.db : null,
      );
      updateTab(tabId, { results, activeResult: 0, running: false });
    } catch (e) {
      updateTab(tabId, { error: errorMessage(e), running: false });
    }
  };

  // AI 写提案确认执行：失败抛出（面板据此提示并保留卡片）。
  const aiConfirmWrite = async (proposalId: string) => {
    const tab = activeTab;
    if (!tab?.connId) throw new Error("no connection");
    await ipc.aiConfirmWrite(tab.connId, proposalId);
    bumpTree();
    if (tab.browseTable) {
      const rs = await ipc.openTableData(tab.connId, tab.browseTable, tab.page, PAGE_SIZE);
      updateTab(tab.id, { results: [rowsResult(rs)], activeResult: 0 });
    }
  };

  // ---- 编辑器内联 AI 动作（解释 / 优化 / 报错修复）------------------------
  // 统一把预置 prompt 送进 AI 侧栏（模型可顺带调 get_schema / EXPLAIN）。
  const aiAsk = (message: string) => {
    if (!activeTab?.connId) {
      toast.error(t("ai.noConn"));
      return;
    }
    useAi.getState().setOpen(true);
    void useAi.getState().ask(
      {
        connId: activeTab.connId,
        database: refDatabase,
        schema: refSchema,
        table: activeTab.browseTable?.name ?? null,
      },
      message,
    );
  };

  const aiEditorAction = (kind: "explain" | "optimize", sql: string) => {
    const lead = kind === "explain" ? t("ai.explainPrompt") : t("ai.optimizePrompt");
    aiAsk(`${lead}\n\n\`\`\`sql\n${sql}\n\`\`\``);
  };

  const aiFix = (sql: string, error: string) => {
    aiAsk(`${t("ai.fixPrompt")}\n\nSQL:\n\`\`\`sql\n${sql}\n\`\`\`\n\n${t("ai.fixError")}:\n${error}`);
  };

  const gotoPage = async (n: number) => {
    const tab = activeTab;
    if (!tab?.connId || !tab.browseTable) return;
    const next = Math.max(0, n);
    const rs = await ipc.openTableData(tab.connId, tab.browseTable, next, PAGE_SIZE);
    updateTab(tab.id, { page: next, results: [rowsResult(rs)], activeResult: 0 });
  };

  // 提交单元格编辑：写库后刷新当前页。失败抛出（让网格保留编辑）。
  const commitEdits = async (cs: ChangeSet) => {
    const tab = activeTab;
    if (!tab?.connId) return;
    try {
      await ipc.commitChanges(tab.connId, cs);
    } catch (e) {
      updateTab(tab.id, { error: errorMessage(e) });
      throw e;
    }
    updateTab(tab.id, { error: null });
    if (tab.browseTable) {
      const rs = await ipc.openTableData(tab.connId, tab.browseTable, tab.page, PAGE_SIZE);
      updateTab(tab.id, { results: [rowsResult(rs)], activeResult: 0 });
    } else {
      // 自定义「单表 SELECT」编辑：重跑当前 SQL 刷新。
      await runSql();
    }
  };

  // ---- 保存查询 -----------------------------------------------------------

  const requestSave = () => {
    if (!activeTab?.connId) return;
    if (activeTab.creatingFunction) {
      void saveFunction();
      return;
    }
    setSaveDialog(true);
  };
  // 让 Cmd+S 的事件回调始终拿到最新的 requestSave（含最新 tabs/SQL），避免闭包过期。
  const requestSaveRef = useRef(requestSave);
  requestSaveRef.current = requestSave;

  const doSaveQuery = async (name: string) => {
    const tab = activeTab;
    if (!tab?.connId) return;
    setSaveDialog(false);
    try {
      const q = await ipc.saveQuery({
        id: tab.savedQueryId,
        name,
        conn_id: tab.connId,
        database: refDatabase,
        schema: refSchema,
        sql: tab.sql,
      });
      updateTab(tab.id, { savedQueryId: q.id, title: q.name });
      bumpTree();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  // 打开已保存的查询到新标签。
  const openSavedQuery = async (connId: string, q: SavedQuery) => {
    const n = ++seqRef.current;
    const tab = blankTab(n, {
      title: q.name,
      connId,
      db: q.database,
      schema: q.schema,
      sql: q.sql,
      savedQueryId: q.id,
    });
    setTabs((ts) => [...ts, tab]);
    setActiveTabId(tab.id);
    let c = connected[connId];
    if (!c) {
      try {
        c = await ipc.connect(connId);
        setConnected(connId, c);
      } catch (e) {
        toast.error(errorMessage(e));
        return;
      }
    }
    const ctx = await loadContext(connId, c, q.database, q.schema);
    updateTab(tab.id, { databases: ctx.databases, schemas: ctx.schemas, tables: ctx.tables });
  };

  // 右击连接「运行 SQL 文件」：选 .sql → 新建 tab → 在该连接当前库执行全部。
  const runSqlFile = async (connId: string, database: string | null) => {
    const path = await openFileDialog({ filters: [{ name: "SQL", extensions: ["sql"] }] });
    if (typeof path !== "string") return;
    let c = connected[connId];
    if (!c) {
      try {
        c = await ipc.connect(connId);
        setConnected(connId, c);
      } catch (e) {
        toast.error(errorMessage(e));
        return;
      }
    }
    let sql: string;
    try {
      sql = await ipc.readTextFile(path);
    } catch (e) {
      toast.error(errorMessage(e));
      return;
    }
    const name = path.split(/[\\/]/).pop() ?? "script.sql";
    const n = ++seqRef.current;
    const tab = blankTab(n, { title: name, connId, db: database, sql });
    setTabs((ts) => [...ts, tab]);
    setActiveTabId(tab.id);
    const ctx = await loadContext(connId, c, database, null);
    updateTab(tab.id, { databases: ctx.databases, schemas: ctx.schemas, tables: ctx.tables, running: true });
    try {
      const results = await ipc.runSql(connId, tab.id, sql, 0, PAGE_SIZE, c.supports_use_database ? database : null);
      updateTab(tab.id, { results, activeResult: 0, running: false });
    } catch (e) {
      updateTab(tab.id, { error: errorMessage(e), running: false });
    }
  };

  // Cmd/Ctrl + S 保存当前 tab。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        requestSaveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 启动时按设置自动检查更新：发现新版本仅提示，由用户去设置里安装。
  useEffect(() => {
    ipc
      .getSettings()
      .then((s) => {
        if (!s.auto_check_update) return;
        checkUpdate()
          .then((u) => {
            if (u) toast.info(t("settings.newVersionToast", { v: u.version }));
          })
          .catch(() => undefined);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 导出进度事件 → 进度卡片 + 终态提示。
  useEffect(() => {
    const un = listen<import("@/ipc/types").ExportProgress>("export:progress", (e) => {
      const p = e.payload;
      useExports.getState().apply(p);
      if (p.status === "done") {
        toast.success(t("export.done", { n: p.written }));
        setTimeout(() => useExports.getState().remove(p.task_id), 5000);
      } else if (p.status === "error") {
        toast.error(p.message || t("export.error"));
        setTimeout(() => useExports.getState().remove(p.task_id), 6000);
      } else if (p.status === "cancelled") {
        setTimeout(() => useExports.getState().remove(p.task_id), 3000);
      }
    });
    return () => {
      void un.then((f) => f());
    };
  }, [t]);

  // 结果导出：由 ResultGrid「导出」按钮触发，收集当前 tab 上下文后开弹窗。
  const requestExport = () => {
    const tab = activeTab;
    if (!tab?.connId) return;
    const panel = buildResultPanels(tab.results)[tab.activeResult];
    if (!panel || panel.kind !== "rows") return;
    const rr = panel.result;
    const tableName = tab.browseTable?.name ?? "result";
    setExportCtx({
      connId: tab.connId,
      source: { table: tab.browseTable ?? null, sql: tab.browseTable ? null : tab.sql },
      page: rr.page.page,
      pageSize: rr.page.page_size,
      tableName,
      label: tableName,
    });
  };

  const doExportResult = async (opts: { format: ExportFormat; scope: ExportScope; limit: number }) => {
    const ctx = exportCtx;
    if (!ctx) return;
    setExportCtx(null);
    const path = await saveFileDialog({
      defaultPath: `${ctx.label}.${opts.format}`,
      filters: [{ name: opts.format.toUpperCase(), extensions: [opts.format] }],
    });
    if (typeof path !== "string") return;
    try {
      const taskId = await ipc.startExportResult({
        connId: ctx.connId,
        sql: ctx.source.sql,
        table: ctx.source.table,
        format: opts.format,
        scope: opts.scope,
        page: ctx.page,
        pageSize: ctx.pageSize,
        limit: opts.scope === "rows" ? opts.limit : null,
        sqlTableName: ctx.tableName,
        path,
      });
      useExports.getState().begin(taskId, ctx.label);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const exportStructure = async (connId: string, target: ExportStructureTarget, withData: boolean) => {
    const base = target.table?.name ?? target.schema ?? target.database ?? "schema";
    const path = await saveFileDialog({
      defaultPath: `${base}.sql`,
      filters: [{ name: "SQL", extensions: ["sql"] }],
    });
    if (typeof path !== "string") return;
    try {
      const taskId = await ipc.startExportStructure({
        connId,
        table: target.table,
        isView: target.isView,
        database: target.database,
        schema: target.schema,
        withData,
        path,
      });
      useExports.getState().begin(taskId, base);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const onSaved = () => {
    setDialog(null);
    ipc.listConnections().then(setConfigs).catch(() => undefined);
  };

  const connOptions = Object.keys(connected)
    .map((id) => configs.find((c) => c.id === id))
    .filter((c): c is ConnConfig => Boolean(c))
    .map((c) => ({ value: c.id, label: c.name }));

  return (
    <div className="flex h-screen w-screen flex-col bg-background text-foreground">
      <header
        data-tauri-drag-region
        className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3"
      >
        <div className="flex items-center gap-2">
          <img src="/logo.png" alt="" className="h-7 w-7 rounded-md" />
          <span className="rounded bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
            v{version}
          </span>
          <span className="text-[11px] text-muted-foreground/70">{t("app.subtitle")}</span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={toggleAi}
            title={t("ai.title")}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded hover:bg-accent hover:text-foreground",
              aiOpen ? "bg-accent text-primary" : "text-muted-foreground",
            )}
          >
            <i className="ri-sparkling-2-line" />
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            title={t("settings.title")}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <i className="ri-settings-3-line" />
          </button>
          <button
            onClick={toggleTheme}
            title={theme === "dark" ? "Light" : "Dark"}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <i className={theme === "dark" ? "ri-sun-line" : "ri-moon-line"} />
          </button>
          <Select value={i18n.language} onValueChange={setLanguage}>
            <SelectTrigger
              icon="ri-translate-2"
              className="h-6 w-auto gap-1 border-none bg-transparent px-1.5 text-muted-foreground hover:text-foreground"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((l) => (
                <SelectItem key={l.value} value={l.value}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside style={{ width: leftWidth }} className="flex shrink-0 flex-col border-r border-border bg-card/40">
          <ConnectionTree
            onOpenTable={openTable}
            onShowDdl={showDdl}
            onEditTable={(connId, table) => setEditTableDialog({ connId, table })}
            onActivate={activateContext}
            onNewObject={newObject}
            onOpenQuery={openSavedQuery}
            onShowFunction={showFunction}
            onExportStructure={exportStructure}
            onRunSqlFile={runSqlFile}
            onNewConnection={(group) => setDialog({ cfg: null, group })}
            onEditConnection={(c) => setDialog({ cfg: c })}
          />
        </aside>

        <div onMouseDown={startDragLeftWidth} className="group relative w-1 shrink-0 cursor-col-resize">
          <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:w-0.5 group-hover:bg-primary/60" />
        </div>

        <main className="flex min-w-0 flex-1 flex-col">
          <TabBar
            tabs={tabs.map((x) => ({ id: x.id, title: x.title }))}
            activeId={activeTabId}
            onSelect={setActiveTabId}
            onClose={closeTab}
            onCloseOthers={closeOthers}
            onNew={addTab}
          />
          <TopBar
            connections={connOptions}
            activeConn={activeTab?.connId ?? null}
            onSelectConn={pickConn}
            databases={activeTab?.databases ?? []}
            activeDb={activeTab?.db ?? null}
            onSelectDb={pickDb}
            schemas={showSchema ? (activeTab?.schemas ?? []) : undefined}
            activeSchema={activeTab?.schema ?? null}
            onSelectSchema={pickSchema}
            tables={activeTab?.tables ?? []}
            activeTable={activeTab?.browseTable?.name ?? null}
            onSelectTable={onSelectTable}
            running={Boolean(activeTab?.running)}
            canRun={Boolean(activeTab?.connId)}
            onRun={runSql}
            onCancel={cancelSql}
            canSave={Boolean(activeTab?.connId)}
            onSave={requestSave}
          />
          <div className="shrink-0 overflow-hidden" style={{ height: editorHeight }}>
            <SqlEditor
              value={activeTab?.sql ?? ""}
              onChange={(v) => updateTab(activeTabId, { sql: v })}
              onRun={runSql}
              onAiAction={aiEditorAction}
              theme={theme}
            />
          </div>
          <div onMouseDown={startDragSplit} className="group relative h-1.5 shrink-0 cursor-row-resize">
            <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border transition-colors group-hover:h-0.5 group-hover:bg-primary/60" />
          </div>
          <div className="relative flex min-h-0 flex-1 flex-col p-2">
            {/* 已有结果时再查询：右下角小转圈，保留旧结果。无结果时用居中大 loading（见下）。 */}
            {activeTab?.running && (activeTab?.results?.length ?? 0) > 0 && (
              <div className="pointer-events-none absolute bottom-2.5 right-3 z-10 flex items-center gap-1.5 rounded-md border border-border bg-card/90 px-2.5 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
                <i className="ri-loader-4-line animate-spin text-primary" />
                {t("grid.querying")}
              </div>
            )}
            {activeTab?.error && (
              <div className="mb-2 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <span className="flex-1 whitespace-pre-wrap">{activeTab.error}</span>
                {activeTab.connId && (
                  <button
                    onClick={() => aiFix(activeTab.sql, activeTab.error ?? "")}
                    className="flex shrink-0 items-center gap-1 rounded border border-destructive/40 px-1.5 py-0.5 text-xs hover:bg-destructive/10"
                    title={t("ai.fix")}
                  >
                    <i className="ri-sparkling-2-line" />
                    {t("ai.fix")}
                  </button>
                )}
              </div>
            )}
            {(() => {
              const results = activeTab?.results ?? [];
              const ar = activeTab?.activeResult ?? 0;
              const browseMode = Boolean(activeTab?.browseTable);
              if (activeTab?.running && results.length === 0) {
                return (
                  <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                    <i className="ri-loader-4-line animate-spin text-2xl text-primary" />
                    {t("grid.querying")}
                  </div>
                );
              }
              if (results.length === 0) {
                return (
                  <div className="flex flex-1 items-center justify-center">
                    <div className="text-center text-sm text-muted-foreground/70">
                      <i className="ri-table-line mb-2 block text-3xl text-muted-foreground/40" />
                      {t("grid.welcome")}
                    </div>
                  </div>
                );
              }
              const panels = buildResultPanels(results);
              const ap = Math.min(ar, panels.length - 1);
              const panel = panels[ap];
              let rowsSeen = 0;
              return (
                <div className="flex min-h-0 flex-1 flex-col">
                  {panels.length > 1 && (
                    <div className="mb-1 flex shrink-0 items-stretch overflow-x-auto border-b border-border">
                      {panels.map((p, i) => {
                        const label =
                          p.kind === "rows"
                            ? t("grid.resultN", { n: ++rowsSeen })
                            : t("grid.messages");
                        return (
                          <button
                            key={i}
                            onClick={() => updateTab(activeTabId, { activeResult: i })}
                            className={cn(
                              "-mb-px shrink-0 border-b-2 px-2.5 py-1 text-xs",
                              i === ap
                                ? "border-primary text-foreground"
                                : "border-transparent text-muted-foreground hover:text-foreground",
                            )}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  <div className="flex min-h-0 flex-1 flex-col">
                    {panel?.kind === "rows" ? (
                      (() => {
                        // 表浏览用 browseTable；自定义「单表 SELECT」用后端解析出的 editable_table。
                        const editTable = browseMode
                          ? (activeTab?.browseTable ?? null)
                          : (panel.result.editable_table ?? null);
                        return (
                          <ResultGrid
                            result={panel.result}
                            onGoto={browseMode ? gotoPage : undefined}
                            table={editTable}
                            onCommit={editTable ? commitEdits : undefined}
                            onExport={activeTab?.connId ? requestExport : undefined}
                          />
                        );
                      })()
                    ) : panel?.kind === "messages" ? (
                      <div className="flex-1 space-y-2 overflow-auto rounded-md border border-border bg-muted/20 p-3 font-mono text-xs leading-relaxed">
                        {panel.items.map((it, i) => (
                          <div key={i} className={i > 0 ? "border-t border-border/60 pt-2" : ""}>
                            <div className="whitespace-pre-wrap text-foreground">{it.statement}</div>
                            <div className="mt-1 flex items-center gap-1.5 text-emerald-500">
                              <i className="ri-checkbox-circle-line" />
                              {t("grid.affectedRows", { n: it.affected_rows })}
                            </div>
                            {it.last_insert_id != null && (
                              <div className="text-muted-foreground">
                                <span className="opacity-60">› </span>
                                {t("grid.lastInsertId", { n: it.last_insert_id })}
                              </div>
                            )}
                            <div className="text-muted-foreground">
                              <span className="opacity-60">› </span>
                              {t("grid.time", { s: (it.elapsed_ms / 1000).toFixed(3) })}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })()}
          </div>
        </main>

        {aiOpen && (
          <div onMouseDown={startDragAiWidth} className="group relative w-1 shrink-0 cursor-col-resize">
            <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:w-0.5 group-hover:bg-primary/60" />
          </div>
        )}
        {aiOpen && (
          <AiPanel
            width={aiWidth}
            connId={activeTab?.connId ?? null}
            database={refDatabase}
            schema={refSchema}
            table={activeTab?.browseTable?.name ?? null}
            onInsertSql={(sql) => updateTab(activeTabId, { sql })}
            onRunSql={runText}
            onConfirmWrite={aiConfirmWrite}
            onClose={toggleAi}
          />
        )}
      </div>

      {dialog && (
        <ConnectionDialog
          initial={dialog.cfg}
          initialGroup={dialog.group}
          onClose={() => setDialog(null)}
          onSaved={onSaved}
        />
      )}

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}

      {saveDialog && (
        <SaveQueryDialog
          initialName={activeTab?.savedQueryId ? activeTab.title : ""}
          onClose={() => setSaveDialog(false)}
          onConfirm={doSaveQuery}
        />
      )}

      {dbDialog && connected[dbDialog] && (
        <NewDatabaseDialog
          connId={dbDialog}
          kind={configs.find((c) => c.id === dbDialog)?.kind ?? "mysql"}
          quoteChar={connected[dbDialog].quote_char}
          onClose={() => setDbDialog(null)}
          onCreated={() => {
            setDbDialog(null);
            bumpTree();
          }}
        />
      )}

      {tableDialog && connected[tableDialog.connId] && (
        <NewTableDialog
          connId={tableDialog.connId}
          kind={configs.find((c) => c.id === tableDialog.connId)?.kind ?? "mysql"}
          quoteChar={connected[tableDialog.connId].quote_char}
          database={tableDialog.database}
          schema={tableDialog.schema}
          onClose={() => setTableDialog(null)}
          onCreated={() => {
            setTableDialog(null);
            bumpTree();
          }}
        />
      )}

      {editTableDialog && connected[editTableDialog.connId] && (
        <EditTableDialog
          connId={editTableDialog.connId}
          kind={configs.find((c) => c.id === editTableDialog.connId)?.kind ?? "mysql"}
          quoteChar={connected[editTableDialog.connId].quote_char}
          table={editTableDialog.table}
          onClose={() => setEditTableDialog(null)}
          onSaved={() => {
            setEditTableDialog(null);
            bumpTree();
          }}
        />
      )}

      {viewDialog && connected[viewDialog.connId] && (
        <NewViewDialog
          connId={viewDialog.connId}
          quoteChar={connected[viewDialog.connId].quote_char}
          database={viewDialog.database}
          schema={viewDialog.schema}
          onClose={() => setViewDialog(null)}
          onCreated={() => {
            setViewDialog(null);
            bumpTree();
          }}
        />
      )}

      {exportCtx && <ExportDialog onClose={() => setExportCtx(null)} onConfirm={doExportResult} />}

      <ExportProgressLayer />
      <Toaster />
    </div>
  );
}
