// IPC 封装层（TDD §9）：所有 invoke 集中于此，组件内不直接 invoke。

import { invoke } from "@tauri-apps/api/core";
import type {
  AiChatInput,
  AiChatResult,
  ColumnInfo,
  ConnConfig,
  ConnConfigInput,
  DatabaseInfo,
  DbCapabilities,
  ChangeSet,
  ResultSet,
  RunResult,
  RoutineInfo,
  SavedQuery,
  SavedQueryInput,
  Settings,
  TableInfo,
  TableRef,
} from "./types";

export const ipc = {
  // 连接管理
  listConnections: () => invoke<ConnConfig[]>("list_connections"),
  saveConnection: (input: ConnConfigInput) =>
    invoke<ConnConfig>("save_connection", { input }),
  deleteConnection: (id: string) => invoke<void>("delete_connection", { id }),
  testConnection: (input: ConnConfigInput) =>
    invoke<void>("test_connection", { input }),
  connect: (connId: string) => invoke<DbCapabilities>("connect", { connId }),
  disconnect: (connId: string) => invoke<void>("disconnect", { connId }),

  // 元数据（树懒加载）
  listDatabases: (connId: string) =>
    invoke<DatabaseInfo[]>("list_databases", { connId }),
  listSchemas: (connId: string, database: string) =>
    invoke<string[]>("list_schemas", { connId, database }),
  listTables: (connId: string, database: string, schema?: string | null) =>
    invoke<TableInfo[]>("list_tables", { connId, database, schema }),
  listFunctions: (connId: string, database: string, schema?: string | null) =>
    invoke<RoutineInfo[]>("list_functions", { connId, database, schema }),
  listColumns: (connId: string, table: TableRef) =>
    invoke<ColumnInfo[]>("list_columns", { connId, table }),
  getTableSchema: (connId: string, table: TableRef) =>
    invoke("get_table_schema", { connId, table }),
  getTableDdl: (connId: string, table: TableRef) =>
    invoke<string>("get_table_ddl", { connId, table }),

  // 查询 / 浏览
  openTableData: (
    connId: string,
    table: TableRef,
    page: number,
    pageSize: number,
    sortColumn?: string | null,
    sortAsc?: boolean | null,
  ) =>
    invoke<ResultSet>("open_table_data", {
      connId,
      table,
      page,
      pageSize,
      sortColumn,
      sortAsc,
    }),
  runSql: (
    connId: string,
    tabId: string,
    sql: string,
    page: number,
    pageSize: number,
    database?: string | null,
  ) => invoke<RunResult[]>("run_sql", { connId, tabId, sql, page, pageSize, database }),
  cancelQuery: (connId: string, queryId: string) =>
    invoke<void>("cancel_query", { connId, queryId }),

  // 数据编辑
  previewChanges: (connId: string, changeSet: ChangeSet) =>
    invoke<string[]>("preview_changes", { connId, changeSet }),
  commitChanges: (connId: string, changeSet: ChangeSet) =>
    invoke("commit_changes", { connId, changeSet }),

  // 保存的查询
  listQueries: () => invoke<SavedQuery[]>("list_queries"),
  saveQuery: (input: SavedQueryInput) => invoke<SavedQuery>("save_query", { input }),
  deleteQuery: (id: string) => invoke<void>("delete_query", { id }),

  // 设置
  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (settings: Settings) => invoke<void>("set_settings", { settings }),

  // AI
  aiTestProvider: (input: {
    provider: string;
    api_key: string;
    model: string;
    base_url?: string | null;
  }) => invoke<void>("ai_test_provider", { input }),
  aiChat: (input: AiChatInput) => invoke<AiChatResult>("ai_chat", { input }),
  aiConfirmWrite: (connId: string, proposalId: string) =>
    invoke<RunResult[]>("ai_confirm_write", { input: { conn_id: connId, proposal_id: proposalId } }),
};

export type { ResultSet, RunResult, ConnConfig, TableRef } from "./types";
