//! PostgreSQL 适配器（TDD §4.2 / T1.4）。
//!
//! - 连接池：`PgPool`（min 0 / max 5）。
//! - schema 支持（`supports_schemas = true`）。
//! - 取消：记录 `pg_backend_pid()`，另开连接 `SELECT pg_cancel_backend(pid)`。
//! - 元数据：`pg_catalog` 系统表；jsonb/numeric/数组/bytea 映射见 type_map。

use super::type_map::postgres_kind;
use super::{DbAdapter, DbCapabilities};
use crate::models::*;
use async_trait::async_trait;
use dashmap::DashMap;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgRow, PgSslMode};
use sqlx::{Column, Row, TypeInfo};

pub struct PostgresAdapter {
    caps: DbCapabilities,
    pool: Option<sqlx::PgPool>,
    backends: DashMap<String, i32>,
    opts: Option<PgConnectOptions>,
}

impl PostgresAdapter {
    pub fn new() -> Self {
        Self {
            caps: DbCapabilities {
                supports_ssh: true,
                supports_cancel: true,
                supports_schemas: true,
                supports_multi_database: true,
                supports_use_database: false,
                param_style: ParamStyle::Dollar,
                quote_char: '"',
                has_rowid_fallback: false,
            },
            pool: None,
            backends: DashMap::new(),
            opts: None,
        }
    }

    fn pool(&self) -> Result<&sqlx::PgPool> {
        self.pool
            .as_ref()
            .ok_or_else(|| AppError::Internal("pg pool not connected".into()))
    }
}

impl Default for PostgresAdapter {
    fn default() -> Self {
        Self::new()
    }
}

fn sql_err(e: sqlx::Error) -> AppError {
    AppError::Sql {
        message: e.to_string(),
        position: None,
    }
}

fn bytes_value(b: &[u8]) -> Value {
    const PREVIEW: usize = 64;
    let preview_hex = b.iter().take(PREVIEW).map(|x| format!("{x:02x}")).collect();
    Value::Bytes {
        len: b.len(),
        preview_hex,
    }
}

fn decode_row(row: &PgRow) -> Result<Vec<Value>> {
    let mut out = Vec::with_capacity(row.len());
    for (i, col) in row.columns().iter().enumerate() {
        let db_type = col.type_info().name().to_string();
        let kind = postgres_kind(&db_type);
        out.push(decode_cell(row, i, kind)?);
    }
    Ok(out)
}

fn decode_cell(row: &PgRow, i: usize, kind: &str) -> Result<Value> {
    if row
        .try_get_raw(i)
        .map(|r| sqlx::ValueRef::is_null(&r))
        .unwrap_or(true)
    {
        return Ok(Value::Null);
    }
    let v = match kind {
        "Bool" => Value::Bool(row.try_get::<bool, _>(i).map_err(sql_err)?),
        "Int" => Value::Int(get_int(row, i)?),
        "Float" => Value::Float(row.try_get::<f64, _>(i).map_err(sql_err)?),
        "Decimal" => Value::Decimal(string_via(row, i)),
        "Json" => row
            .try_get::<serde_json::Value, _>(i)
            .map(Value::Json)
            .unwrap_or_else(|_| Value::Text(string_via(row, i))),
        "Bytes" => {
            let b: Vec<u8> = row.try_get(i).map_err(sql_err)?;
            bytes_value(&b)
        }
        "Array" => decode_text_array(row, i),
        "Date" => Value::Date(string_via(row, i)),
        "Time" => Value::Time(string_via(row, i)),
        "DateTime" => Value::DateTime(string_via(row, i)),
        _ => Value::Text(string_via(row, i)),
    };
    Ok(v)
}

/// 整数列按宽度逐一尝试：bigint→i64、int/serial→i32、smallint→i16。
/// PG 的 sqlx 解码按 SQL 类型严格匹配，不能用 i64 取 int4（TDD §4 类型映射）。
fn get_int(row: &PgRow, i: usize) -> Result<i64> {
    match row.try_get::<i64, _>(i) {
        Ok(n) => Ok(n),
        Err(e) => {
            if let Ok(n) = row.try_get::<i32, _>(i) {
                return Ok(n as i64);
            }
            if let Ok(n) = row.try_get::<i16, _>(i) {
                return Ok(n as i64);
            }
            // oid（u32）等少见整数类型回退为文本，避免解码失败中断整行。
            if let Ok(o) = row.try_get::<sqlx::postgres::types::Oid, _>(i) {
                return Ok(o.0 as i64);
            }
            Err(sql_err(e))
        }
    }
}

/// 尝试以文本读取（numeric / 时间类型常需经文本保真）。
fn string_via(row: &PgRow, i: usize) -> String {
    if let Ok(s) = row.try_get::<String, _>(i) {
        return s;
    }
    // numeric -> rust_decimal
    if let Ok(d) = row.try_get::<rust_decimal::Decimal, _>(i) {
        return d.to_string();
    }
    // 时间类型：PG 二进制协议返回二进制（非文本），用 chrono 解码后格式化。
    // 顺序：timestamp(无 tz) → timestamptz(带 tz，统一 UTC 展示) → date → time。
    if let Ok(dt) = row.try_get::<chrono::NaiveDateTime, _>(i) {
        return dt.format("%Y-%m-%d %H:%M:%S%.f").to_string();
    }
    if let Ok(dt) = row.try_get::<chrono::DateTime<chrono::Utc>, _>(i) {
        return dt.format("%Y-%m-%d %H:%M:%S%.f%:z").to_string();
    }
    if let Ok(d) = row.try_get::<chrono::NaiveDate, _>(i) {
        return d.format("%Y-%m-%d").to_string();
    }
    if let Ok(tm) = row.try_get::<chrono::NaiveTime, _>(i) {
        return tm.format("%H:%M:%S%.f").to_string();
    }
    String::new()
}

/// 文本数组：优先按 `Vec<String>` 取，回退为单元素文本。
fn decode_text_array(row: &PgRow, i: usize) -> Value {
    if let Ok(v) = row.try_get::<Vec<String>, _>(i) {
        return Value::Array(v.into_iter().map(Value::Text).collect());
    }
    if let Ok(v) = row.try_get::<Vec<i64>, _>(i) {
        return Value::Array(v.into_iter().map(Value::Int).collect());
    }
    if let Ok(v) = row.try_get::<Vec<i32>, _>(i) {
        return Value::Array(v.into_iter().map(|n| Value::Int(n as i64)).collect());
    }
    Value::Text(string_via(row, i))
}

fn bind_params<'q>(
    mut q: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    params: &'q [Value],
) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    for p in params {
        q = match p {
            Value::Null => q.bind(Option::<String>::None),
            Value::Bool(b) => q.bind(*b),
            Value::Int(n) => q.bind(*n),
            Value::UInt(n) => q.bind(*n as i64),
            Value::Float(f) => q.bind(*f),
            Value::Decimal(s) | Value::Text(s) | Value::Unknown(s) => q.bind(s.clone()),
            Value::Date(s) | Value::Time(s) | Value::DateTime(s) => q.bind(s.clone()),
            Value::Json(j) => q.bind(j.clone()),
            Value::Bytes { preview_hex, .. } => q.bind(preview_hex.clone()),
            Value::Array(_) => q.bind(serde_json::to_string(p).unwrap_or_default()),
        };
    }
    q
}

#[async_trait]
impl DbAdapter for PostgresAdapter {
    fn capabilities(&self) -> &DbCapabilities {
        &self.caps
    }

    fn sql_dialect(&self) -> SqlDialect {
        SqlDialect {
            quote_char: '"',
            bool_keywords: true,
            backslash_strings: false,
            bytes: BytesLiteral::PgHex,
        }
    }

    async fn connect(&mut self, target: &ConnTarget) -> Result<()> {
        let mut opts = PgConnectOptions::new()
            .host(&target.host)
            .port(target.port)
            .username(&target.user)
            .ssl_mode(match target.ssl_mode {
                SslMode::Disable => PgSslMode::Disable,
                SslMode::Prefer => PgSslMode::Prefer,
                SslMode::Require => PgSslMode::Require,
            });
        if let Some(pw) = &target.password {
            opts = opts.password(pw);
        }
        // PG 一个连接绑定一个库；留空时默认连到始终存在的 `postgres`，以便列出全部库。
        let db = target
            .database
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("postgres");
        opts = opts.database(db);
        let pool = PgPoolOptions::new()
            .min_connections(0)
            .max_connections(5)
            .acquire_timeout(std::time::Duration::from_secs(
                target.connect_timeout_secs.max(1),
            ))
            .connect_with(opts.clone())
            .await
            .map_err(AppError::from)?;
        self.pool = Some(pool);
        self.opts = Some(opts);
        Ok(())
    }

    async fn disconnect(&mut self) {
        if let Some(p) = self.pool.take() {
            p.close().await;
        }
        self.backends.clear();
    }

    async fn ping(&self) -> Result<()> {
        sqlx::query("SELECT 1").execute(self.pool()?).await?;
        Ok(())
    }

    async fn query(&self, query_id: &str, sql: &str, params: &[Value]) -> Result<RawResultSet> {
        let pool = self.pool()?;
        let mut conn = pool.acquire().await.map_err(AppError::from)?;
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(&mut *conn)
            .await
            .map_err(AppError::from)?;
        self.backends.insert(query_id.to_string(), pid);

        let result = bind_params(sqlx::query(sql), params)
            .fetch_all(&mut *conn)
            .await;
        self.backends.remove(query_id);
        let rows = result.map_err(AppError::from)?;

        let columns = if let Some(first) = rows.first() {
            first
                .columns()
                .iter()
                .map(|c| {
                    let db_type = c.type_info().name().to_string();
                    ColumnMeta {
                        name: c.name().to_string(),
                        value_kind: postgres_kind(&db_type).to_string(),
                        db_type,
                        nullable: true,
                        is_primary_key: false,
                    }
                })
                .collect()
        } else {
            Vec::new()
        };

        let mut out_rows = Vec::with_capacity(rows.len());
        for r in &rows {
            out_rows.push(decode_row(r)?);
        }
        Ok(RawResultSet {
            columns,
            rows: out_rows,
        })
    }

    async fn execute(&self, _query_id: &str, sql: &str, params: &[Value]) -> Result<ExecResult> {
        let res = bind_params(sqlx::query(sql), params)
            .execute(self.pool()?)
            .await
            .map_err(AppError::from)?;
        Ok(ExecResult {
            affected_rows: res.rows_affected(),
            last_insert_id: None,
        })
    }

    async fn cancel(&self, query_id: &str) -> Result<()> {
        let Some((_, pid)) = self.backends.remove(query_id) else {
            return Ok(());
        };
        let opts = self
            .opts
            .clone()
            .ok_or_else(|| AppError::Internal("pg opts missing".into()))?;
        use sqlx::ConnectOptions;
        let mut conn = opts.connect().await.map_err(AppError::from)?;
        sqlx::query("SELECT pg_cancel_backend($1)")
            .bind(pid)
            .execute(&mut conn)
            .await
            .map_err(AppError::from)?;
        Ok(())
    }

    async fn execute_in_transaction(
        &self,
        stmts: Vec<(String, Vec<Value>)>,
    ) -> Result<Vec<ExecResult>> {
        let mut tx = self.pool()?.begin().await.map_err(AppError::from)?;
        let mut results = Vec::with_capacity(stmts.len());
        for (sql, params) in &stmts {
            let res = bind_params(sqlx::query(sql), params)
                .execute(&mut *tx)
                .await
                .map_err(AppError::from)?;
            results.push(ExecResult {
                affected_rows: res.rows_affected(),
                last_insert_id: None,
            });
        }
        tx.commit().await.map_err(AppError::from)?;
        Ok(results)
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let rows = sqlx::query(
            "SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname",
        )
        .fetch_all(self.pool()?)
        .await
        .map_err(AppError::from)?;
        Ok(rows
            .iter()
            .filter_map(|r| r.try_get::<String, _>(0).ok())
            .map(|name| DatabaseInfo { name })
            .collect())
    }

    async fn list_schemas(&self, _db: &str) -> Result<Vec<String>> {
        let rows = sqlx::query(
            "SELECT nspname FROM pg_namespace \
             WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema' ORDER BY nspname",
        )
        .fetch_all(self.pool()?)
        .await
        .map_err(AppError::from)?;
        Ok(rows
            .iter()
            .filter_map(|r| r.try_get::<String, _>(0).ok())
            .collect())
    }

    async fn list_tables(&self, _db: &str, schema: Option<&str>) -> Result<Vec<TableInfo>> {
        let schema = schema.unwrap_or("public");
        let rows = sqlx::query(
            "SELECT c.relname, c.relkind FROM pg_class c \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relkind IN ('r','v','m','p') ORDER BY c.relname",
        )
        .bind(schema)
        .fetch_all(self.pool()?)
        .await
        .map_err(AppError::from)?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                let name: String = r.try_get("relname").ok()?;
                let kind: String = r.try_get("relkind").unwrap_or_default();
                Some(TableInfo {
                    name,
                    kind: if kind == "v" || kind == "m" {
                        TableKind::View
                    } else {
                        TableKind::Table
                    },
                })
            })
            .collect())
    }

    async fn list_functions(&self, _db: &str, schema: Option<&str>) -> Result<Vec<RoutineInfo>> {
        let schema = schema.unwrap_or("public");
        let rows = sqlx::query(
            "SELECT p.oid::int8 AS oid, p.proname, p.prokind FROM pg_proc p \
             JOIN pg_namespace n ON n.oid = p.pronamespace \
             WHERE n.nspname = $1 AND p.prokind IN ('f','p') ORDER BY p.proname",
        )
        .bind(schema)
        .fetch_all(self.pool()?)
        .await
        .map_err(AppError::from)?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                let name: String = r.try_get("proname").ok()?;
                let kind: String = r.try_get("prokind").unwrap_or_default();
                Some(RoutineInfo {
                    name,
                    kind: if kind == "p" {
                        RoutineKind::Procedure
                    } else {
                        RoutineKind::Function
                    },
                    id: r.try_get("oid").ok(),
                })
            })
            .collect())
    }

    async fn function_ddl(&self, r: &RoutineRef) -> Result<String> {
        let pool = self.pool()?;
        // 优先用元数据带出的 oid 精确定位（同名重载唯一）；缺失时按 schema + 名称回退取首个。
        let oid: i64 = if let Some(id) = r.id {
            id
        } else {
            let schema = r.schema.as_deref().unwrap_or("public");
            let row = sqlx::query(
                "SELECT p.oid::int8 AS oid FROM pg_proc p \
                 JOIN pg_namespace n ON n.oid = p.pronamespace \
                 WHERE n.nspname = $1 AND p.proname = $2 ORDER BY p.oid LIMIT 1",
            )
            .bind(schema)
            .bind(&r.name)
            .fetch_optional(pool)
            .await
            .map_err(AppError::from)?
            .ok_or_else(|| AppError::NotEditable(format!("function not found: {}", r.name)))?;
            row.try_get("oid").map_err(sql_err)?
        };
        let row = sqlx::query("SELECT pg_get_functiondef($1::oid) AS def")
            .bind(oid)
            .fetch_one(pool)
            .await
            .map_err(AppError::from)?;
        row.try_get("def").map_err(sql_err)
    }

    async fn create_function(&self, definition: &str) -> Result<()> {
        // 整体执行，用简单查询协议（非预处理），稳妥处理含 $$ 体的 DDL。
        use sqlx::Executor;
        self.pool()?
            .execute(definition)
            .await
            .map_err(AppError::from)?;
        Ok(())
    }

    async fn replace_function(&self, _r: &RoutineRef, definition: &str) -> Result<()> {
        // pg_get_functiondef 输出为 CREATE OR REPLACE FUNCTION，整体执行即原地更新。
        self.create_function(definition).await
    }

    async fn table_schema(&self, t: &TableRef) -> Result<TableSchema> {
        let pool = self.pool()?;
        let schema = t.schema.as_deref().unwrap_or("public");

        let col_rows = sqlx::query(
            "SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS dtype, a.attnotnull, \
                    pg_get_expr(ad.adbin, ad.adrelid) AS dflt, \
                    col_description(c.oid, a.attnum) AS comment, \
                    EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary \
                            AND a.attnum = ANY(i.indkey)) AS is_pk \
             FROM pg_attribute a \
             JOIN pg_class c ON c.oid = a.attrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum \
             WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum",
        )
        .bind(schema)
        .bind(&t.name)
        .fetch_all(pool)
        .await
        .map_err(AppError::from)?;
        let mut columns = Vec::new();
        for r in &col_rows {
            let name: String = r.try_get("attname").map_err(sql_err)?;
            let db_type: String = r.try_get("dtype").map_err(sql_err)?;
            let notnull: bool = r.try_get("attnotnull").unwrap_or(false);
            let default: Option<String> = r.try_get("dflt").ok();
            let comment: Option<String> = r.try_get("comment").ok();
            let is_pk: bool = r.try_get("is_pk").unwrap_or(false);
            columns.push(ColumnInfo {
                name,
                value_kind: postgres_kind(&db_type).to_string(),
                db_type,
                nullable: !notnull,
                default,
                is_primary_key: is_pk,
                comment,
            });
        }

        let idx_rows = sqlx::query(
            "SELECT i.relname AS idx, ix.indisunique, ix.indisprimary, \
                    array_to_string(array_agg(a.attname ORDER BY x.ord), ',') AS cols \
             FROM pg_index ix \
             JOIN pg_class c ON c.oid = ix.indrelid \
             JOIN pg_class i ON i.oid = ix.indexrelid \
             JOIN pg_namespace n ON n.oid = c.relnamespace \
             JOIN unnest(ix.indkey) WITH ORDINALITY AS x(attnum, ord) ON true \
             JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = x.attnum \
             WHERE n.nspname = $1 AND c.relname = $2 \
             GROUP BY i.relname, ix.indisunique, ix.indisprimary",
        )
        .bind(schema)
        .bind(&t.name)
        .fetch_all(pool)
        .await
        .map_err(AppError::from)?;
        let indexes = idx_rows
            .iter()
            .map(|r| {
                let cols: String = r.try_get("cols").unwrap_or_default();
                IndexInfo {
                    name: r.try_get::<String, _>("idx").unwrap_or_default(),
                    columns: cols
                        .split(',')
                        .filter(|s| !s.is_empty())
                        .map(String::from)
                        .collect(),
                    unique: r.try_get("indisunique").unwrap_or(false),
                    primary: r.try_get("indisprimary").unwrap_or(false),
                }
            })
            .collect();

        Ok(TableSchema {
            table: t.clone(),
            columns,
            indexes,
            foreign_keys: Vec::new(),
        })
    }

    async fn table_ddl(&self, t: &TableRef) -> Result<String> {
        // 一期：简化版 DDL（列 + 主键 + 索引），TDD §14 决策点 1。
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

    async fn table_options(&self, t: &TableRef) -> Result<TableOptions> {
        // PG 无引擎/字符集概念；仅读表注释。
        let schema = t.schema.as_deref().unwrap_or("public");
        let row = sqlx::query(
            "SELECT obj_description(c.oid) \
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relname = $1 AND n.nspname = $2",
        )
        .bind(&t.name)
        .bind(schema)
        .fetch_optional(self.pool()?)
        .await
        .map_err(AppError::from)?;
        let comment = row
            .and_then(|r| r.try_get::<Option<String>, _>(0).ok().flatten())
            .filter(|c| !c.is_empty());
        Ok(TableOptions {
            comment,
            ..Default::default()
        })
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
