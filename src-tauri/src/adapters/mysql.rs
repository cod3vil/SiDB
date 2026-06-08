//! MySQL 适配器（TDD §4.2 / T1.3）。
//!
//! - 连接池：`MySqlPool`（min 0 / max 5）。
//! - 取消：查询前记录连接 `CONNECTION_ID()`，另开连接执行 `KILL QUERY <id>`。
//! - 元数据：`information_schema.*`；DDL：`SHOW CREATE TABLE`。

use super::type_map::{is_mysql_zero_date, mysql_kind};
use super::{DbAdapter, DbCapabilities};
use crate::models::*;
use async_trait::async_trait;
use dashmap::DashMap;
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlRow};
use sqlx::{Column, Row, TypeInfo};

pub struct MySqlAdapter {
    caps: DbCapabilities,
    pool: Option<sqlx::MySqlPool>,
    /// query_id → 后端线程 ID（用于 KILL QUERY）。
    threads: DashMap<String, u64>,
    /// 取消用的连接选项（另开连接执行 KILL）。
    opts: Option<MySqlConnectOptions>,
}

impl MySqlAdapter {
    pub fn new() -> Self {
        Self {
            caps: DbCapabilities {
                supports_ssh: true,
                supports_cancel: true,
                supports_schemas: false,
                supports_multi_database: true,
                param_style: ParamStyle::Question,
                quote_char: '`',
                has_rowid_fallback: false,
            },
            pool: None,
            threads: DashMap::new(),
            opts: None,
        }
    }

    fn pool(&self) -> Result<&sqlx::MySqlPool> {
        self.pool
            .as_ref()
            .ok_or_else(|| AppError::Internal("mysql pool not connected".into()))
    }
}

impl Default for MySqlAdapter {
    fn default() -> Self {
        Self::new()
    }
}

fn sql_err(e: sqlx::Error) -> AppError {
    AppError::Sql { message: e.to_string(), position: None }
}

fn bytes_value(b: &[u8]) -> Value {
    const PREVIEW: usize = 64;
    let preview_hex = b.iter().take(PREVIEW).map(|x| format!("{x:02x}")).collect();
    Value::Bytes { len: b.len(), preview_hex }
}

fn decode_row(row: &MySqlRow) -> Result<Vec<Value>> {
    let mut out = Vec::with_capacity(row.len());
    for (i, col) in row.columns().iter().enumerate() {
        let db_type = col.type_info().name().to_string();
        let kind = mysql_kind(&db_type);
        let v = decode_cell(row, i, kind)?;
        out.push(v);
    }
    Ok(out)
}

fn decode_cell(row: &MySqlRow, i: usize, kind: &str) -> Result<Value> {
    // NULL 检查
    if row.try_get_raw(i).map(|r| sqlx::ValueRef::is_null(&r)).unwrap_or(true) {
        return Ok(Value::Null);
    }
    let v = match kind {
        "Bool" => Value::Bool(row.try_get::<i8, _>(i).map(|n| n != 0).unwrap_or(false)),
        "Int" => match row.try_get::<i64, _>(i) {
            Ok(n) => Value::Int(n),
            Err(_) => Value::UInt(row.try_get::<u64, _>(i).map_err(sql_err)?),
        },
        "Float" => Value::Float(row.try_get::<f64, _>(i).map_err(sql_err)?),
        "Decimal" => Value::Decimal(string_via_bytes(row, i)),
        "Json" => {
            let s = string_via_bytes(row, i);
            serde_json::from_str(&s).map(Value::Json).unwrap_or(Value::Text(s))
        }
        "Bytes" => {
            let b: Vec<u8> = row.try_get(i).map_err(sql_err)?;
            bytes_value(&b)
        }
        "Date" => {
            let s = string_via_bytes(row, i);
            if is_mysql_zero_date(&s) { Value::Text(s) } else { Value::Date(s) }
        }
        "Time" => Value::Time(string_via_bytes(row, i)),
        "DateTime" => {
            let s = string_via_bytes(row, i);
            if is_mysql_zero_date(&s) { Value::Text(s) } else { Value::DateTime(s) }
        }
        _ => Value::Text(string_via_bytes(row, i)),
    };
    Ok(v)
}

/// MySQL 的 DATE/DATETIME/DECIMAL 可能无法直接 try_get::<String>，
/// 退化为按原始字节解释为 UTF-8。
fn string_via_bytes(row: &MySqlRow, i: usize) -> String {
    if let Ok(s) = row.try_get::<String, _>(i) {
        return s;
    }
    match row.try_get::<Vec<u8>, _>(i) {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
        Err(_) => String::new(),
    }
}

fn bind_params<'q>(
    mut q: sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments>,
    params: &'q [Value],
) -> sqlx::query::Query<'q, sqlx::MySql, sqlx::mysql::MySqlArguments> {
    for p in params {
        q = match p {
            Value::Null => q.bind(Option::<String>::None),
            Value::Bool(b) => q.bind(*b),
            Value::Int(n) => q.bind(*n),
            Value::UInt(n) => q.bind(*n),
            Value::Float(f) => q.bind(*f),
            Value::Decimal(s) | Value::Text(s) | Value::Unknown(s) => q.bind(s.clone()),
            Value::Date(s) | Value::Time(s) | Value::DateTime(s) => q.bind(s.clone()),
            Value::Json(j) => q.bind(j.to_string()),
            Value::Bytes { preview_hex, .. } => q.bind(preview_hex.clone()),
            Value::Array(_) => q.bind(serde_json::to_string(p).unwrap_or_default()),
        };
    }
    q
}

#[async_trait]
impl DbAdapter for MySqlAdapter {
    fn capabilities(&self) -> &DbCapabilities {
        &self.caps
    }

    async fn connect(&mut self, target: &ConnTarget) -> Result<()> {
        let mut opts = MySqlConnectOptions::new()
            .host(&target.host)
            .port(target.port)
            .username(&target.user);
        if let Some(pw) = &target.password {
            opts = opts.password(pw);
        }
        if let Some(db) = &target.database {
            opts = opts.database(db);
        }
        let pool = MySqlPoolOptions::new()
            .min_connections(0)
            .max_connections(5)
            .acquire_timeout(std::time::Duration::from_secs(target.connect_timeout_secs.max(1)))
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
        self.threads.clear();
    }

    async fn ping(&self) -> Result<()> {
        sqlx::query("SELECT 1").execute(self.pool()?).await?;
        Ok(())
    }

    async fn query(&self, query_id: &str, sql: &str, params: &[Value]) -> Result<RawResultSet> {
        let pool = self.pool()?;
        // 取后端线程 ID 以支持取消。
        let mut conn = pool.acquire().await.map_err(AppError::from)?;
        let thread_id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()")
            .fetch_one(&mut *conn)
            .await
            .map_err(AppError::from)?;
        self.threads.insert(query_id.to_string(), thread_id);

        let result = bind_params(sqlx::query(sql), params).fetch_all(&mut *conn).await;
        self.threads.remove(query_id);
        let rows = result.map_err(AppError::from)?;

        let columns = if let Some(first) = rows.first() {
            first
                .columns()
                .iter()
                .map(|c| {
                    let db_type = c.type_info().name().to_string();
                    ColumnMeta {
                        name: c.name().to_string(),
                        value_kind: mysql_kind(&db_type).to_string(),
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
        Ok(RawResultSet { columns, rows: out_rows })
    }

    async fn execute(&self, _query_id: &str, sql: &str, params: &[Value]) -> Result<ExecResult> {
        let res = bind_params(sqlx::query(sql), params)
            .execute(self.pool()?)
            .await
            .map_err(AppError::from)?;
        Ok(ExecResult {
            affected_rows: res.rows_affected(),
            last_insert_id: Some(res.last_insert_id() as i64),
        })
    }

    async fn cancel(&self, query_id: &str) -> Result<()> {
        let Some((_, thread_id)) = self.threads.remove(query_id) else {
            return Ok(());
        };
        let opts = self
            .opts
            .clone()
            .ok_or_else(|| AppError::Internal("mysql opts missing".into()))?;
        // 另开一条连接执行 KILL QUERY（不复用正在跑查询的连接）。
        use sqlx::ConnectOptions;
        let mut conn = opts.connect().await.map_err(AppError::from)?;
        sqlx::query(&format!("KILL QUERY {thread_id}"))
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
                last_insert_id: Some(res.last_insert_id() as i64),
            });
        }
        tx.commit().await.map_err(AppError::from)?;
        Ok(results)
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let rows = sqlx::query(
            "SELECT schema_name FROM information_schema.schemata \
             WHERE schema_name NOT IN ('information_schema','performance_schema','mysql','sys') \
             ORDER BY schema_name",
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
        Ok(Vec::new())
    }

    async fn list_tables(&self, db: &str, _schema: Option<&str>) -> Result<Vec<TableInfo>> {
        let rows = sqlx::query(
            "SELECT table_name, table_type FROM information_schema.tables \
             WHERE table_schema = ? ORDER BY table_name",
        )
        .bind(db)
        .fetch_all(self.pool()?)
        .await
        .map_err(AppError::from)?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                let name: String = r.try_get("table_name").ok()?;
                let ty: String = r.try_get("table_type").unwrap_or_default();
                Some(TableInfo {
                    name,
                    kind: if ty.contains("VIEW") { TableKind::View } else { TableKind::Table },
                })
            })
            .collect())
    }

    async fn table_schema(&self, t: &TableRef) -> Result<TableSchema> {
        let pool = self.pool()?;
        let db = t
            .database
            .as_deref()
            .ok_or_else(|| AppError::Internal("mysql table requires database".into()))?;

        let col_rows = sqlx::query(
            "SELECT column_name, column_type, is_nullable, column_default, column_key, column_comment \
             FROM information_schema.columns WHERE table_schema = ? AND table_name = ? \
             ORDER BY ordinal_position",
        )
        .bind(db)
        .bind(&t.name)
        .fetch_all(pool)
        .await
        .map_err(AppError::from)?;
        let mut columns = Vec::new();
        for r in &col_rows {
            let name: String = r.try_get("column_name").map_err(sql_err)?;
            let db_type: String = r.try_get("column_type").map_err(sql_err)?;
            let nullable: String = r.try_get("is_nullable").unwrap_or_else(|_| "YES".into());
            let default: Option<String> = r.try_get("column_default").ok();
            let key: String = r.try_get("column_key").unwrap_or_default();
            let comment: Option<String> = r.try_get("column_comment").ok();
            columns.push(ColumnInfo {
                name,
                value_kind: mysql_kind(&db_type).to_string(),
                db_type,
                nullable: nullable.eq_ignore_ascii_case("YES"),
                default,
                is_primary_key: key == "PRI",
                comment: comment.filter(|c| !c.is_empty()),
            });
        }

        let idx_rows = sqlx::query(
            "SELECT index_name, column_name, non_unique, seq_in_index \
             FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? \
             ORDER BY index_name, seq_in_index",
        )
        .bind(db)
        .bind(&t.name)
        .fetch_all(pool)
        .await
        .map_err(AppError::from)?;
        let mut idx_map: std::collections::BTreeMap<String, (bool, Vec<String>)> = Default::default();
        for r in &idx_rows {
            let name: String = r.try_get("index_name").map_err(sql_err)?;
            let col: String = r.try_get("column_name").map_err(sql_err)?;
            let non_unique: i64 = r.try_get("non_unique").unwrap_or(1);
            let e = idx_map.entry(name).or_insert((non_unique == 0, Vec::new()));
            e.1.push(col);
        }
        let indexes = idx_map
            .into_iter()
            .map(|(name, (unique, columns))| IndexInfo {
                primary: name == "PRIMARY",
                name,
                columns,
                unique,
            })
            .collect();

        let fk_rows = sqlx::query(
            "SELECT constraint_name, column_name, referenced_table_name, referenced_column_name \
             FROM information_schema.key_column_usage \
             WHERE table_schema = ? AND table_name = ? AND referenced_table_name IS NOT NULL \
             ORDER BY constraint_name, ordinal_position",
        )
        .bind(db)
        .bind(&t.name)
        .fetch_all(pool)
        .await
        .map_err(AppError::from)?;
        let mut fk_map: std::collections::BTreeMap<String, ForeignKeyInfo> = Default::default();
        for r in &fk_rows {
            let name: String = r.try_get("constraint_name").map_err(sql_err)?;
            let col: String = r.try_get("column_name").map_err(sql_err)?;
            let ref_table: String = r.try_get("referenced_table_name").unwrap_or_default();
            let ref_col: String = r.try_get("referenced_column_name").unwrap_or_default();
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
        let quoted = self.caps.quote_table(t)?;
        let row = sqlx::query(&format!("SHOW CREATE TABLE {quoted}"))
            .fetch_one(self.pool()?)
            .await
            .map_err(AppError::from)?;
        // 第 2 列是建表语句（表/视图列名不同，按位置取）。
        row.try_get::<String, _>(1).map_err(sql_err)
    }

    async fn row_identifier(&self, t: &TableRef) -> Result<Option<Vec<String>>> {
        let schema = self.table_schema(t).await?;
        // 1) 主键
        let pk: Vec<String> = schema
            .columns
            .iter()
            .filter(|c| c.is_primary_key)
            .map(|c| c.name.clone())
            .collect();
        if !pk.is_empty() {
            return Ok(Some(pk));
        }
        // 2) 唯一索引且列全部 NOT NULL
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
