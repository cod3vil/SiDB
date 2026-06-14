// 前端 DTO 类型 —— 与 Rust models.rs 手工对齐（一期不引代码生成，TDD §9）。

export type DbKind = "mysql" | "postgres" | "sqlite";
export type SslMode = "disable" | "prefer" | "require";

// Value：与 Rust `#[serde(tag = "t", content = "v")]` 对齐。
export type Value =
  | { t: "Null" }
  | { t: "Bool"; v: boolean }
  | { t: "Int"; v: number }
  | { t: "UInt"; v: number }
  | { t: "Float"; v: number }
  | { t: "Decimal"; v: string }
  | { t: "Text"; v: string }
  | { t: "Bytes"; v: { len: number; preview_hex: string } }
  | { t: "Json"; v: unknown }
  | { t: "Date"; v: string }
  | { t: "Time"; v: string }
  | { t: "DateTime"; v: string }
  | { t: "Array"; v: Value[] }
  | { t: "Unknown"; v: string };

export interface ColumnMeta {
  name: string;
  db_type: string;
  value_kind: string;
  nullable: boolean;
  is_primary_key: boolean;
}

export interface PageInfo {
  page: number;
  page_size: number;
  offset: number;
  returned: number;
  has_more: boolean;
}

export type Editability =
  | { kind: "Editable"; row_id_columns: string[] }
  | { kind: "ReadOnly"; reason: string };

export interface ResultSet {
  columns: ColumnMeta[];
  rows: Value[][];
  total_hint: number | null;
  page: PageInfo;
  elapsed_ms: number;
  editable: Editability;
}

export type RunResult =
  | ({ type: "rows"; /* flattened ResultSet */ } & ResultSet)
  | {
      type: "affected";
      affected_rows: number;
      last_insert_id: number | null;
      elapsed_ms: number;
      statement: string;
    };

export interface TableRef {
  database: string | null;
  schema: string | null;
  name: string;
}

export interface DbCapabilities {
  supports_ssh: boolean;
  supports_cancel: boolean;
  supports_schemas: boolean;
  supports_multi_database: boolean;
  supports_use_database: boolean;
  param_style: "Question" | "Dollar";
  quote_char: string;
  has_rowid_fallback: boolean;
}

export interface SshConfig {
  host: string;
  port: number;
  user: string;
  auth: "password" | "key";
  key_path: string | null;
}

export interface ConnConfig {
  id: string;
  name: string;
  kind: DbKind;
  group: string | null;
  host: string | null;
  port: number | null;
  user: string | null;
  database: string | null;
  schema: string | null;
  ssl_mode: SslMode | null;
  connect_timeout_secs: number;
  keepalive_secs: number;
  read_timeout_secs: number;
  write_timeout_secs: number;
  sqlite_path: string | null;
  ssh: SshConfig | null;
  has_password: boolean;
}

export interface ConnConfigInput {
  id?: string;
  name: string;
  kind: DbKind;
  group?: string | null;
  host?: string | null;
  port?: number | null;
  user?: string | null;
  password?: string | null;
  database?: string | null;
  schema?: string | null;
  ssl_mode?: SslMode | null;
  connect_timeout_secs?: number | null;
  keepalive_secs?: number | null;
  read_timeout_secs?: number | null;
  write_timeout_secs?: number | null;
  sqlite_path?: string | null;
  ssh?: SshConfig | null;
  ssh_password?: string | null;
  ssh_passphrase?: string | null;
}

export interface DatabaseInfo {
  name: string;
}
export interface TableInfo {
  name: string;
  kind: "table" | "view";
}
export interface RoutineInfo {
  name: string;
  kind: "function" | "procedure";
  /** 方言内部标识（PG `oid`），同名重载时用于精确定位。 */
  id?: number | null;
}
export type ExportFormat = "csv" | "xlsx" | "sql";
export type ExportScope = "all" | "page" | "rows";
export interface ExportProgress {
  task_id: string;
  written: number;
  total: number | null;
  status: "running" | "done" | "cancelled" | "error";
  message: string | null;
}

export interface RoutineRef {
  database: string | null;
  schema: string | null;
  name: string;
  kind: "function" | "procedure";
  id?: number | null;
}
export interface SavedQuery {
  id: string;
  name: string;
  conn_id: string;
  database: string | null;
  schema: string | null;
  sql: string;
}
export interface SavedQueryInput {
  id?: string;
  name: string;
  conn_id: string;
  database?: string | null;
  schema?: string | null;
  sql: string;
}
export interface ColumnInfo {
  name: string;
  db_type: string;
  value_kind: string;
  nullable: boolean;
  default: string | null;
  is_primary_key: boolean;
  comment: string | null;
}

// AppError：与 Rust `#[serde(tag = "code", content = "detail")]` 对齐。
export type AppErrorCode =
  | "AuthFailed"
  | "Network"
  | "Timeout"
  | "Ssh"
  | "Sql"
  | "EditConflict"
  | "NotEditable"
  | "Credential"
  | "Internal";

export interface AppError {
  code: AppErrorCode;
  detail: unknown;
}

// 变更集（数据编辑，TDD §6.3）。
export type Change =
  | { type: "update"; key: Record<string, Value>; set: Record<string, Value> }
  | { type: "insert"; values: Record<string, Value> }
  | { type: "delete"; key: Record<string, Value> };

export interface ChangeSet {
  table: TableRef;
  row_id_columns: string[];
  changes: Change[];
}

export interface Settings {
  theme: "light" | "dark" | "system";
  language: string;
  default_page_size: number;
  editor_font_size: number;
  auto_uppercase_keywords: boolean;
  auto_check_update: boolean;
  ai: {
    provider: string;
    model: string;
    base_url: string | null;
    key_configured: boolean;
  };
}

// AI 对话（与 Rust commands::ai_chat / agent::TurnResult 对齐）。
export interface AiChatMsg {
  role: "user" | "assistant";
  text: string;
}

export interface AiChatInput {
  conn_id: string;
  database: string | null;
  schema: string | null;
  table: string | null;
  history: AiChatMsg[];
  message: string;
}

/** 一次工具调用的展示摘要。 */
export interface ToolStep {
  tool: string;
  summary: string;
}

/** 写操作提案（需用户确认）。 */
export interface ProposalDto {
  id: string;
  sql: string;
}

export interface AiChatResult {
  reply: string;
  steps: ToolStep[];
  proposals: ProposalDto[];
}
