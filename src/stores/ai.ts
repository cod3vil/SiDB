// AI 对话面板状态：开关 + 消息列表 + 发送。历史由前端内存持有（后端无状态）。
// send 逻辑集中在此，供面板输入框与编辑器内联动作（解释/优化/修复）共用。

import { create } from "zustand";
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

/** 当前查询上下文（提问时随附给后端）。 */
export interface AskCtx {
  connId: string | null;
  database: string | null;
  schema: string | null;
  /** 界面选中的表；未指明表名时默认只在该表操作。 */
  table: string | null;
}

interface AiState {
  open: boolean;
  busy: boolean;
  messages: ChatTurn[];
  setOpen: (open: boolean) => void;
  toggle: () => void;
  clear: () => void;
  /** 发送一条消息（面板输入框 / 内联动作共用）。无连接时静默忽略，由调用方先校验。 */
  ask: (ctx: AskCtx, message: string) => Promise<void>;
}

export const useAi = create<AiState>((set, get) => ({
  open: true,
  busy: false,
  messages: [],
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
  clear: () => set({ messages: [] }),
  ask: async (ctx, message) => {
    if (get().busy || !message.trim()) return;
    const history: AiChatMsg[] = get()
      .messages.filter((m) => !m.pending)
      .map((m) => ({ role: m.role, text: m.text }));
    set((s) => ({
      busy: true,
      messages: [
        ...s.messages,
        { role: "user", text: message },
        { role: "assistant", text: "", pending: true },
      ],
    }));
    const patchLast = (patch: Partial<ChatTurn>) =>
      set((s) => {
        if (s.messages.length === 0) return s;
        const messages = s.messages.slice();
        messages[messages.length - 1] = { ...messages[messages.length - 1], ...patch };
        return { messages };
      });
    try {
      const res = await ipc.aiChat({
        conn_id: ctx.connId ?? "",
        database: ctx.database,
        schema: ctx.schema,
        table: ctx.table,
        history,
        message,
      });
      patchLast({ text: res.reply, steps: res.steps, proposals: res.proposals, pending: false });
    } catch (e) {
      patchLast({ text: "", pending: false });
      toast.error(errorMessage(e));
    } finally {
      set({ busy: false });
    }
  },
}));
