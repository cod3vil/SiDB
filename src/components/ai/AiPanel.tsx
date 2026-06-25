// AI 对话侧栏：自然语言提问 → 后端 agent 工具循环 → 文本回答 + 工具步骤 + 写提案确认卡片。

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { errorMessage } from "@/lib/error";
import { toast } from "@/stores/toast";
import { useAi, activeMessages, type ChatTurn, type Conversation } from "@/stores/ai";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";

interface Props {
  width: number;
  connId: string | null;
  database: string | null;
  schema: string | null;
  table: string | null;
  /** 当前结果集快照：随提问发给 AI，使其能针对屏幕上的结果讨论。 */
  resultContext?: import("@/ipc/types").AiResultContext | null;
  onInsertSql: (sql: string) => void;
  onRunSql: (sql: string) => void;
  onConfirmWrite: (proposalId: string) => Promise<void>;
  onClose: () => void;
}

/** 助手文本按 markdown 渲染；SQL 代码块保留「插入/运行」按钮。 */
function Markdown({
  text,
  connId,
  onInsertSql,
  onRunSql,
}: {
  text: string;
  connId: string | null;
  onInsertSql: (sql: string) => void;
  onRunSql: (sql: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="md text-xs leading-relaxed text-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 解包 pre，让 code 渲染器自行决定块/行内样式。
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            const match = /language-(\w+)/.exec(className ?? "");
            const body = String(children).replace(/\n$/, "");
            const isBlock = Boolean(match) || body.includes("\n");
            if (!isBlock) {
              return (
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{children}</code>
              );
            }
            const lang = (match?.[1] ?? "").toLowerCase();
            const isSql = lang === "" || lang === "sql";
            return (
              <div className="my-1.5 overflow-hidden rounded-md border border-border bg-muted/50">
                <pre className="overflow-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-[11px] text-foreground">
                  {body}
                </pre>
                {isSql && (
                  <div className="flex justify-end gap-1 border-t border-border px-1.5 py-1">
                    <CodeBtn icon="ri-clipboard-line" label={t("ai.insert")} onClick={() => onInsertSql(body)} />
                    {connId && <CodeBtn icon="ri-play-line" label={t("ai.run")} onClick={() => onRunSql(body)} />}
                  </div>
                )}
              </div>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export function AiPanel({ width, connId, database, schema, table, resultContext, onInsertSql, onRunSql, onConfirmWrite, onClose }: Props) {
  const { t } = useTranslation();
  const messages = useAi(activeMessages);
  const busy = useAi((s) => s.busy);
  const ask = useAi((s) => s.ask);
  const conversations = useAi((s) => s.conversations);
  const activeId = useAi((s) => s.activeId);
  const newConversation = useAi((s) => s.newConversation);
  const selectConversation = useAi((s) => s.selectConversation);
  const deleteConversation = useAi((s) => s.deleteConversation);
  const clearConversations = useAi((s) => s.clearConversations);
  const [input, setInput] = useState("");
  const [confirmed, setConfirmed] = useState<Record<string, "done" | "busy">>({});
  const [historyOpen, setHistoryOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const send = async () => {
    const message = input.trim();
    if (!message || busy) return;
    if (!connId) {
      toast.error(t("ai.noConn"));
      return;
    }
    setInput("");
    await ask({ connId, database, schema, table, result: resultContext ?? null }, message);
  };

  const confirm = async (id: string) => {
    setConfirmed((c) => ({ ...c, [id]: "busy" }));
    try {
      await onConfirmWrite(id);
      setConfirmed((c) => ({ ...c, [id]: "done" }));
    } catch (e) {
      setConfirmed((c) => {
        const next = { ...c };
        delete next[id];
        return next;
      });
      toast.error(errorMessage(e));
    }
  };

  return (
    <aside style={{ width }} className="relative flex shrink-0 flex-col overflow-hidden border-l border-border bg-card/40">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <i className="ri-sparkling-2-line text-primary" />
        <span className="text-xs font-semibold text-foreground">{t("ai.title")}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={newConversation}
            title={t("ai.newChat")}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <i className="ri-chat-new-line text-sm" />
          </button>
          <button
            onClick={() => setHistoryOpen(true)}
            title={t("ai.history")}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <i className="ri-history-line text-sm" />
          </button>
          <button
            onClick={onClose}
            title={t("common.close")}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <i className="ri-close-line text-base" />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-auto px-3 py-3">
        {messages.length === 0 && (
          <div className="px-2 py-8 text-center text-xs text-muted-foreground/70">
            <i className="ri-sparkling-2-line mb-2 block text-2xl text-muted-foreground/40" />
            {t("ai.welcome")}
          </div>
        )}
        {messages.map((m, i) => (
          <Turn
            key={i}
            turn={m}
            connId={connId}
            confirmed={confirmed}
            onInsertSql={onInsertSql}
            onRunSql={onRunSql}
            onConfirm={confirm}
          />
        ))}
      </div>

      <div className="shrink-0 border-t border-border p-2">
        {resultContext && resultContext.columns.length > 0 && (
          <div className="mb-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <i className="ri-table-line text-primary" />
            {t("ai.resultAttached", {
              cols: resultContext.columns.length,
              rows: resultContext.rows.length,
            })}
          </div>
        )}
        <div className="flex items-end gap-1.5">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder={t("ai.placeholder")}
            className="flex-1 resize-none rounded-md border border-border bg-muted px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground/70 outline-none focus:border-primary"
          />
          <button
            onClick={() => void send()}
            disabled={busy || !input.trim()}
            title={t("ai.send")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
          >
            <i className={cn("text-base", busy ? "ri-loader-4-line animate-spin" : "ri-send-plane-2-line")} />
          </button>
        </div>
      </div>

      {historyOpen && (
        <HistoryDrawer
          conversations={conversations}
          activeId={activeId}
          onSelect={(id) => {
            selectConversation(id);
            setHistoryOpen(false);
          }}
          onDelete={deleteConversation}
          onClearAll={clearConversations}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </aside>
  );
}

/** 短时间戳：今天显示 HH:MM，否则显示 MM-DD HH:MM。 */
function shortTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

/** 历史对话抽屉：从右侧滑出，列出会话，点选切换、可删除。 */
function HistoryDrawer({
  conversations,
  activeId,
  onSelect,
  onDelete,
  onClearAll,
  onClose,
}: {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const items = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  return (
    <div className="absolute inset-0 z-20 flex" onClick={onClose}>
      <div className="flex-1 bg-black/40" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="ml-auto flex h-full w-[82%] max-w-[300px] flex-col border-l border-border bg-card shadow-2xl animate-in slide-in-from-right duration-200"
      >
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
          <i className="ri-history-line text-sm text-muted-foreground" />
          <span className="text-xs font-semibold text-foreground">{t("ai.history")}</span>
          <div className="ml-auto flex items-center gap-1">
            {items.length > 0 && (
              <button
                onClick={() => setConfirming(true)}
                title={t("ai.clearHistory")}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              >
                <i className="ri-delete-bin-line text-sm" />
              </button>
            )}
            <button
              onClick={onClose}
              title={t("common.close")}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <i className="ri-close-line text-base" />
            </button>
          </div>
        </div>
        {confirming && (
          <ConfirmDialog
            danger
            message={t("ai.clearHistoryConfirm", { n: items.length })}
            onCancel={() => setConfirming(false)}
            onConfirm={() => {
              setConfirming(false);
              onClearAll();
              onClose();
            }}
          />
        )}
        <div className="flex-1 overflow-auto p-1.5">
          {items.length === 0 ? (
            <div className="px-2 py-10 text-center text-xs text-muted-foreground/70">
              {t("ai.historyEmpty")}
            </div>
          ) : (
            items.map((c) => (
              <div
                key={c.id}
                onClick={() => onSelect(c.id)}
                className={cn(
                  "group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs",
                  c.id === activeId ? "bg-accent text-foreground" : "text-foreground hover:bg-accent/60",
                )}
              >
                <i className="ri-chat-1-line shrink-0 text-sm text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate" title={c.title}>
                    {c.title}
                  </div>
                  <div className="text-[10px] text-muted-foreground/70">{shortTime(c.updatedAt)}</div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(c.id);
                  }}
                  title={t("ai.deleteChat")}
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                >
                  <i className="ri-delete-bin-line text-xs" />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function Turn({
  turn,
  connId,
  confirmed,
  onInsertSql,
  onRunSql,
  onConfirm,
}: {
  turn: ChatTurn;
  connId: string | null;
  confirmed: Record<string, "done" | "busy">;
  onInsertSql: (sql: string) => void;
  onRunSql: (sql: string) => void;
  onConfirm: (id: string) => void;
}) {
  const { t } = useTranslation();

  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap rounded-lg rounded-br-sm bg-primary px-2.5 py-1.5 text-xs text-primary-foreground">
          {turn.text}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {turn.steps && turn.steps.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {turn.steps.map((s, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
              title={s.tool}
            >
              <i className="ri-tools-line" />
              {s.summary}
            </span>
          ))}
        </div>
      )}

      {turn.pending ? (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <i className="ri-loader-4-line animate-spin" />
          {t("ai.thinking")}
        </div>
      ) : (
        turn.text && (
          <Markdown text={turn.text} connId={connId} onInsertSql={onInsertSql} onRunSql={onRunSql} />
        )
      )}

      {turn.proposals?.map((p) => {
        const state = confirmed[p.id];
        return (
          <div key={p.id} className="overflow-hidden rounded-md border border-amber-500/40 bg-amber-500/5">
            <div className="flex items-center gap-1.5 border-b border-amber-500/30 px-2.5 py-1 text-[11px] font-medium text-amber-600 dark:text-amber-400">
              <i className="ri-alert-line" />
              {t("ai.writeProposal")}
            </div>
            <pre className="overflow-auto px-2.5 py-2 font-mono text-[11px] text-foreground whitespace-pre-wrap">
              {p.sql}
            </pre>
            <div className="flex justify-end border-t border-amber-500/30 px-1.5 py-1">
              <button
                onClick={() => onConfirm(p.id)}
                disabled={Boolean(state)}
                className="inline-flex items-center gap-1 rounded bg-amber-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-amber-500 disabled:opacity-50"
              >
                {state === "done" ? (
                  <>
                    <i className="ri-check-line" />
                    {t("ai.executed")}
                  </>
                ) : state === "busy" ? (
                  <>
                    <i className="ri-loader-4-line animate-spin" />
                    {t("ai.executing")}
                  </>
                ) : (
                  <>
                    <i className="ri-play-line" />
                    {t("ai.confirmWrite")}
                  </>
                )}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CodeBtn({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <i className={icon} />
      {label}
    </button>
  );
}
