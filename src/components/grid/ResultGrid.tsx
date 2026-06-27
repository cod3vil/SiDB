// 结果表格（TDD §9 / PRD §3.4）：虚拟滚动 + 分页 + 可拖拽列宽 + NULL/Bytes/JSON 渲染。

import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import type { Change, ChangeSet, ResultSet, TableRef, Value } from "@/ipc/types";
import { editText, parseValue, renderValue } from "@/lib/value";
import { cn } from "@/lib/utils";

interface Props {
  result: ResultSet;
  /** 跳转到指定页（0-based）。未提供则禁用分页（如查询结果）。 */
  onGoto?: (page: number) => void;
  /** 浏览表时的表引用 + 提交回调；提供且结果可编辑时支持双击编辑。 */
  table?: TableRef | null;
  onCommit?: (cs: ChangeSet) => Promise<void> | void;
  /** 点击「导出」：由上层打开导出弹窗（带当前 tab 上下文）。 */
  onExport?: () => void;
  /** 点击「问 AI」：把当前结果集喂给 AI 侧栏讨论。 */
  onAskAi?: () => void;
  /** 表浏览快捷排序：当前排序列 / 方向 + 点列头回调（仅浏览模式提供，服务端重查）。 */
  sortColumn?: string | null;
  sortAsc?: boolean;
  onSort?: (col: string) => void;
}

const ROW_HEIGHT = 28;
const DEFAULT_W = 160;
const MIN_W = 56;

export function ResultGrid({ result, onGoto, table, onCommit, onExport, onAskAi, sortColumn, sortAsc, onSort }: Props) {
  const { t } = useTranslation();
  const parentRef = useRef<HTMLDivElement>(null);

  // ---- 编辑 ----
  const NULL_V: Value = { t: "Null" };
  const existingCount = result.rows.length;
  const rowIdColumns = result.editable.kind === "Editable" ? result.editable.row_id_columns : [];
  const editable = Boolean(table && onCommit) && result.editable.kind === "Editable";
  // 既有行的单元格编辑：key=`${rowIndex}:${colName}` → 新值
  const [edits, setEdits] = useState<Record<string, Value>>({});
  const [newRows, setNewRows] = useState<Record<string, Value>[]>([]); // 待插入
  const [deletedRows, setDeletedRows] = useState<Set<number>>(new Set()); // 待删除（既有行下标）
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [editing, setEditing] = useState<{ row: number; col: string } | null>(null);
  const [editStr, setEditStr] = useState("");
  const [committing, setCommitting] = useState(false);
  useEffect(() => {
    // 结果变化（翻页/重查/提交后刷新）→ 清空未保存改动。
    setEdits({});
    setNewRows([]);
    setDeletedRows(new Set());
    setSelectedRow(null);
    setEditing(null);
  }, [result]);

  const cellOf = (vi: number, ci: number, colName: string): Value => {
    if (vi >= existingCount) return newRows[vi - existingCount]?.[colName] ?? NULL_V;
    const k = `${vi}:${colName}`;
    return k in edits ? edits[k] : result.rows[vi][ci];
  };

  const startEdit = (row: number, col: string, v: Value) => {
    if (!editable || v.t === "Bytes") return;
    setEditing({ row, col });
    setEditStr(editText(v));
  };
  const commitEdit = (kind: string) => {
    if (!editing) return;
    const { row, col } = editing;
    const val = parseValue(editStr, kind);
    if (row >= existingCount) {
      const j = row - existingCount;
      setNewRows((rs) => rs.map((r, i) => (i === j ? { ...r, [col]: val } : r)));
    } else {
      // 与原值比较：未改动则不记（并撤销该格可能存在的旧编辑），避免空提交。
      const ci = result.columns.findIndex((c) => c.name === col);
      const original = ci >= 0 ? result.rows[row]?.[ci] : undefined;
      const unchanged = original !== undefined && editText(original) === editStr;
      const key = `${row}:${col}`;
      setEdits((prev) => {
        if (unchanged) {
          if (!(key in prev)) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        }
        return { ...prev, [key]: val };
      });
    }
    setEditing(null);
  };

  const addRow = () => {
    setNewRows((rs) => [...rs, {}]);
    setSelectedRow(existingCount + newRows.length);
  };
  const deleteSelected = () => {
    if (selectedRow == null) return;
    if (selectedRow >= existingCount) {
      const j = selectedRow - existingCount;
      setNewRows((rs) => rs.filter((_, i) => i !== j));
      setSelectedRow(null);
    } else {
      setDeletedRows((s) => {
        const n = new Set(s);
        if (n.has(selectedRow)) n.delete(selectedRow);
        else n.add(selectedRow);
        return n;
      });
    }
  };

  const pkOf = (rowIdx: number): Record<string, Value> => {
    const row = result.rows[rowIdx];
    const key: Record<string, Value> = {};
    for (const pk of rowIdColumns) {
      const ci = result.columns.findIndex((c) => c.name === pk);
      if (ci >= 0) key[pk] = row[ci];
    }
    return key;
  };

  const submit = async () => {
    if (!table || !onCommit) return;
    const changes: Change[] = [];
    // 更新（既有、未删除行）
    const byRow = new Map<number, Record<string, Value>>();
    for (const [k, val] of Object.entries(edits)) {
      const idx = k.indexOf(":");
      const r = Number(k.slice(0, idx));
      if (deletedRows.has(r)) continue;
      const col = k.slice(idx + 1);
      if (!byRow.has(r)) byRow.set(r, {});
      byRow.get(r)![col] = val;
    }
    for (const [rowIdx, set] of byRow) changes.push({ type: "update", key: pkOf(rowIdx), set });
    // 删除
    for (const r of deletedRows) changes.push({ type: "delete", key: pkOf(r) });
    // 插入（至少设了一列）
    for (const nr of newRows) {
      if (Object.keys(nr).length) changes.push({ type: "insert", values: nr });
    }
    if (changes.length === 0) return;
    setCommitting(true);
    try {
      await onCommit({ table, row_id_columns: rowIdColumns, changes });
    } catch {
      // 提交失败：保留改动，错误由上层展示。
    } finally {
      setCommitting(false);
    }
  };

  const dirtyCount =
    Object.keys(edits).filter((k) => !deletedRows.has(Number(k.slice(0, k.indexOf(":"))))).length +
    deletedRows.size +
    newRows.filter((r) => Object.keys(r).length).length;

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

  const rowCount = existingCount + newRows.length;
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const readOnly = result.editable.kind === "ReadOnly";
  const from = result.page.offset;
  const to = result.page.offset + result.page.returned - 1;

  return (
    <div className="flex flex-col h-full">
      <div ref={parentRef} className="relative flex-1 overflow-auto border border-border">
        {/* header */}
        <div
          className="flex sticky top-0 z-10 bg-muted text-xs font-semibold text-foreground"
          style={{ height: ROW_HEIGHT, width: totalWidth }}
        >
          {result.columns.map((c, i) => {
            const sorted = sortColumn === c.name;
            return (
            <div
              key={c.name}
              className={cn(
                "relative flex items-center gap-1 border-r border-border px-2 whitespace-nowrap",
                onSort && "cursor-pointer select-none hover:bg-accent/60",
              )}
              style={{ width: widthOf(i) }}
              title={`${c.db_type}${c.is_primary_key ? " (PK)" : ""}`}
              onClick={onSort ? () => onSort(c.name) : undefined}
            >
              {c.is_primary_key && (
                <i className="ri-key-2-fill shrink-0 text-[12px] text-amber-500" title="PRIMARY KEY" />
              )}
              <span className="truncate">{c.name}</span>
              {sorted && (
                <i className={cn("shrink-0 text-[12px] text-primary", sortAsc ? "ri-arrow-up-s-line" : "ri-arrow-down-s-line")} />
              )}
              {/* 拖拽手柄（阻止冒泡，避免触发列头排序） */}
              <span
                onMouseDown={(e) => startResize(i, e)}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  setWidths((prev) => {
                    const next = [...prev];
                    next[i] = DEFAULT_W;
                    return next;
                  });
                }}
                className="absolute right-0 top-0 h-full w-1.5 translate-x-1/2 cursor-col-resize hover:bg-primary/60"
                title={t("grid.resizeHint")}
              />
            </div>
            );
          })}
        </div>
        {/* virtual rows */}
        <div style={{ height: rowVirtualizer.getTotalSize(), width: totalWidth, position: "relative" }}>
          {rowVirtualizer.getVirtualItems().map((vrow) => {
            const vi = vrow.index;
            const isNew = vi >= existingCount;
            const isDeleted = !isNew && deletedRows.has(vi);
            const isSelected = selectedRow === vi;
            return (
              <div
                key={vrow.key}
                onClick={() => editable && setSelectedRow(vi)}
                className={cn(
                  "absolute left-0 flex text-xs font-mono",
                  isDeleted && "bg-destructive/10 line-through opacity-60",
                  isNew && "bg-emerald-500/5",
                  isSelected && "ring-1 ring-inset ring-primary/60",
                  !isDeleted && !isNew && "hover:bg-accent/50",
                )}
                style={{ height: ROW_HEIGHT, width: totalWidth, transform: `translateY(${vrow.start}px)` }}
              >
                {result.columns.map((col, ci) => {
                  const cur = cellOf(vi, ci, col.name);
                  const edited = !isNew && `${vi}:${col.name}` in edits;
                  const r = renderValue(cur);
                  const isEditing = editing?.row === vi && editing?.col === col.name;
                  return (
                    <div
                      key={ci}
                      className={cn(
                        "flex items-center border-r border-b border-border px-2 truncate",
                        r.isNull && "text-muted-foreground italic",
                        (r.isBytes || r.isJson) && "text-sky-400",
                        edited && "bg-primary/15",
                        editable && !isDeleted && "cursor-text",
                      )}
                      style={{ width: widthOf(ci) }}
                      title={r.text}
                      onDoubleClick={() => !isDeleted && startEdit(vi, col.name, cur)}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          autoCapitalize="off"
                          autoCorrect="off"
                          spellCheck={false}
                          value={editStr}
                          onChange={(e) => setEditStr(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitEdit(col.value_kind);
                            else if (e.key === "Escape") setEditing(null);
                          }}
                          onBlur={() => commitEdit(col.value_kind)}
                          className="w-full bg-background px-0.5 text-foreground outline-none ring-1 ring-primary"
                        />
                      ) : r.isNull ? (
                        t("grid.null")
                      ) : (
                        r.text
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        {/* 空结果：列头保留，中间提示无数据 */}
        {rowCount === 0 && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground/60">
            <i className="ri-inbox-2-line text-3xl text-muted-foreground/30" />
            {t("grid.empty")}
          </div>
        )}
      </div>
      {/* status bar */}
      <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground bg-background border-t border-border">
        {editable && (
          <div className="flex items-center gap-0.5">
            <PageBtn icon="ri-add-line" title={t("edit.addRow")} onClick={addRow} />
            <PageBtn
              icon="ri-subtract-line"
              title={t("edit.deleteRow")}
              disabled={selectedRow == null}
              onClick={deleteSelected}
            />
            <span className="mx-0.5 h-4 w-px bg-border" />
          </div>
        )}
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
        <div className="ml-auto flex items-center gap-3">
          {onAskAi && (
            <button
              onClick={onAskAi}
              title={t("grid.askAi")}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-accent hover:text-foreground"
            >
              <i className="ri-sparkling-2-line text-primary" />
              {t("grid.askAi")}
            </button>
          )}
          {onExport && (
            <button
              onClick={onExport}
              title={t("grid.export")}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-accent hover:text-foreground"
            >
              <i className="ri-download-2-line" />
              {t("grid.export")}
            </button>
          )}
          {editable && dirtyCount > 0 && (
            <button
              onClick={submit}
              disabled={committing}
              className="flex items-center gap-1 rounded bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <i className="ri-check-line" />
              {t("edit.commit")} ({dirtyCount})
            </button>
          )}
          <span>{result.elapsed_ms} ms</span>
          {readOnly && (
            <span className="text-amber-500">
              {t("grid.readOnly", { reason: (result.editable as { reason: string }).reason })}
            </span>
          )}
        </div>
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
