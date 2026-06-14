// 导出任务进度状态：由 App 监听后端 `export:progress` 事件写入，浮层卡片读取。

import { create } from "zustand";
import type { ExportProgress } from "@/ipc/types";

export interface ExportTask {
  taskId: string;
  label: string;
  written: number;
  total: number | null;
  status: ExportProgress["status"];
  message: string | null;
}

interface ExportState {
  tasks: ExportTask[];
  /** 启动时立即登记一张卡片（后端首个事件到达前先显示）。 */
  begin: (taskId: string, label: string) => void;
  /** 收到进度事件后更新。 */
  apply: (p: ExportProgress) => void;
  remove: (taskId: string) => void;
}

export const useExports = create<ExportState>((set) => ({
  tasks: [],
  begin: (taskId, label) =>
    set((s) => {
      if (s.tasks.some((t) => t.taskId === taskId)) return s;
      return {
        tasks: [
          ...s.tasks,
          { taskId, label, written: 0, total: null, status: "running", message: null },
        ],
      };
    }),
  apply: (p) =>
    set((s) => {
      const idx = s.tasks.findIndex((t) => t.taskId === p.task_id);
      if (idx === -1) {
        return {
          tasks: [
            ...s.tasks,
            {
              taskId: p.task_id,
              label: "",
              written: p.written,
              total: p.total,
              status: p.status,
              message: p.message,
            },
          ],
        };
      }
      const tasks = s.tasks.slice();
      tasks[idx] = {
        ...tasks[idx],
        written: p.written,
        total: p.total,
        status: p.status,
        message: p.message,
      };
      return { tasks };
    }),
  remove: (taskId) => set((s) => ({ tasks: s.tasks.filter((t) => t.taskId !== taskId) })),
}));
