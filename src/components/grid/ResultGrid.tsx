// 结果表格（TDD §9 / PRD §3.4）：虚拟滚动 + 分页 + 可拖拽列宽 + NULL/Bytes/JSON 渲染。

import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import type { ResultSet } from "@/ipc/types";
import { renderValue } from "@/lib/value";

interface Props {
  result: ResultSet;
  /** 跳转到指定页（0-based）。未提供则禁用分页（如查询结果）。 */
  onGoto?: (page: number) => void;
}

const ROW_HEIGHT = 28;
const DEFAULT_W = 160;
const MIN_W = 56;

export function ResultGrid({ result, onGoto }: Props) {
  const { t } = useTranslation();
  const parentRef = useRef<HTMLDivElement>(null);
  const page = result.page.page;
  const pageSize = result.page.page_size;
  const total = result.total_hint;
  const totalPages = total != null ? Math.max(1, Math.ceil(total / pageSize)) : null;
  const [pageInput, setPageInput] = useState(String(page + 1));
  useEffect(() => setPageInput(String(page + 1)), [page]);

  const goto = (n: number) => {
    if (!onGoto) return;
    const clamped = Math.max(0, totalPages != null ? Math.min(n, totalPages - 1) : n);
    onGoto(clamped);
  };
  const commitInput = () => {
    const n = parseInt(pageInput, 10);
    if (isNaN(n) || n < 1) {
      setPageInput(String(page + 1));
      return;
    }
    goto(n - 1);
  };
  const atFirst = page === 0;
  const atLast = totalPages != null ? page >= totalPages - 1 : !result.page.has_more;

  // 列宽（像素）。仅当列集合变化时重置，翻页/改单元格不影响已调整的宽度。
  const colSig = result.columns.map((c) => c.name).join("");
  const [widths, setWidths] = useState<number[]>(() => result.columns.map(() => DEFAULT_W));
  useEffect(() => {
    setWidths(result.columns.map(() => DEFAULT_W));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colSig]);

  const drag = useRef<{ i: number; startX: number; startW: number } | null>(null);
  const startResize = (i: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { i, startX: e.clientX, startW: widths[i] ?? DEFAULT_W };
    const onMove = (ev: MouseEvent) => {
      const d = drag.current;
      if (!d) return;
      const w = Math.max(MIN_W, d.startW + (ev.clientX - d.startX));
      setWidths((prev) => {
        const next = [...prev];
        next[d.i] = w;
        return next;
      });
    };
    const onUp = () => {
      drag.current = null;
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

  const widthOf = (i: number) => widths[i] ?? DEFAULT_W;
  const totalWidth = result.columns.reduce((sum, _c, i) => sum + widthOf(i), 0);

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
      <div ref={parentRef} className="flex-1 overflow-auto border border-border">
        {/* header */}
        <div
          className="flex sticky top-0 z-10 bg-muted text-xs font-semibold text-foreground"
          style={{ height: ROW_HEIGHT, width: totalWidth }}
        >
          {result.columns.map((c, i) => (
            <div
              key={c.name}
              className="relative flex items-center border-r border-border px-2 whitespace-nowrap"
              style={{ width: widthOf(i) }}
              title={`${c.db_type}${c.is_primary_key ? " (PK)" : ""}`}
            >
              <span className="truncate">
                {c.is_primary_key ? "🔑 " : ""}
                {c.name}
              </span>
              {/* 拖拽手柄 */}
              <span
                onMouseDown={(e) => startResize(i, e)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setWidths((prev) => {
                    const next = [...prev];
                    next[i] = DEFAULT_W;
                    return next;
                  });
                }}
                className="absolute right-0 top-0 h-full w-1.5 translate-x-1/2 cursor-col-resize hover:bg-emerald-500/60"
                title={t("grid.resizeHint")}
              />
            </div>
          ))}
        </div>
        {/* virtual rows */}
        <div style={{ height: rowVirtualizer.getTotalSize(), width: totalWidth, position: "relative" }}>
          {rowVirtualizer.getVirtualItems().map((vrow) => {
            const row = result.rows[vrow.index];
            return (
              <div
                key={vrow.key}
                className="absolute left-0 flex text-xs font-mono hover:bg-accent/50"
                style={{ height: ROW_HEIGHT, width: totalWidth, transform: `translateY(${vrow.start}px)` }}
              >
                {row.map((v, ci) => {
                  const r = renderValue(v);
                  return (
                    <div
                      key={ci}
                      className={`flex items-center border-r border-b border-border px-2 truncate ${
                        r.isNull ? "text-muted-foreground italic" : ""
                      } ${r.isBytes || r.isJson ? "text-sky-400" : ""}`}
                      style={{ width: widthOf(ci) }}
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
      <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground bg-background border-t border-border">
        <div className="flex items-center gap-0.5">
          <PageBtn icon="ri-skip-back-mini-line" title={t("grid.first")} disabled={!onGoto || atFirst} onClick={() => goto(0)} />
          <PageBtn icon="ri-arrow-left-s-line" title={t("grid.prev")} disabled={!onGoto || atFirst} onClick={() => goto(page - 1)} />
          <input
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && commitInput()}
            onBlur={commitInput}
            disabled={!onGoto}
            className="h-5 w-10 rounded border border-border bg-card text-center text-xs text-foreground outline-none focus:border-ring disabled:opacity-50"
          />
          {totalPages != null && <span className="text-muted-foreground/70">/ {totalPages}</span>}
          <PageBtn icon="ri-arrow-right-s-line" title={t("grid.next")} disabled={!onGoto || atLast} onClick={() => goto(page + 1)} />
          <PageBtn
            icon="ri-skip-forward-mini-line"
            title={t("grid.last")}
            disabled={!onGoto || totalPages == null || atLast}
            onClick={() => totalPages != null && goto(totalPages - 1)}
          />
        </div>
        <span className="ml-1">{t("grid.page", { from, to })}</span>
        {total != null && <span>· {t("grid.totalRows", { n: total })}</span>}
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

function PageBtn({
  icon,
  title,
  disabled,
  onClick,
}: {
  icon: string;
  title: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
    >
      <i className={`${icon} text-base`} />
    </button>
  );
}
