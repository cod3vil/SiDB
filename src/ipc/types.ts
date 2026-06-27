// 前端 DTO 类型 —— 与 Rust models.rs 手工对齐（一期不引代码生成，TDD §9）。

export type DbKind = "mysql" | "postgres" | "sqlite" | "redis";

/** 连接引擎家族：SQL（mysql/pg/sqlite）或 Redis（KV）。由 kind 推导。 */
export type Engine = "sql" | "redis";
export function engineOf(kind: DbKind): Engine {
  return kind === "redis" ? "redis" : "sql";
}

// ---- Redis (KV) DTO（对齐后端 kv 模块的 Serialize）----
export interface RedisField {
  text: string;
  /** true 表示非 UTF-8，text 为十六进制。 */
  binary: boolean;
}
export interface RedisKeyMeta {
  name: string;
  type: string;
  ttl_ms: number;
}
export interface RedisScanPage {
  cursor: string;
  keys: RedisKeyMeta[];
}
export interface RedisKeyDetail {
  type: string;
  ttl_ms: number;
  mem_bytes: number | null;
  size: number;
}
export interface RedisStreamEntry {
  id: string;
  fields: [RedisField, RedisField][];
}
export type RedisValue =
  | { type: "string"; value: RedisField }
  | { type: "hash"; cursor: string; fields: [RedisField, RedisField][]; total: number }
  | { type: "list"; start: number; stop: number; items: RedisField[]; total: number }
  | { type: "set"; cursor: string; members: RedisField[]; total: number }
  | { type: "zset"; start: number; stop: number; items: [RedisField, number][]; total: number }
  | { type: "stream"; entries: RedisStreamEntry[]; total: number }
  | { type: "none" };
export type RedisReply =
  | { kind: "nil" }
  | { kind: "int"; value: number }
  | { kind: "str"; text: string; binary: boolean }
  | { kind: "status"; text: string }
  | { kind: "error"; text: string }
  | { kind: "double"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "array"; items: RedisReply[] }
  | { kind: "map"; items: [RedisReply, RedisReply][] };
export type SslMode = "disable" | "prefer" | "require";

// Value：与 Rust `#[serde(tag = "t", content = "v")]` 对齐。
export type Value =
  | { t: "Null" }
  | { t: "Bool"; v: boolean }
  | { t: "Int"; v: number | string }
  | { t: "UInt"; v: number | string }
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
  /** 可编辑的自定义「单表 SELECT *」对应的表；表浏览为 null（前端已知表）。 */
  editable_table?: TableRef | null;
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
export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}
export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  ref_table: string;
  ref_columns: string[];
}
export interface TableSchema {
  table: TableRef;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreign_keys: ForeignKeyInfo[];
}
export interface TableOptions {
  engine: string | null;
  charset: string | null;
  collation: string | null;
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

/** 当前查询结果集的精简快照，作为 AI 上下文（让 AI 能直接针对屏幕上的结果讨论）。 */
export interface AiResultContext {
  /** 产生该结果的 SQL（表浏览时为简述）。 */
  sql: string | null;
  columns: string[];
  /** 已字符串化的单元格，前 N 行。 */
  rows: string[][];
  /** 总行数提示（未知为 null）。 */
  total: number | null;
  /** 是否对行数做了截断。 */
  truncated: boolean;
}

export interface AiChatInput {
  conn_id: string;
  database: string | null;
  schema: string | null;
  table: string | null;
  history: AiChatMsg[];
  message: string;
  /** 当前结果集上下文（可选）。 */
  result?: AiResultContext | null;
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
