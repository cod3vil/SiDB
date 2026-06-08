import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ConnectionTree } from "@/components/tree/ConnectionTree";
import { ConnectionDialog } from "@/components/conn/ConnectionDialog";
import { SqlEditor } from "@/components/editor/SqlEditor";
import { ResultGrid } from "@/components/grid/ResultGrid";
import { ipc } from "@/ipc";
import type { ConnConfig, ResultSet, RunResult, TableRef } from "@/ipc/types";
import { useConnections } from "@/stores";
import { errorMessage } from "@/lib/error";

const PAGE_SIZE = 1000;

export default function App() {
  const { t } = useTranslation();
  const { setConfigs } = useConnections();
  const [activeConn, setActiveConn] = useState<string | null>(null);
  const [sql, setSql] = useState("SELECT 1;");
  const [result, setResult] = useState<ResultSet | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browseTable, setBrowseTable] = useState<TableRef | null>(null);
  const [page, setPage] = useState(0);

  // 连接对话框：null=关闭，{cfg}=编辑，{}=新建
  const [dialog, setDialog] = useState<{ cfg: ConnConfig | null } | null>(null);

  const openTable = async (connId: string, table: TableRef) => {
    setActiveConn(connId);
    setBrowseTable(table);
    setPage(0);
    setError(null);
    try {
      const rs = await ipc.openTableData(connId, table, 0, PAGE_SIZE);
      setResult(rs);
    } catch (e) {
      setError(errorMessage(e));
    }
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
      const results: RunResult[] = await ipc.runSql(activeConn, "tab-1", sql, 0, PAGE_SIZE);
      const firstRows = results.find((r) => r.type === "rows") as (ResultSet & { type: "rows" }) | undefined;
      setResult(firstRows ?? null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setRunning(false);
    }
  };

  const changePage = async (delta: number) => {
    if (!activeConn || !browseTable) return;
    const next = Math.max(0, page + delta);
    setPage(next);
    const rs = await ipc.openTableData(activeConn, browseTable, next, PAGE_SIZE);
    setResult(rs);
  };

  const onSaved = (cfg: ConnConfig) => {
    setDialog(null);
    ipc.listConnections().then(setConfigs).catch(() => undefined);
    void cfg;
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-neutral-900 text-neutral-100">
      {/* 顶部窗口栏（可拖拽） */}
      <header
        data-tauri-drag-region
        className="flex h-9 shrink-0 items-center gap-2 border-b border-neutral-800 bg-neutral-950 px-3"
      >
        <div className="flex items-center gap-2 pl-16">
          <div className="h-3.5 w-3.5 rounded-[4px] bg-gradient-to-br from-emerald-400 to-emerald-600" />
          <span className="text-xs font-semibold tracking-wide text-neutral-200">{t("app.title")}</span>
          <span className="text-[11px] text-neutral-600">{t("app.subtitle")}</span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左：连接 / 对象树 */}
        <aside className="flex w-64 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950/40">
          <ConnectionTree
            onOpenTable={(connId, table) => {
              setActiveConn(connId);
              void openTable(connId, table);
            }}
            onNewConnection={() => setDialog({ cfg: null })}
            onEditConnection={(cfg) => setDialog({ cfg })}
          />
        </aside>

        {/* 右：编辑器 + 结果 */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="h-2/5 min-h-[160px] border-b border-neutral-800">
            <SqlEditor value={sql} onChange={setSql} onRun={runSql} running={running} />
          </div>
          <div className="flex min-h-0 flex-1 flex-col p-2">
            {error && (
              <div className="mb-2 rounded-md border border-red-800/60 bg-red-950/50 px-3 py-2 text-sm text-red-300">
                {error}
              </div>
            )}
            {result ? (
              <ResultGrid
                result={result}
                onPrevPage={() => changePage(-1)}
                onNextPage={() => changePage(1)}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center">
                <div className="text-center text-sm text-neutral-600">
                  <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-neutral-800">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                      <path d="M4 6h16M4 12h16M4 18h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </div>
                  {t("grid.welcome")}
                </div>
              </div>
            )}
          </div>
        </main>
      </div>

      {dialog && (
        <ConnectionDialog initial={dialog.cfg} onClose={() => setDialog(null)} onSaved={onSaved} />
      )}
    </div>
  );
}
