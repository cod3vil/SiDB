// IPC 封装层（TDD §9）：所有 invoke 集中于此，组件内不直接 invoke。

import { invoke } from "@tauri-apps/api/core";
import type {
  ColumnInfo,
  ConnConfig,
  ConnConfigInput,
  DatabaseInfo,
  DbCapabilities,
  ChangeSet,
  ResultSet,
  RunResult,
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
  ) => invoke<RunResult[]>("run_sql", { connId, tabId, sql, page, pageSize }),
  cancelQuery: (connId: string, queryId: string) =>
    invoke<void>("cancel_query", { connId, queryId }),

  // 数据编辑
  previewChanges: (connId: string, changeSet: ChangeSet) =>
    invoke<string[]>("preview_changes", { connId, changeSet }),
  commitChanges: (connId: string, changeSet: ChangeSet) =>
    invoke("commit_changes", { connId, changeSet }),

  // 设置
  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (settings: Settings) => invoke<void>("set_settings", { settings }),

  // AI（一期：测试连通）
  aiTestProvider: (input: {
    provider: string;
    api_key: string;
    model: string;
    base_url?: string | null;
  }) => invoke<void>("ai_test_provider", { input }),
};

export type { ResultSet, RunResult, ConnConfig, TableRef } from "./types";
