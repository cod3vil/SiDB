import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ConnectionTree } from "@/components/tree/ConnectionTree";
import { SqlEditor } from "@/components/editor/SqlEditor";
import { ResultGrid } from "@/components/grid/ResultGrid";
import { ipc } from "@/ipc";
import type { ResultSet, RunResult, TableRef } from "@/ipc/types";
import { errorMessage } from "@/lib/error";

const PAGE_SIZE = 1000;

export default function App() {
  const { t } = useTranslation();
  const [activeConn, setActiveConn] = useState<string | null>(null);
  const [sql, setSql] = useState("SELECT 1;");
  const [result, setResult] = useState<ResultSet | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browseTable, setBrowseTable] = useState<TableRef | null>(null);
  const [page, setPage] = useState(0);

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
      setError("请先连接一个数据源");
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

  return (
    <div className="flex h-screen w-screen bg-neutral-900 text-neutral-100">
      {/* 左：对象树 */}
      <aside className="w-64 shrink-0 border-r border-neutral-800 flex flex-col">
        <div className="px-3 py-2 font-semibold border-b border-neutral-800">{t("app.title")}</div>
        <ConnectionTree
          onOpenTable={(connId, table) => {
            setActiveConn(connId);
            void openTable(connId, table);
          }}
        />
      </aside>

      {/* 右：编辑器 + 结果 */}
      <main className="flex-1 flex flex-col min-w-0">
        <div className="h-2/5 min-h-[160px] border-b border-neutral-800">
          <SqlEditor value={sql} onChange={setSql} onRun={runSql} running={running} />
        </div>
        <div className="flex-1 min-h-0 p-2">
          {error && (
            <div className="mb-2 px-3 py-2 text-sm bg-red-950 text-red-300 border border-red-800 rounded">
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
            <div className="text-neutral-500 text-sm p-4">
              双击左侧表打开数据，或在上方编辑器执行 SQL。
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
