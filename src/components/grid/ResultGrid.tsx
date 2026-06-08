// 结果表格（TDD §9 / PRD §3.4）：虚拟滚动 + 分页 + NULL/Bytes/JSON 渲染。

import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import type { ResultSet } from "@/ipc/types";
import { renderValue } from "@/lib/value";

interface Props {
  result: ResultSet;
  onPrevPage?: () => void;
  onNextPage?: () => void;
}

const ROW_HEIGHT = 28;

export function ResultGrid({ result, onPrevPage, onNextPage }: Props) {
  const { t } = useTranslation();
  const parentRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: result.rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const readOnly = result.editable.kind === "ReadOnly";
  const from = result.page.offset;
  const to = result.page.offset + result.page.returned - 1;

  return (
    <div className="flex flex-col h-full">
      <div ref={parentRef} className="flex-1 overflow-auto border border-neutral-700">
        {/* header */}
        <div
          className="flex sticky top-0 bg-neutral-800 text-neutral-200 text-xs font-semibold z-10"
          style={{ height: ROW_HEIGHT }}
        >
          {result.columns.map((c) => (
            <div
              key={c.name}
              className="px-2 py-1 border-r border-neutral-700 whitespace-nowrap min-w-[120px]"
              title={`${c.db_type}${c.is_primary_key ? " (PK)" : ""}`}
            >
              {c.is_primary_key ? "🔑 " : ""}
              {c.name}
            </div>
          ))}
        </div>
        {/* virtual rows */}
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
          {rowVirtualizer.getVirtualItems().map((vrow) => {
            const row = result.rows[vrow.index];
            return (
              <div
                key={vrow.key}
                className="flex absolute left-0 w-full text-xs font-mono hover:bg-neutral-800/50"
                style={{ height: ROW_HEIGHT, transform: `translateY(${vrow.start}px)` }}
              >
                {row.map((v, ci) => {
                  const r = renderValue(v);
                  return (
                    <div
                      key={ci}
                      className={`px-2 py-1 border-r border-b border-neutral-800 truncate min-w-[120px] ${
                        r.isNull ? "text-neutral-500 italic" : ""
                      } ${r.isBytes || r.isJson ? "text-sky-400" : ""}`}
                      title={r.text}
                    >
                      {r.isNull ? t("grid.null") : r.text}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {/* status bar */}
      <div className="flex items-center gap-3 px-2 py-1 text-xs text-neutral-400 bg-neutral-900 border-t border-neutral-800">
        <span>{t("grid.page", { from, to })}</span>
        <button className="px-2 hover:text-white disabled:opacity-40" onClick={onPrevPage} disabled={result.page.page === 0}>
          {t("grid.prev")}
        </button>
        <button className="px-2 hover:text-white disabled:opacity-40" onClick={onNextPage} disabled={!result.page.has_more}>
          {t("grid.next")}
        </button>
        <span className="ml-auto">{result.elapsed_ms} ms</span>
        {readOnly && (
          <span className="text-amber-500">
            {t("grid.readOnly", { reason: (result.editable as { reason: string }).reason })}
          </span>
        )}
      </div>
    </div>
  );
}
