//! SQL Server（T-SQL）适配器。
//!
//! - 驱动：纯 Rust 的 [`tiberius`]（rustls TLS，避免原生 openssl 交叉编译），
//!   经 `tokio_util::compat` 桥接到 tokio。
//! - 单连接置于 `Mutex<Option<Client>>`（会话层已串行化所有适配器调用，等价于池 1）。
//! - 标识符引号：`QUOTED_IDENTIFIER ON`（tiberius 默认），用 `"` 包裹；跨库用三段式 `db.schema.table`。
//! - 分页：`OFFSET…FETCH`（见 `services::query`）。占位符：`@P1..@Pn`。
//! - 元数据：`INFORMATION_SCHEMA.*` 与 `sys.*`，均以库名三段式限定，避免依赖当前库状态。
//! - 一期不支持查询取消（`supports_cancel = false`）与函数创建/编辑（只读查看定义）。

use super::type_map::sqlserver_kind;
use super::{DbAdapter, DbCapabilities};
use crate::models::*;
use async_trait::async_trait;
use std::time::Duration;
use tiberius::{AuthMethod, Client, Config, EncryptionLevel, Row};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_util::compat::{Compat, TokioAsyncWriteCompatExt};

type Conn = Client<Compat<TcpStream>>;

pub struct SqlServerAdapter {
    caps: DbCapabilities,
    client: Mutex<Option<Conn>>,
    /// 当前库（`USE` 切换后记录，避免重复切换）。
    current_db: std::sync::Mutex<Option<String>>,
}

impl SqlServerAdapter {
    pub fn new() -> Self {
        Self {
            caps: DbCapabilities {
                supports_ssh: true,
                supports_cancel: false,
                supports_schemas: true,
                supports_multi_database: true,
                supports_use_database: true,
                param_style: ParamStyle::AtP,
                quote_char: '"',
                has_rowid_fallback: false,
            },
            client: Mutex::new(None),
            current_db: std::sync::Mutex::new(None),
        }
    }

    /// 取出内部连接引用；未连接则报错。
    async fn with_client(guard: &mut Option<Conn>) -> Result<&mut Conn> {
        guard
            .as_mut()
            .ok_or_else(|| AppError::Internal("sqlserver not connected".into()))
    }

    /// 跑一条带参数的查询，取第一个结果集的行（行自持数据，可在锁外解码）。
    async fn fetch_rows(&self, sql: &str, params: &[P]) -> Result<Vec<Row>> {
        let mut guard = self.client.lock().await;
        let client = Self::with_client(&mut guard).await?;
        let refs: Vec<&dyn tiberius::ToSql> =
            params.iter().map(|p| p as &dyn tiberius::ToSql).collect();
        let stream = client.query(sql, &refs).await.map_err(tds_err)?;
        stream.into_first_result().await.map_err(tds_err)
    }
}

impl Default for SqlServerAdapter {
    fn default() -> Self {
        Self::new()
    }
}

/// 把 tiberius 错误收敛到 AppError（登录失败 → AuthFailed，IO → Network）。
fn tds_err(e: tiberius::error::Error) -> AppError {
    use tiberius::error::Error as E;
    match &e {
        E::Server(token) => {
            let msg = token.message().to_string();
            // 18456 登录失败 / 18452 未信任域。
            if token.code() == 18456 || token.code() == 18452 {
                AppError::AuthFailed(msg)
            } else {
                AppError::Sql {
                    message: msg,
                    position: None,
                }
            }
        }
        E::Io { .. } => AppError::Network(e.to_string()),
        _ => AppError::Sql {
            message: e.to_string(),
            position: None,
        },
    }
}

/// 建立一条 tiberius 连接。
async fn build_client(target: &ConnTarget) -> Result<Conn> {
    let mut config = Config::new();
    config.host(&target.host);
    config.port(target.port);
    if let Some(db) = target
        .database
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        config.database(db);
    }
    config.authentication(AuthMethod::sql_server(
        &target.user,
        target.password.clone().unwrap_or_default(),
    ));
    // 桌面端常见自签证书：信任服务端证书；加密级别按 ssl_mode。
    config.trust_cert();
    config.encryption(match target.ssl_mode {
        SslMode::Disable => EncryptionLevel::NotSupported,
        SslMode::Prefer => EncryptionLevel::On,
        SslMode::Require => EncryptionLevel::Required,
    });

    let addr = config.get_addr();
    let tcp = tokio::time::timeout(
        Duration::from_secs(target.connect_timeout_secs.max(1)),
        TcpStream::connect(addr),
    )
    .await
    .map_err(|_| AppError::Timeout("sqlserver connect timeout".into()))?
    .map_err(|e| AppError::Network(e.to_string()))?;
    tcp.set_nodelay(true).ok();
    Client::connect(config, tcp.compat_write())
        .await
        .map_err(tds_err)
}

/// 执行一条无参数、无结果集的语句（USE / BEGIN TRAN / COMMIT 等）。
async fn exec_simple(client: &mut Conn, sql: &str) -> Result<()> {
    client
        .simple_query(sql)
        .await
        .map_err(tds_err)?
        .into_results()
        .await
        .map_err(tds_err)?;
    Ok(())
}

// ---- 参数绑定 -------------------------------------------------------------

/// tiberius 参数的自持载体（先建 owned，再借引用传给 `query`/`execute`）。
enum P {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    Bytes(Vec<u8>),
}

impl tiberius::ToSql for P {
    fn to_sql(&self) -> tiberius::ColumnData<'_> {
        use std::borrow::Cow;
        use tiberius::ColumnData;
        match self {
            // 空值统一走可空字符串，交由 SQL Server 隐式转换到目标列类型。
            P::Null => ColumnData::String(None),
            P::Bool(b) => ColumnData::Bit(Some(*b)),
            P::Int(n) => ColumnData::I64(Some(*n)),
            P::Float(f) => ColumnData::F64(Some(*f)),
            P::Str(s) => ColumnData::String(Some(Cow::Owned(s.clone()))),
            P::Bytes(b) => ColumnData::Binary(Some(Cow::Owned(b.clone()))),
        }
    }
}

fn to_param(v: &Value) -> P {
    match v {
        Value::Null => P::Null,
        Value::Bool(b) => P::Bool(*b),
        Value::Int(n) => P::Int(*n),
        Value::UInt(n) => P::Int(*n as i64),
        Value::Float(f) => P::Float(*f),
        Value::Decimal(s) | Value::Text(s) | Value::Unknown(s) => P::Str(s.clone()),
        Value::Date(s) | Value::Time(s) | Value::DateTime(s) => P::Str(s.clone()),
        Value::Json(j) => P::Str(j.to_string()),
        Value::Bytes { preview_hex, .. } => P::Bytes(hex_to_bytes(preview_hex)),
        Value::Array(_) => P::Str(serde_json::to_string(v).unwrap_or_default()),
    }
}

fn params_of(values: &[Value]) -> Vec<P> {
    values.iter().map(to_param).collect()
}

fn hex_to_bytes(s: &str) -> Vec<u8> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    let mut i = 0;
    while i + 1 < bytes.len() {
        let hi = (bytes[i] as char).to_digit(16);
        let lo = (bytes[i + 1] as char).to_digit(16);
        if let (Some(h), Some(l)) = (hi, lo) {
            out.push((h * 16 + l) as u8);
        }
        i += 2;
    }
    out
}

// ---- 取值解码 -------------------------------------------------------------

fn bytes_value(b: &[u8]) -> Value {
    const PREVIEW: usize = 64;
    let preview_hex = b.iter().take(PREVIEW).map(|x| format!("{x:02x}")).collect();
    Value::Bytes {
        len: b.len(),
        preview_hex,
    }
}

/// tiberius `ColumnType` 的 Debug 名（小写）→ value_kind。避免直接匹配枚举变体（跨版本更稳）。
fn kind_of(dbg: &str) -> &'static str {
    match dbg {
        "bit" | "bitn" => "Bool",
        "int1" | "int2" | "int4" | "int8" | "intn" => "Int",
        "float4" | "float8" | "floatn" => "Float",
        "money" | "money4" | "moneyn" | "decimaln" | "numericn" => "Decimal",
        "datetime" | "datetime4" | "datetimen" | "datetime2" | "datetimeoffsetn"
        | "smalldatetime" => "DateTime",
        "daten" => "Date",
        "timen" => "Time",
        "bigvarbin" | "bigbinary" | "image" => "Bytes",
        _ => "Text",
    }
}

/// 同上 → 友好类型名（结果网格展示用；精确类型由 `table_schema` 提供）。
fn typename_of(dbg: &str) -> &'static str {
    match dbg {
        "bit" | "bitn" => "bit",
        "int1" => "tinyint",
        "int2" => "smallint",
        "int4" | "intn" => "int",
        "int8" => "bigint",
        "float4" => "real",
        "float8" | "floatn" => "float",
        "money" | "money4" | "moneyn" => "money",
        "decimaln" => "decimal",
        "numericn" => "numeric",
        "datetime" | "datetime4" | "datetimen" | "smalldatetime" => "datetime",
        "datetime2" => "datetime2",
        "datetimeoffsetn" => "datetimeoffset",
        "daten" => "date",
        "timen" => "time",
        "guid" => "uniqueidentifier",
        "bigvarbin" | "bigbinary" => "varbinary",
        "image" => "image",
        "bigvarchar" | "bigchar" | "text" => "varchar",
        "nvarchar" | "nchar" | "ntext" => "nvarchar",
        "xml" => "xml",
        _ => "nvarchar",
    }
}

fn col_dbg(ct: tiberius::ColumnType) -> String {
    format!("{ct:?}").to_ascii_lowercase()
}

fn decode_row(row: &Row) -> Vec<Value> {
    let n = row.columns().len();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let dbg = col_dbg(row.columns()[i].column_type());
        out.push(decode_cell(row, i, kind_of(&dbg)));
    }
    out
}

fn decode_cell(row: &Row, i: usize, kind: &str) -> Value {
    match kind {
        "Bool" => match row.try_get::<bool, _>(i) {
            Ok(Some(b)) => Value::Bool(b),
            _ => Value::Null,
        },
        "Int" => {
            if let Ok(Some(n)) = row.try_get::<i32, _>(i) {
                return Value::Int(n as i64);
            }
            if let Ok(Some(n)) = row.try_get::<i64, _>(i) {
                return Value::Int(n);
            }
            if let Ok(Some(n)) = row.try_get::<i16, _>(i) {
                return Value::Int(n as i64);
            }
            if let Ok(Some(n)) = row.try_get::<u8, _>(i) {
                return Value::Int(n as i64);
            }
            Value::Null
        }
        "Float" => {
            if let Ok(Some(f)) = row.try_get::<f64, _>(i) {
                return Value::Float(f);
            }
            if let Ok(Some(f)) = row.try_get::<f32, _>(i) {
                return Value::Float(f as f64);
            }
            Value::Null
        }
        "Decimal" => {
            if let Ok(Some(d)) = row.try_get::<rust_decimal::Decimal, _>(i) {
                return Value::Decimal(d.to_string());
            }
            if let Ok(Some(f)) = row.try_get::<f64, _>(i) {
                return Value::Decimal(f.to_string());
            }
            Value::Null
        }
        "Bytes" => match row.try_get::<&[u8], _>(i) {
            Ok(Some(b)) => bytes_value(b),
            _ => Value::Null,
        },
        "Date" => match row.try_get::<chrono::NaiveDate, _>(i) {
            Ok(Some(d)) => Value::Date(d.format("%Y-%m-%d").to_string()),
            _ => Value::Null,
        },
        "Time" => match row.try_get::<chrono::NaiveTime, _>(i) {
            Ok(Some(t)) => Value::Time(t.format("%H:%M:%S%.f").to_string()),
            _ => Value::Null,
        },
        "DateTime" => {
            if let Ok(Some(dt)) = row.try_get::<chrono::NaiveDateTime, _>(i) {
                return Value::DateTime(dt.format("%Y-%m-%d %H:%M:%S%.f").to_string());
            }
            if let Ok(Some(dt)) = row.try_get::<chrono::DateTime<chrono::FixedOffset>, _>(i) {
                return Value::DateTime(dt.format("%Y-%m-%d %H:%M:%S%.f%:z").to_string());
            }
            if let Ok(Some(dt)) = row.try_get::<chrono::DateTime<chrono::Utc>, _>(i) {
                return Value::DateTime(dt.format("%Y-%m-%d %H:%M:%S%.f%:z").to_string());
            }
            Value::Null
        }
        _ => {
            if let Ok(Some(s)) = row.try_get::<&str, _>(i) {
                return Value::Text(s.to_string());
            }
            if let Ok(Some(u)) = row.try_get::<uuid::Uuid, _>(i) {
                return Value::Text(u.to_string());
            }
            Value::Null
        }
    }
}

/// 按列名取文本（元数据查询用），NULL/缺失 → 空串。
fn s_at<'a>(row: &'a Row, col: &str) -> &'a str {
    row.try_get::<&str, _>(col).ok().flatten().unwrap_or("")
}

/// 按列名取可空整数。
fn i_at(row: &Row, col: &str) -> Option<i32> {
    row.try_get::<i32, _>(col).ok().flatten()
}

/// 中括号限定标识符（供 `OBJECT_ID('[db].[schema].[name]')` 字符串参数用）。
fn bracket(s: &str) -> String {
    format!("[{}]", s.replace(']', "]]"))
}

/// 由 INFORMATION_SCHEMA 各字段拼出可读的 db_type，如 `varchar(255)` / `decimal(10,2)`。
fn build_db_type(
    data_type: &str,
    char_len: Option<i32>,
    prec: Option<i32>,
    scale: Option<i32>,
) -> String {
    let dt = data_type.to_ascii_lowercase();
    match dt.as_str() {
        "char" | "varchar" | "nchar" | "nvarchar" | "binary" | "varbinary" => match char_len {
            Some(-1) => format!("{dt}(max)"),
            Some(n) => format!("{dt}({n})"),
            None => dt,
        },
        "decimal" | "numeric" => match (prec, scale) {
            (Some(p), Some(s)) => format!("{dt}({p},{s})"),
            (Some(p), None) => format!("{dt}({p})"),
            _ => dt,
        },
        _ => dt,
    }
}

#[async_trait]
impl DbAdapter for SqlServerAdapter {
    fn capabilities(&self) -> &DbCapabilities {
        &self.caps
    }

    fn sql_dialect(&self) -> SqlDialect {
        SqlDialect {
            quote_char: '"',
            bool_keywords: false,
            backslash_strings: false,
            bytes: BytesLiteral::XQuote, // 0xAB 亦可，此处沿用 X'AB' 通用写法
        }
    }

    async fn connect(&mut self, target: &ConnTarget) -> Result<()> {
        let client = build_client(target).await?;
        *self.client.lock().await = Some(client);
        *self.current_db.lock().unwrap() = target
            .database
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        Ok(())
    }

    async fn disconnect(&mut self) {
        *self.client.lock().await = None;
        *self.current_db.lock().unwrap() = None;
    }

    async fn ping(&self) -> Result<()> {
        let mut guard = self.client.lock().await;
        let client = Self::with_client(&mut guard).await?;
        exec_simple(client, "SELECT 1").await
    }

    async fn query(&self, _query_id: &str, sql: &str, params: &[Value]) -> Result<RawResultSet> {
        let rows = self.fetch_rows(sql, &params_of(params)).await?;
        let columns = match rows.first() {
            Some(first) => first
                .columns()
                .iter()
                .map(|c| {
                    let dbg = col_dbg(c.column_type());
                    ColumnMeta {
                        name: c.name().to_string(),
                        db_type: typename_of(&dbg).to_string(),
                        value_kind: kind_of(&dbg).to_string(),
                        nullable: true,
                        is_primary_key: false,
                    }
                })
                .collect(),
            None => Vec::new(),
        };
        let out_rows = rows.iter().map(decode_row).collect();
        Ok(RawResultSet {
            columns,
            rows: out_rows,
        })
    }

    async fn execute(&self, _query_id: &str, sql: &str, params: &[Value]) -> Result<ExecResult> {
        let owned = params_of(params);
        let mut guard = self.client.lock().await;
        let client = Self::with_client(&mut guard).await?;
        let refs: Vec<&dyn tiberius::ToSql> =
            owned.iter().map(|p| p as &dyn tiberius::ToSql).collect();
        let res = client.execute(sql, &refs).await.map_err(tds_err)?;
        Ok(ExecResult {
            affected_rows: res.rows_affected().iter().sum(),
            last_insert_id: None,
        })
    }

    async fn use_database(&mut self, db: Option<String>) -> Result<()> {
        let db = db.filter(|s| !s.is_empty());
        if *self.current_db.lock().unwrap() == db {
            return Ok(());
        }
        if let Some(d) = &db {
            let stmt = format!("USE {}", self.caps.quote_ident(d)?);
            let mut guard = self.client.lock().await;
            let client = Self::with_client(&mut guard).await?;
            exec_simple(client, &stmt).await?;
        }
        *self.current_db.lock().unwrap() = db;
        Ok(())
    }

    async fn cancel(&self, _query_id: &str) -> Result<()> {
        // 一期不支持查询取消。
        Ok(())
    }

    async fn execute_in_transaction(
        &self,
        stmts: Vec<(String, Vec<Value>)>,
    ) -> Result<Vec<ExecResult>> {
        let mut guard = self.client.lock().await;
        let client = Self::with_client(&mut guard).await?;
        exec_simple(client, "BEGIN TRANSACTION").await?;
        let mut results = Vec::with_capacity(stmts.len());
        for (sql, params) in &stmts {
            let owned = params_of(params);
            let refs: Vec<&dyn tiberius::ToSql> =
                owned.iter().map(|p| p as &dyn tiberius::ToSql).collect();
            match client.execute(sql.as_str(), &refs).await {
                Ok(res) => results.push(ExecResult {
                    affected_rows: res.rows_affected().iter().sum(),
                    last_insert_id: None,
                }),
                Err(e) => {
                    let _ = exec_simple(client, "IF @@TRANCOUNT > 0 ROLLBACK").await;
                    return Err(tds_err(e));
                }
            }
        }
        exec_simple(client, "COMMIT").await?;
        Ok(results)
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        // database_id 1..4 为系统库（master/tempdb/model/msdb）。
        let rows = self
            .fetch_rows(
                "SELECT name FROM sys.databases WHERE database_id > 4 ORDER BY name",
                &[],
            )
            .await?;
        Ok(rows
            .iter()
            .map(|r| DatabaseInfo {
                name: s_at(r, "name").to_string(),
            })
            .filter(|d| !d.name.is_empty())
            .collect())
    }

    async fn list_schemas(&self, db: &str) -> Result<Vec<String>> {
        let dbq = self.caps.quote_ident(db)?;
        let sql = format!(
            "SELECT s.name AS name FROM {dbq}.sys.schemas s \
             WHERE s.name NOT IN ('sys','guest','INFORMATION_SCHEMA') AND s.name NOT LIKE 'db[_]%' \
             ORDER BY s.name"
        );
        let rows = self.fetch_rows(&sql, &[]).await?;
        Ok(rows
            .iter()
            .map(|r| s_at(r, "name").to_string())
            .filter(|s| !s.is_empty())
            .collect())
    }

    async fn list_tables(&self, db: &str, schema: Option<&str>) -> Result<Vec<TableInfo>> {
        let schema = schema.unwrap_or("dbo");
        let dbq = self.caps.quote_ident(db)?;
        let sql = format!(
            "SELECT x.name AS name, x.knd AS knd FROM ( \
               SELECT t.name AS name, 'table' AS knd, t.schema_id AS sid FROM {dbq}.sys.tables t \
               UNION ALL \
               SELECT v.name, 'view', v.schema_id FROM {dbq}.sys.views v \
             ) x JOIN {dbq}.sys.schemas s ON s.schema_id = x.sid \
             WHERE s.name = @P1 ORDER BY name"
        );
        let rows = self.fetch_rows(&sql, &[P::Str(schema.to_string())]).await?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                let name = s_at(r, "name").to_string();
                if name.is_empty() {
                    return None;
                }
                let knd = s_at(r, "knd");
                Some(TableInfo {
                    name,
                    kind: if knd == "view" {
                        TableKind::View
                    } else {
                        TableKind::Table
                    },
                    is_super: false,
                })
            })
            .collect())
    }

    async fn list_functions(&self, db: &str, schema: Option<&str>) -> Result<Vec<RoutineInfo>> {
        let schema = schema.unwrap_or("dbo");
        let dbq = self.caps.quote_ident(db)?;
        // P=存储过程；FN/IF/TF=标量/内联/表值函数。
        let sql = format!(
            "SELECT o.name AS name, o.type AS otype FROM {dbq}.sys.objects o \
             JOIN {dbq}.sys.schemas s ON s.schema_id = o.schema_id \
             WHERE s.name = @P1 AND o.type IN ('P','FN','IF','TF') ORDER BY o.name"
        );
        let rows = self.fetch_rows(&sql, &[P::Str(schema.to_string())]).await?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                let name = s_at(r, "name").to_string();
                if name.is_empty() {
                    return None;
                }
                let otype = s_at(r, "otype").trim().to_string();
                Some(RoutineInfo {
                    name,
                    kind: if otype == "P" {
                        RoutineKind::Procedure
                    } else {
                        RoutineKind::Function
                    },
                    id: None,
                })
            })
            .collect())
    }

    async fn function_ddl(&self, r: &RoutineRef) -> Result<String> {
        let db = r
            .database
            .as_deref()
            .ok_or_else(|| AppError::Internal("sqlserver routine requires database".into()))?;
        let schema = r.schema.as_deref().unwrap_or("dbo");
        let dbq = self.caps.quote_ident(db)?;
        // OBJECT_ID 用三段式字符串跨库解析；再取该库 sys.sql_modules 的定义源码。
        let objname = format!("{}.{}.{}", bracket(db), bracket(schema), bracket(&r.name));
        let sql = format!(
            "SELECT m.definition AS def FROM {dbq}.sys.sql_modules m \
             WHERE m.object_id = OBJECT_ID(@P1)"
        );
        let rows = self.fetch_rows(&sql, &[P::Str(objname)]).await?;
        let def = rows
            .first()
            .map(|r| s_at(r, "def").to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| AppError::NotEditable(format!("routine not found: {}", r.name)))?;
        Ok(def)
    }

    async fn table_schema(&self, t: &TableRef) -> Result<TableSchema> {
        let db = t
            .database
            .as_deref()
            .ok_or_else(|| AppError::Internal("sqlserver table requires database".into()))?;
        let schema = t.schema.as_deref().unwrap_or("dbo");
        let dbq = self.caps.quote_ident(db)?;
        let sp = || vec![P::Str(schema.to_string()), P::Str(t.name.clone())];

        // 列
        let cols_sql = format!(
            "SELECT COLUMN_NAME AS cname, DATA_TYPE AS dtype, \
                    CAST(CHARACTER_MAXIMUM_LENGTH AS int) AS clen, \
                    CAST(NUMERIC_PRECISION AS int) AS nprec, \
                    CAST(NUMERIC_SCALE AS int) AS nscale, \
                    IS_NULLABLE AS nullable, COLUMN_DEFAULT AS dflt \
             FROM {dbq}.INFORMATION_SCHEMA.COLUMNS \
             WHERE TABLE_SCHEMA = @P1 AND TABLE_NAME = @P2 ORDER BY ORDINAL_POSITION"
        );
        let col_rows = self.fetch_rows(&cols_sql, &sp()).await?;

        // 主键列集合
        let pk_sql = format!(
            "SELECT ku.COLUMN_NAME AS cname \
             FROM {dbq}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc \
             JOIN {dbq}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku \
               ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = ku.TABLE_SCHEMA \
             WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND ku.TABLE_SCHEMA = @P1 AND ku.TABLE_NAME = @P2"
        );
        let pk_rows = self.fetch_rows(&pk_sql, &sp()).await?;
        let pks: std::collections::HashSet<String> = pk_rows
            .iter()
            .map(|r| s_at(r, "cname").to_string())
            .collect();

        let mut columns = Vec::new();
        for r in &col_rows {
            let name = s_at(r, "cname").to_string();
            let data_type = s_at(r, "dtype").to_string();
            let db_type = build_db_type(
                &data_type,
                i_at(r, "clen"),
                i_at(r, "nprec"),
                i_at(r, "nscale"),
            );
            let nullable = s_at(r, "nullable").eq_ignore_ascii_case("YES");
            let default = {
                let d = s_at(r, "dflt");
                if d.is_empty() {
                    None
                } else {
                    Some(d.to_string())
                }
            };
            columns.push(ColumnInfo {
                value_kind: sqlserver_kind(&data_type).to_string(),
                is_primary_key: pks.contains(&name),
                name,
                db_type,
                nullable,
                default,
                comment: None,
            });
        }

        // 索引
        let idx_sql = format!(
            "SELECT i.name AS idx, CAST(i.is_unique AS int) AS uniq, \
                    CAST(i.is_primary_key AS int) AS pk, c.name AS col \
             FROM {dbq}.sys.indexes i \
             JOIN {dbq}.sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
             JOIN {dbq}.sys.columns c ON c.object_id = i.object_id AND c.column_id = ic.column_id \
             JOIN {dbq}.sys.objects o ON o.object_id = i.object_id \
             JOIN {dbq}.sys.schemas s ON s.schema_id = o.schema_id \
             WHERE s.name = @P1 AND o.name = @P2 AND i.type > 0 AND ic.is_included_column = 0 \
             ORDER BY i.name, ic.key_ordinal"
        );
        let idx_rows = self.fetch_rows(&idx_sql, &sp()).await?;
        let mut idx_map: std::collections::BTreeMap<String, (bool, bool, Vec<String>)> =
            Default::default();
        for r in &idx_rows {
            let name = s_at(r, "idx").to_string();
            if name.is_empty() {
                continue;
            }
            let uniq = i_at(r, "uniq").unwrap_or(0) != 0;
            let pk = i_at(r, "pk").unwrap_or(0) != 0;
            let col = s_at(r, "col").to_string();
            let e = idx_map.entry(name).or_insert((uniq, pk, Vec::new()));
            e.2.push(col);
        }
        let indexes = idx_map
            .into_iter()
            .map(|(name, (unique, primary, columns))| IndexInfo {
                name,
                columns,
                unique,
                primary,
            })
            .collect();

        // 外键
        let fk_sql = format!(
            "SELECT fk.name AS fkname, pc.name AS col, rt.name AS ref_table, rc.name AS ref_col \
             FROM {dbq}.sys.foreign_keys fk \
             JOIN {dbq}.sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id \
             JOIN {dbq}.sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id \
             JOIN {dbq}.sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id \
             JOIN {dbq}.sys.objects rt ON rt.object_id = fk.referenced_object_id \
             JOIN {dbq}.sys.objects po ON po.object_id = fk.parent_object_id \
             JOIN {dbq}.sys.schemas s ON s.schema_id = po.schema_id \
             WHERE s.name = @P1 AND po.name = @P2 ORDER BY fk.name, fkc.constraint_column_id"
        );
        let fk_rows = self.fetch_rows(&fk_sql, &sp()).await?;
        let mut fk_map: std::collections::BTreeMap<String, ForeignKeyInfo> = Default::default();
        for r in &fk_rows {
            let name = s_at(r, "fkname").to_string();
            if name.is_empty() {
                continue;
            }
            let col = s_at(r, "col").to_string();
            let ref_table = s_at(r, "ref_table").to_string();
            let ref_col = s_at(r, "ref_col").to_string();
            let e = fk_map.entry(name.clone()).or_insert(ForeignKeyInfo {
                name,
                columns: Vec::new(),
                ref_table,
                ref_columns: Vec::new(),
            });
            e.columns.push(col);
            e.ref_columns.push(ref_col);
        }

        Ok(TableSchema {
            table: t.clone(),
            columns,
            indexes,
            foreign_keys: fk_map.into_values().collect(),
        })
    }

    async fn table_ddl(&self, t: &TableRef) -> Result<String> {
        // 一期：简化版 DDL（列 + 主键 + 非主键索引），与 PG 适配器一致。
        let schema = self.table_schema(t).await?;
        let qt = self.caps.quote_table(t)?;
        let mut lines: Vec<String> = Vec::new();
        for c in &schema.columns {
            let mut line = format!("  {} {}", self.caps.quote_ident(&c.name)?, c.db_type);
            if !c.nullable {
                line.push_str(" NOT NULL");
            }
            if let Some(d) = &c.default {
                line.push_str(&format!(" DEFAULT {d}"));
            }
            lines.push(line);
        }
        let pk: Vec<String> = schema
            .columns
            .iter()
            .filter(|c| c.is_primary_key)
            .map(|c| c.name.clone())
            .collect();
        if !pk.is_empty() {
            let cols = pk
                .iter()
                .map(|c| self.caps.quote_ident(c))
                .collect::<Result<Vec<_>>>()?
                .join(", ");
            lines.push(format!("  PRIMARY KEY ({cols})"));
        }
        let mut ddl = format!("CREATE TABLE {qt} (\n{}\n);", lines.join(",\n"));
        for idx in &schema.indexes {
            if idx.primary {
                continue;
            }
            let cols = idx
                .columns
                .iter()
                .map(|c| self.caps.quote_ident(c))
                .collect::<Result<Vec<_>>>()?
                .join(", ");
            let unique = if idx.unique { "UNIQUE " } else { "" };
            ddl.push_str(&format!(
                "\nCREATE {unique}INDEX {} ON {qt} ({cols});",
                self.caps.quote_ident(&idx.name)?
            ));
        }
        Ok(ddl)
    }

    async fn row_identifier(&self, t: &TableRef) -> Result<Option<Vec<String>>> {
        let schema = self.table_schema(t).await?;
        let pk: Vec<String> = schema
            .columns
            .iter()
            .filter(|c| c.is_primary_key)
            .map(|c| c.name.clone())
            .collect();
        if !pk.is_empty() {
            return Ok(Some(pk));
        }
        let not_null: std::collections::HashSet<&str> = schema
            .columns
            .iter()
            .filter(|c| !c.nullable)
            .map(|c| c.name.as_str())
            .collect();
        for idx in &schema.indexes {
            if idx.unique
                && !idx.columns.is_empty()
                && idx.columns.iter().all(|c| not_null.contains(c.as_str()))
            {
                return Ok(Some(idx.columns.clone()));
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_db_type_variants() {
        assert_eq!(
            build_db_type("varchar", Some(255), None, None),
            "varchar(255)"
        );
        assert_eq!(
            build_db_type("nvarchar", Some(-1), None, None),
            "nvarchar(max)"
        );
        assert_eq!(
            build_db_type("decimal", None, Some(10), Some(2)),
            "decimal(10,2)"
        );
        assert_eq!(build_db_type("int", None, None, None), "int");
    }

    #[test]
    fn kind_and_typename_mapping() {
        assert_eq!(kind_of("int4"), "Int");
        assert_eq!(kind_of("bitn"), "Bool");
        assert_eq!(kind_of("decimaln"), "Decimal");
        assert_eq!(kind_of("nvarchar"), "Text");
        assert_eq!(typename_of("int8"), "bigint");
        assert_eq!(typename_of("datetime2"), "datetime2");
    }

    #[test]
    fn bracket_escapes() {
        assert_eq!(bracket("db"), "[db]");
        assert_eq!(bracket("we]rd"), "[we]]rd]");
    }

    #[test]
    fn hex_roundtrip() {
        assert_eq!(hex_to_bytes("00ff10"), vec![0x00, 0xff, 0x10]);
    }
}
