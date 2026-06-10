// AI 对话侧栏：自然语言提问 → 后端 agent 工具循环 → 文本回答 + 工具步骤 + 写提案确认卡片。

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { errorMessage } from "@/lib/error";
import { toast } from "@/stores/toast";
import { useAi, type ChatTurn } from "@/stores/ai";
import { cn } from "@/lib/utils";

interface Props {
  width: number;
  connId: string | null;
  database: string | null;
  schema: string | null;
  table: string | null;
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

export function AiPanel({ width, connId, database, schema, table, onInsertSql, onRunSql, onConfirmWrite, onClose }: Props) {
  const { t } = useTranslation();
  const { messages, busy, clear, ask } = useAi();
  const [input, setInput] = useState("");
  const [confirmed, setConfirmed] = useState<Record<string, "done" | "busy">>({});
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
    await ask({ connId, database, schema, table }, message);
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
    <aside style={{ width }} className="flex shrink-0 flex-col border-l border-border bg-card/40">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <i className="ri-sparkling-2-line text-primary" />
        <span className="text-xs font-semibold text-foreground">{t("ai.title")}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={clear}
            title={t("ai.clear")}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <i className="ri-delete-bin-line text-sm" />
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
        <div className="flex items-end gap-1.5">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
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
    </aside>
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
