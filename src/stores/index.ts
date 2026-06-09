// zustand 状态分区（TDD §9）。

import { create } from "zustand";
import type {
  ConnConfig,
  DbCapabilities,
  ResultSet,
  TableRef,
  Value,
} from "@/ipc/types";

// ---- connectionsStore：配置 + 连接状态 ------------------------------------

interface ConnectionsState {
  configs: ConnConfig[];
  connected: Record<string, DbCapabilities>; // connId -> caps
  activeConnId: string | null;
  /** 递增触发对象树重新拉取（建库/建表后调用）。 */
  treeVersion: number;
  setConfigs: (c: ConnConfig[]) => void;
  setConnected: (id: string, caps: DbCapabilities) => void;
  setDisconnected: (id: string) => void;
  setActive: (id: string | null) => void;
  bumpTree: () => void;
}

export const useConnections = create<ConnectionsState>((set) => ({
  configs: [],
  connected: {},
  activeConnId: null,
  treeVersion: 0,
  setConfigs: (configs) => set({ configs }),
  setConnected: (id, caps) =>
    set((s) => ({ connected: { ...s.connected, [id]: caps }, activeConnId: id })),
  setDisconnected: (id) =>
    set((s) => {
      const next = { ...s.connected };
      delete next[id];
      return { connected: next };
    }),
  setActive: (activeConnId) => set({ activeConnId }),
  bumpTree: () => set((s) => ({ treeVersion: s.treeVersion + 1 })),
}));

// ---- tabsStore：标签页、SQL 草稿、结果集 ---------------------------------

export interface Tab {
  id: string;
  connId: string;
  title: string;
  sql: string;
  results: ResultSet[];
  inTransaction: boolean;
  table?: TableRef; // 表浏览模式
}

interface TabsState {
  tabs: Tab[];
  activeTabId: string | null;
  addTab: (tab: Tab) => void;
  updateTab: (id: string, patch: Partial<Tab>) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
}

export const useTabs = create<TabsState>((set) => ({
  tabs: [],
  activeTabId: null,
  addTab: (tab) => set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id })),
  updateTab: (id, patch) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) })),
  closeTab: (id) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      return {
        tabs,
        activeTabId: s.activeTabId === id ? (tabs[0]?.id ?? null) : s.activeTabId,
      };
    }),
  setActiveTab: (activeTabId) => set({ activeTabId }),
}));

// ---- editStore：变更集（按 tab 隔离）-------------------------------------

export interface CellEdit {
  rowIndex: number;
  column: string;
  value: Value;
}

interface EditState {
  // tabId -> 稀疏映射 key=`${rowIndex}:${column}`
  edits: Record<string, Record<string, CellEdit>>;
  setEdit: (tabId: string, edit: CellEdit) => void;
  clear: (tabId: string) => void;
}

export const useEdits = create<EditState>((set) => ({
  edits: {},
  setEdit: (tabId, edit) =>
    set((s) => ({
      edits: {
        ...s.edits,
        [tabId]: {
          ...(s.edits[tabId] ?? {}),
          [`${edit.rowIndex}:${edit.column}`]: edit,
        },
      },
    })),
  clear: (tabId) =>
    set((s) => {
      const next = { ...s.edits };
      delete next[tabId];
      return { edits: next };
    }),
}));
