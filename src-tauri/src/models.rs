//! 公共类型集中地（TDD §3）。
//!
//! 所有数据库的单元格值收敛到 [`Value`]；错误统一到 [`AppError`] 并在 IPC 边界序列化。
//! 这些类型同时被 adapters / services / commands 共享，前端 DTO 与之手工对齐（一期不引代码生成）。

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 统一值类型
// ---------------------------------------------------------------------------

/// 统一值类型：所有数据库的单元格值收敛到这里。
///
/// 使用 `#[serde(tag = "t", content = "v")]`，前端按 `t` 字段分支渲染。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", content = "v")]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    UInt(u64),
    Float(f64),
    /// 字符串保真，避免浮点误差。
    Decimal(String),
    Text(String),
    /// 大对象不全量进前端：只携带长度 + 十六进制预览。
    Bytes { len: usize, preview_hex: String },
    Json(serde_json::Value),
    /// ISO 8601，原样字符串，一期不做时区转换。
    Date(String),
    Time(String),
    DateTime(String),
    /// PG 数组。
    Array(Vec<Value>),
    /// 兜底：原始文本 + 日志告警。
    Unknown(String),
}

impl Value {
    /// 返回 Value 变体名（与 [`ColumnMeta::value_kind`] 对齐，前端据此渲染）。
    pub fn kind(&self) -> &'static str {
        match self {
            Value::Null => "Null",
            Value::Bool(_) => "Bool",
            Value::Int(_) => "Int",
            Value::UInt(_) => "UInt",
            Value::Float(_) => "Float",
            Value::Decimal(_) => "Decimal",
            Value::Text(_) => "Text",
            Value::Bytes { .. } => "Bytes",
            Value::Json(_) => "Json",
            Value::Date(_) => "Date",
            Value::Time(_) => "Time",
            Value::DateTime(_) => "DateTime",
            Value::Array(_) => "Array",
            Value::Unknown(_) => "Unknown",
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }
}

// ---------------------------------------------------------------------------
// 结果集 / 列元数据
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ColumnMeta {
    pub name: String,
    /// 原始类型名，如 "jsonb" / "varchar(255)"。
    pub db_type: String,
    /// 映射后的 Value 变体名，前端据此渲染。
    pub value_kind: String,
    pub nullable: bool,
    pub is_primary_key: bool,
}

/// 分页信息（结果集只能走分页通道，TDD §6.2）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageInfo {
    /// 0-based 页码。
    pub page: u64,
    pub page_size: u64,
    /// 本页起始行（1-based，用于 "第 x–y 行" 展示）。
    pub offset: u64,
    /// 本页返回行数。
    pub returned: u64,
    /// 是否可能还有下一页（returned == page_size 时为 true）。
    pub has_more: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResultSet {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Value>>,
    /// 浏览模式下的 COUNT（可选执行）。
    pub total_hint: Option<u64>,
    pub page: PageInfo,
    pub elapsed_ms: u64,
    pub editable: Editability,
}

/// 适配器返回的原始结果集（未做分页包装/可编辑性判定前的中间产物）。
#[derive(Debug, Clone, PartialEq)]
pub struct RawResultSet {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Value>>,
}

/// 执行类语句（非 SELECT）结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecResult {
    pub affected_rows: u64,
    /// 自增主键（INSERT 时可能有）。
    pub last_insert_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Editability {
    /// 主键 / 唯一非空键 / rowid 列名。
    Editable { row_id_columns: Vec<String> },
    ReadOnly { reason: String },
}

// ---------------------------------------------------------------------------
// 表引用 / 占位符
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TableRef {
    pub database: Option<String>,
    /// PG 用；MySQL / SQLite 为 None。
    pub schema: Option<String>,
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ParamStyle {
    /// `?`
    Question,
    /// `$1..$n`
    Dollar,
}

impl ParamStyle {
    /// 生成第 `idx`（0-based）个占位符文本。
    pub fn placeholder(&self, idx: usize) -> String {
        match self {
            ParamStyle::Question => "?".to_string(),
            ParamStyle::Dollar => format!("${}", idx + 1),
        }
    }
}

// ---------------------------------------------------------------------------
// 元数据 DTO
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatabaseInfo {
    pub name: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TableKind {
    Table,
    View,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableInfo {
    pub name: String,
    pub kind: TableKind,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub name: String,
    pub db_type: String,
    pub value_kind: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub is_primary_key: bool,
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IndexInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ForeignKeyInfo {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TableSchema {
    pub table: TableRef,
    pub columns: Vec<ColumnInfo>,
    pub indexes: Vec<IndexInfo>,
    pub foreign_keys: Vec<ForeignKeyInfo>,
}

// ---------------------------------------------------------------------------
// 连接目标 / 数据库类型
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DbKind {
    Mysql,
    Postgres,
    Sqlite,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SslMode {
    Disable,
    Prefer,
    Require,
}

/// adapter 实际连接所需的目标信息（已解出明文凭证、隧道改写后的地址）。
///
/// 注意：此结构仅在内存中短暂存在，**不得序列化落盘 / 写日志**。
#[derive(Debug, Clone)]
pub struct ConnTarget {
    pub kind: DbKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub ssl_mode: SslMode,
    pub connect_timeout_secs: u64,
    /// SQLite 文件路径（其余字段忽略）。
    pub sqlite_path: Option<String>,
}

// ---------------------------------------------------------------------------
// 错误类型（统一到 IPC 边界）
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error, Serialize, Deserialize, PartialEq)]
#[serde(tag = "code", content = "detail")]
pub enum AppError {
    #[error("auth failed: {0}")]
    AuthFailed(String),
    #[error("network: {0}")]
    Network(String),
    #[error("timeout: {0}")]
    Timeout(String),
    #[error("ssh: {0}")]
    Ssh(String),
    #[error("sql error: {message}")]
    Sql {
        message: String,
        position: Option<u32>,
    },
    /// 影响行数 ≠ 1（乐观并发控制）。
    #[error("conflict: {0}")]
    EditConflict(String),
    #[error("not editable: {0}")]
    NotEditable(String),
    #[error("keyring: {0}")]
    Credential(String),
    #[error("internal: {0}")]
    Internal(String),
}

impl AppError {
    /// 稳定的错误码（前端按此分支处理）。
    pub fn code(&self) -> &'static str {
        match self {
            AppError::AuthFailed(_) => "AuthFailed",
            AppError::Network(_) => "Network",
            AppError::Timeout(_) => "Timeout",
            AppError::Ssh(_) => "Ssh",
            AppError::Sql { .. } => "Sql",
            AppError::EditConflict(_) => "EditConflict",
            AppError::NotEditable(_) => "NotEditable",
            AppError::Credential(_) => "Credential",
            AppError::Internal(_) => "Internal",
        }
    }
}

/// 把 sqlx 错误收敛到 AppError，并尽量区分认证/网络/超时/SQL。
impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        match &e {
            sqlx::Error::PoolTimedOut => AppError::Timeout(e.to_string()),
            sqlx::Error::Io(io) => AppError::Network(io.to_string()),
            sqlx::Error::Database(db) => {
                // 认证类错误码：MySQL 1045 / PG 28P01。
                let code = db.code().map(|c| c.into_owned()).unwrap_or_default();
                if code == "1045" || code == "28P01" || code == "28000" {
                    AppError::AuthFailed(db.message().to_string())
                } else {
                    AppError::Sql {
                        message: db.message().to_string(),
                        position: None,
                    }
                }
            }
            _ => AppError::Sql {
                message: e.to_string(),
                position: None,
            },
        }
    }
}

pub type Result<T> = std::result::Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn value_tag_content_roundtrip() {
        let cases = vec![
            (Value::Null, r#"{"t":"Null"}"#),
            (Value::Bool(true), r#"{"t":"Bool","v":true}"#),
            (Value::Int(-7), r#"{"t":"Int","v":-7}"#),
            (Value::UInt(7), r#"{"t":"UInt","v":7}"#),
            (
                Value::Decimal("3.14".into()),
                r#"{"t":"Decimal","v":"3.14"}"#,
            ),
            (Value::Text("hi".into()), r#"{"t":"Text","v":"hi"}"#),
        ];
        for (v, expected) in cases {
            let s = serde_json::to_string(&v).unwrap();
            assert_eq!(s, expected, "serialize {:?}", v);
            let back: Value = serde_json::from_str(&s).unwrap();
            assert_eq!(back, v, "roundtrip {:?}", v);
        }
    }

    #[test]
    fn value_bytes_serializes_struct_content() {
        let v = Value::Bytes {
            len: 3,
            preview_hex: "00ff10".into(),
        };
        let s = serde_json::to_string(&v).unwrap();
        assert_eq!(s, r#"{"t":"Bytes","v":{"len":3,"preview_hex":"00ff10"}}"#);
        let back: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(back, v);
    }

    #[test]
    fn value_kind_matches_variant() {
        assert_eq!(Value::Null.kind(), "Null");
        assert_eq!(Value::Json(serde_json::json!({"a":1})).kind(), "Json");
        assert_eq!(
            Value::Array(vec![Value::Int(1)]).kind(),
            "Array"
        );
    }

    #[test]
    fn editability_tagged_by_kind() {
        let e = Editability::Editable {
            row_id_columns: vec!["id".into()],
        };
        let s = serde_json::to_string(&e).unwrap();
        assert!(s.contains(r#""kind":"Editable""#), "{s}");

        let r = Editability::ReadOnly {
            reason: "no pk".into(),
        };
        let s = serde_json::to_string(&r).unwrap();
        assert!(s.contains(r#""kind":"ReadOnly""#), "{s}");
    }

    #[test]
    fn param_style_placeholders() {
        assert_eq!(ParamStyle::Question.placeholder(0), "?");
        assert_eq!(ParamStyle::Question.placeholder(5), "?");
        assert_eq!(ParamStyle::Dollar.placeholder(0), "$1");
        assert_eq!(ParamStyle::Dollar.placeholder(4), "$5");
    }

    #[test]
    fn app_error_code_and_serde_tag() {
        let err = AppError::EditConflict("changed".into());
        assert_eq!(err.code(), "EditConflict");
        let s = serde_json::to_string(&err).unwrap();
        assert_eq!(s, r#"{"code":"EditConflict","detail":"changed"}"#);

        let sql = AppError::Sql {
            message: "boom".into(),
            position: Some(12),
        };
        let s = serde_json::to_string(&sql).unwrap();
        assert!(s.contains(r#""code":"Sql""#), "{s}");
        assert!(s.contains(r#""position":12"#), "{s}");
    }

    #[test]
    fn db_kind_lowercase_serde() {
        assert_eq!(serde_json::to_string(&DbKind::Postgres).unwrap(), r#""postgres""#);
        let k: DbKind = serde_json::from_str(r#""sqlite""#).unwrap();
        assert_eq!(k, DbKind::Sqlite);
    }
}
