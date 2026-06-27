// AI 对话面板状态：开关 + 多会话（历史）+ 发送。
// 会话历史持久化到 localStorage（后端无状态，整段历史每次随请求上送）。
// send 逻辑集中在此，供面板输入框与编辑器内联动作（解释/优化/修复）共用。

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { ipc } from "@/ipc";
import type { AiChatMsg, ProposalDto, ToolStep } from "@/ipc/types";
import { errorMessage } from "@/lib/error";
import { toast } from "@/stores/toast";

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  steps?: ToolStep[];
  proposals?: ProposalDto[];
  /** 助手占位：等待响应中。 */
  pending?: boolean;
}

/** 一段会话（历史的一项）。 */
export interface Conversation {
  id: string;
  title: string;
  messages: ChatTurn[];
  createdAt: number;
  updatedAt: number;
}

/** 当前查询上下文（提问时随附给后端）。 */
export interface AskCtx {
  connId: string | null;
  database: string | null;
  schema: string | null;
  /** 界面选中的表；未指明表名时默认只在该表操作。 */
  table: string | null;
  /** 当前结果集快照（可选）：让 AI 能直接针对屏幕上的结果讨论。 */
  result?: import("@/ipc/types").AiResultContext | null;
}

interface AiState {
  open: boolean;
  busy: boolean;
  conversations: Conversation[];
  /** 当前会话 id；null 表示「新对话」草稿（尚未产生消息）。 */
  activeId: string | null;
  /** 在途请求的连接 id（取消时用）；不持久化。 */
  _reqConn: string | null;
  /** 本次请求是否已被用户取消；不持久化。 */
  _cancelled: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
  /** 新开一个空对话（保留历史，仅切到草稿态）。 */
  newConversation: () => void;
  /** 切换到某段历史会话。 */
  selectConversation: (id: string) => void;
  /** 删除某段历史会话。 */
  deleteConversation: (id: string) => void;
  /** 清空全部历史会话。 */
  clearConversations: () => void;
  /** 发送一条消息（面板输入框 / 内联动作共用）。无连接时静默忽略，由调用方先校验。 */
  ask: (ctx: AskCtx, message: string) => Promise<void>;
  /** 中止进行中的 AI 请求。 */
  cancel: () => void;
}

/** 稳定的空数组引用：避免 useSyncExternalStore 因每次新建 `[]` 而反复触发渲染。 */
const EMPTY: ChatTurn[] = [];

/** 当前活动会话的消息列表（无活动会话则为空）。 */
export function activeMessages(s: AiState): ChatTurn[] {
  if (!s.activeId) return EMPTY;
  return s.conversations.find((c) => c.id === s.activeId)?.messages ?? EMPTY;
}

/** 用首条消息派生标题（截断）。 */
function deriveTitle(message: string): string {
  const t = message.trim().replace(/\s+/g, " ");
  return t.length > 30 ? `${t.slice(0, 30)}…` : t || "…";
}

function newId(): string {
  return crypto.randomUUID();
}

export const useAi = create<AiState>()(
  persist(
    (set, get) => ({
      open: true,
      busy: false,
      conversations: [],
      activeId: null,
      _reqConn: null,
      _cancelled: false,
      setOpen: (open) => set({ open }),
      toggle: () => set((s) => ({ open: !s.open })),
      newConversation: () =>
        // 清理仍为空的会话，切回草稿态。
        set((s) => ({
          conversations: s.conversations.filter((c) => c.messages.length > 0),
          activeId: null,
        })),
      selectConversation: (id) => set({ activeId: id }),
      clearConversations: () => set({ conversations: [], activeId: null }),
      deleteConversation: (id) =>
        set((s) => ({
          conversations: s.conversations.filter((c) => c.id !== id),
          activeId: s.activeId === id ? null : s.activeId,
        })),
      ask: async (ctx, message) => {
        if (get().busy || !message.trim()) return;

        // 确定/创建当前会话。
        let id = get().activeId;
        const existing = id ? get().conversations.find((c) => c.id === id) : undefined;
        if (!existing) {
          id = newId();
          const now = Date.now();
          const conv: Conversation = {
            id,
            title: deriveTitle(message),
            messages: [],
            createdAt: now,
            updatedAt: now,
          };
          set((s) => ({ conversations: [conv, ...s.conversations], activeId: id }));
        }
        const convId = id as string;

        // 仅对当前会话消息做变更。
        const patchMessages = (fn: (m: ChatTurn[]) => ChatTurn[]) =>
          set((s) => ({
            conversations: s.conversations.map((c) =>
              c.id === convId ? { ...c, messages: fn(c.messages), updatedAt: Date.now() } : c,
            ),
          }));

        const history: AiChatMsg[] = activeMessages(get())
          .filter((m) => !m.pending)
          .map((m) => ({ role: m.role, text: m.text }));

        patchMessages((ms) => [
          ...ms,
          { role: "user", text: message },
          { role: "assistant", text: "", pending: true },
        ]);
        // 记录在途连接 + 重置取消标记（供 cancel 调用后端并抑制取消引发的错误提示）。
        set({ busy: true, _reqConn: ctx.connId ?? "", _cancelled: false });

        const patchLast = (patch: Partial<ChatTurn>) =>
          patchMessages((ms) => {
            if (ms.length === 0) return ms;
            const next = ms.slice();
            next[next.length - 1] = { ...next[next.length - 1], ...patch };
            return next;
          });

        try {
          const res = await ipc.aiChat({
            conn_id: ctx.connId ?? "",
            database: ctx.database,
            schema: ctx.schema,
            table: ctx.table,
            history,
            message,
            result: ctx.result ?? null,
          });
          if (get()._cancelled) {
            // 已取消：丢弃迟到的结果，移除 pending 占位气泡。
            patchMessages((ms) => ms.filter((m) => !m.pending));
          } else {
            patchLast({ text: res.reply, steps: res.steps, proposals: res.proposals, pending: false });
          }
        } catch (e) {
          if (get()._cancelled) {
            patchMessages((ms) => ms.filter((m) => !m.pending));
          } else {
            patchLast({ text: "", pending: false });
            toast.error(errorMessage(e));
          }
        } finally {
          set({ busy: false, _reqConn: null });
        }
      },
      cancel: () => {
        const conn = get()._reqConn;
        if (!get().busy || !conn) return;
        set({ _cancelled: true, busy: false });
        void ipc.aiCancel(conn).catch(() => undefined);
      },
    }),
    {
      name: "sidb-ai",
      // 仅持久化历史与开关；不存 busy；剥离未完成的 pending 占位，避免重载后卡住转圈。
      partialize: (s) => ({
        open: s.open,
        activeId: s.activeId,
        conversations: s.conversations.map((c) => ({
          ...c,
          messages: c.messages.filter((m) => !m.pending),
        })),
      }),
    },
  ),
);
