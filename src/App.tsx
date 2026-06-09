import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConnectionTree } from "@/components/tree/ConnectionTree";
import { ConnectionDialog } from "@/components/conn/ConnectionDialog";
import { TopBar } from "@/components/toolbar/TopBar";
import { SqlEditor } from "@/components/editor/SqlEditor";
import { ResultGrid } from "@/components/grid/ResultGrid";
import { ipc } from "@/ipc";
import type { ConnConfig, ResultSet, RunResult, TableRef } from "@/ipc/types";
import { useConnections } from "@/stores";
import { errorMessage } from "@/lib/error";
import { LANGUAGES, setLanguage } from "@/i18n";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const PAGE_SIZE = 1000;
const TAB_ID = "tab-1";

export default function App() {
  const { t, i18n } = useTranslation();
  const { configs, connected, setConfigs, setConnected } = useConnections();
  const [activeConn, setActiveConn] = useState<string | null>(null);
  const [sql, setSql] = useState("SELECT 1;");
  const [result, setResult] = useState<ResultSet | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browseTable, setBrowseTable] = useState<TableRef | null>(null);
  const [page, setPage] = useState(0);

  // 当前上下文（库 / schema）与下拉数据。
  const [activeDb, setActiveDb] = useState<string | null>(null);
  const [activeSchema, setActiveSchema] = useState<string | null>(null);
  const [databases, setDatabases] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [tables, setTables] = useState<string[]>([]);

  const [dialog, setDialog] = useState<{ cfg: ConnConfig | null } | null>(null);

  const caps = activeConn ? connected[activeConn] : null;
  const cfg = configs.find((c) => c.id === activeConn) ?? null;
  const showDb = Boolean(caps?.supports_use_database);
  const showSchema = Boolean(caps?.supports_schemas);

  // 该上下文下，构造表引用所需的库/schema。
  const refDatabase = showSchema ? (cfg?.database ?? null) : showDb ? activeDb : null;
  const refSchema = showSchema ? activeSchema : null;
  const listDatabase = showSchema ? (cfg?.database ?? "") : showDb ? (activeDb ?? "") : "main";

  // 连接切换：拉库 / schema 列表。
  useEffect(() => {
    if (!activeConn || !caps) {
      setDatabases([]);
      setSchemas([]);
      return;
    }
    if (caps.supports_use_database) {
      ipc.listDatabases(activeConn).then((l) => setDatabases(l.map((d) => d.name))).catch(() => setDatabases([]));
    } else if (caps.supports_schemas) {
      setDatabases(cfg?.database ? [cfg.database] : []);
    } else {
      setDatabases([]);
    }
    if (caps.supports_schemas) {
      ipc
        .listSchemas(activeConn, cfg?.database ?? "")
        .then((l) => {
          setSchemas(l);
          setActiveSchema((cur) => cur ?? (l.includes("public") ? "public" : l[0] ?? null));
        })
        .catch(() => setSchemas([]));
    } else {
      setSchemas([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConn, caps?.supports_use_database, caps?.supports_schemas]);

  // 上下文确定后，拉表列表填充工具栏「表」下拉。
  useEffect(() => {
    if (!activeConn || !caps) {
      setTables([]);
      return;
    }
    if (caps.supports_use_database && !activeDb) {
      setTables([]);
      return;
    }
    ipc
      .listTables(activeConn, listDatabase, refSchema)
      .then((l) => setTables(l.map((x) => x.name)))
      .catch(() => setTables([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConn, activeDb, activeSchema, caps?.supports_use_database, caps?.supports_schemas]);

  const selectConn = async (id: string) => {
    setError(null);
    setActiveConn(id);
    setActiveDb(null);
    setActiveSchema(null);
    if (!connected[id]) {
      try {
        const c = await ipc.connect(id);
        setConnected(id, c);
      } catch (e) {
        setError(errorMessage(e));
      }
    }
  };

  const openTable = async (connId: string, table: TableRef) => {
    setActiveConn(connId);
    setBrowseTable(table);
    if (table.database) setActiveDb(table.database);
    if (table.schema) setActiveSchema(table.schema);
    setPage(0);
    setError(null);
    try {
      const rs = await ipc.openTableData(connId, table, 0, PAGE_SIZE);
      setResult(rs);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const onSelectTable = (name: string) => {
    if (!activeConn) return;
    void openTable(activeConn, { database: refDatabase, schema: refSchema, name });
  };

  const runSql = async () => {
    if (!activeConn) {
      setError(t("editor.noConn"));
      return;
    }
    setRunning(true);
    setError(null);
    setBrowseTable(null);
    try {
      const results: RunResult[] = await ipc.runSql(
        activeConn,
        TAB_ID,
        sql,
        0,
        PAGE_SIZE,
        showDb ? activeDb : null,
      );
      const firstRows = results.find((r) => r.type === "rows") as (ResultSet & { type: "rows" }) | undefined;
      setResult(firstRows ?? null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };

  const cancelSql = async () => {
    if (!activeConn) return;
    // 取消当前脚本第一条语句（编辑器常见单语句场景）。
    await ipc.cancelQuery(activeConn, `${TAB_ID}:0`).catch(() => undefined);
  };

  const changePage = async (delta: number) => {
    if (!activeConn || !browseTable) return;
    const next = Math.max(0, page + delta);
    setPage(next);
    const rs = await ipc.openTableData(activeConn, browseTable, next, PAGE_SIZE);
    setResult(rs);
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
    <div className="flex h-screen w-screen flex-col bg-neutral-900 text-neutral-100">
      <header
        data-tauri-drag-region
        className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-800 bg-neutral-950 px-3"
      >
        <div className="flex items-center gap-2 pl-16">
          <div className="h-3.5 w-3.5 rounded-[4px] bg-gradient-to-br from-emerald-400 to-emerald-600" />
          <span className="text-xs font-semibold tracking-wide text-neutral-200">{t("app.title")}</span>
          <span className="text-[11px] text-neutral-600">{t("app.subtitle")}</span>
        </div>
        <div className="ml-auto">
          <Select value={i18n.language} onValueChange={setLanguage}>
            <SelectTrigger
              icon="ri-translate-2"
              className="h-6 w-auto gap-1 border-none bg-transparent px-1.5 text-neutral-300 hover:text-neutral-100"
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
        <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950/40">
          <ConnectionTree
            onOpenTable={openTable}
            onNewConnection={() => setDialog({ cfg: null })}
            onEditConnection={(c) => setDialog({ cfg: c })}
          />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <TopBar
            connections={connOptions}
            activeConn={activeConn}
            onSelectConn={selectConn}
            databases={databases}
            activeDb={activeDb}
            onSelectDb={setActiveDb}
            schemas={showSchema ? schemas : undefined}
            activeSchema={activeSchema}
            onSelectSchema={setActiveSchema}
            tables={tables}
            onSelectTable={onSelectTable}
            running={running}
            canRun={Boolean(activeConn)}
            onRun={runSql}
            onCancel={cancelSql}
          />
          <div className="h-2/5 min-h-[160px] border-b border-neutral-800">
            <SqlEditor value={sql} onChange={setSql} onRun={runSql} />
          </div>
          <div className="flex min-h-0 flex-1 flex-col p-2">
            {error && (
              <div className="mb-2 rounded-md border border-red-800/60 bg-red-950/50 px-3 py-2 text-sm text-red-300">
                {error}
              </div>
            )}
            {result ? (
              <ResultGrid result={result} onPrevPage={() => changePage(-1)} onNextPage={() => changePage(1)} />
            ) : (
              <div className="flex flex-1 items-center justify-center">
                <div className="text-center text-sm text-neutral-600">
                  <i className="ri-table-line mb-2 block text-3xl text-neutral-700" />
                  {t("grid.welcome")}
                </div>
              </div>
            )}
          </div>
        </main>
      </div>

      {dialog && <ConnectionDialog initial={dialog.cfg} onClose={() => setDialog(null)} onSaved={onSaved} />}
    </div>
  );
}
