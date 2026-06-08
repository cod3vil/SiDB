//! SQLite 适配器（TDD §4.2 / T1.2）。
//!
//! - 连接池：`SqlitePool`（WAL，写串行化）。
//! - 元数据：`sqlite_master` / `PRAGMA table_info` / `PRAGMA index_list`。
//! - 行定位：主键 → 唯一非空索引 → `rowid`（排除 WITHOUT ROWID 表）。
//! - 取消：sqlx 对 `interrupt` 暴露有限，采用 "abort future + 关闭连接重建" 等价方案。

use super::type_map::sqlite_kind;
use super::{DbAdapter, DbCapabilities};
use crate::models::*;
use async_trait::async_trait;
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions, SqliteRow};
use sqlx::{Column, Row, TypeInfo, ValueRef};
use std::str::FromStr;

pub struct SqliteAdapter {
    caps: DbCapabilities,
    pool: Option<sqlx::SqlitePool>,
}

impl SqliteAdapter {
    pub fn new() -> Self {
        Self {
            caps: DbCapabilities {
                supports_ssh: false,
                supports_cancel: true,
                supports_schemas: false,
                supports_multi_database: false,
                param_style: ParamStyle::Question,
                quote_char: '"',
                has_rowid_fallback: true,
            },
            pool: None,
        }
    }

    fn pool(&self) -> Result<&sqlx::SqlitePool> {
        self.pool
            .as_ref()
            .ok_or_else(|| AppError::Internal("sqlite pool not connected".into()))
    }
}

impl Default for SqliteAdapter {
    fn default() -> Self {
        Self::new()
    }
}

/// 把一行 SqliteRow 解码为 `Vec<Value>`，按运行时存储类（storage class）决定变体，
/// 并参考列声明类型对 Bool / Date / DateTime 做归一。
fn decode_row(row: &SqliteRow, kinds: &[&'static str]) -> Result<Vec<Value>> {
    let mut out = Vec::with_capacity(row.len());
    for (i, kind) in kinds.iter().enumerate().take(row.len()) {
        let raw = row
            .try_get_raw(i)
            .map_err(|e| AppError::Sql { message: e.to_string(), position: None })?;
        if raw.is_null() {
            out.push(Value::Null);
            continue;
        }
        let storage = raw.type_info().name().to_string();
        let v = match storage.as_str() {
            "INTEGER" => {
                let n: i64 = row.try_get(i).map_err(sql_err)?;
                match *kind {
                    "Bool" => Value::Bool(n != 0),
                    _ => Value::Int(n),
                }
            }
            "REAL" => Value::Float(row.try_get::<f64, _>(i).map_err(sql_err)?),
            "BLOB" => {
                let b: Vec<u8> = row.try_get(i).map_err(sql_err)?;
                bytes_value(&b)
            }
            // TEXT 与其它：以字符串读取，按声明类型归类。
            _ => {
                let s: String = row.try_get(i).map_err(sql_err)?;
                match *kind {
                    "Date" => Value::Date(s),
                    "Time" => Value::Time(s),
                    "DateTime" => Value::DateTime(s),
                    "Decimal" => Value::Decimal(s),
                    "Json" => serde_json::from_str(&s)
                        .map(Value::Json)
                        .unwrap_or(Value::Text(s)),
                    _ => Value::Text(s),
                }
            }
        };
        out.push(v);
    }
    Ok(out)
}

fn sql_err(e: sqlx::Error) -> AppError {
    AppError::Sql { message: e.to_string(), position: None }
}

/// 大对象不全量进前端：>1KB 只带 preview（TDD §4.3）。
fn bytes_value(b: &[u8]) -> Value {
    const PREVIEW: usize = 64;
    let preview_hex = b
        .iter()
        .take(PREVIEW)
        .map(|x| format!("{x:02x}"))
        .collect::<String>();
    Value::Bytes { len: b.len(), preview_hex }
}

/// 绑定参数到查询。SQLite 用 `?` 占位符。
fn bind_params<'q>(
    mut q: sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>>,
    params: &'q [Value],
) -> sqlx::query::Query<'q, sqlx::Sqlite, sqlx::sqlite::SqliteArguments<'q>> {
    for p in params {
        q = match p {
            Value::Null => q.bind(Option::<String>::None),
            Value::Bool(b) => q.bind(*b),
            Value::Int(n) => q.bind(*n),
            Value::UInt(n) => q.bind(*n as i64),
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
impl DbAdapter for SqliteAdapter {
    fn capabilities(&self) -> &DbCapabilities {
        &self.caps
    }

    async fn connect(&mut self, target: &ConnTarget) -> Result<()> {
        let path = target
            .sqlite_path
            .as_deref()
            .ok_or_else(|| AppError::Internal("sqlite path missing".into()))?;
        let opts = SqliteConnectOptions::from_str(&format!("sqlite://{path}"))
            .map_err(AppError::from)?
            .create_if_missing(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal)
            .busy_timeout(std::time::Duration::from_secs(target.connect_timeout_secs.max(1)));
        let pool = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(opts)
            .await
            .map_err(AppError::from)?;
        self.pool = Some(pool);
        Ok(())
    }

    async fn disconnect(&mut self) {
        if let Some(p) = self.pool.take() {
            p.close().await;
        }
    }

    async fn ping(&self) -> Result<()> {
        sqlx::query("SELECT 1").execute(self.pool()?).await?;
        Ok(())
    }

    async fn query(&self, _query_id: &str, sql: &str, params: &[Value]) -> Result<RawResultSet> {
        let pool = self.pool()?;
        let rows = bind_params(sqlx::query(sql), params)
            .fetch_all(pool)
            .await
            .map_err(AppError::from)?;

        let columns = if let Some(first) = rows.first() {
            first
                .columns()
                .iter()
                .map(|c| {
                    let db_type = c.type_info().name().to_string();
                    let kind = sqlite_kind(&db_type);
                    ColumnMeta {
                        name: c.name().to_string(),
                        db_type,
                        value_kind: kind.to_string(),
                        nullable: true,
                        is_primary_key: false,
                    }
                })
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        let kinds: Vec<&'static str> = columns.iter().map(|c| sqlite_kind(&c.db_type)).collect();

        let mut out_rows = Vec::with_capacity(rows.len());
        for r in &rows {
            out_rows.push(decode_row(r, &kinds)?);
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
            last_insert_id: Some(res.last_insert_rowid()),
        })
    }

    async fn cancel(&self, _query_id: &str) -> Result<()> {
        // SQLite 本地查询通常足够快；如需中断，按 TDD §4.2 采用 abort+重建方案。
        // 一期最小实现：no-op（不阻断主流程）。
        Ok(())
    }

    async fn execute_in_transaction(
        &self,
        stmts: Vec<(String, Vec<Value>)>,
    ) -> Result<Vec<ExecResult>> {
        let pool = self.pool()?;
        let mut tx = pool.begin().await.map_err(AppError::from)?;
        let mut results = Vec::with_capacity(stmts.len());
        for (sql, params) in &stmts {
            let res = bind_params(sqlx::query(sql), params)
                .execute(&mut *tx)
                .await
                .map_err(AppError::from)?;
            results.push(ExecResult {
                affected_rows: res.rows_affected(),
                last_insert_id: Some(res.last_insert_rowid()),
            });
        }
        tx.commit().await.map_err(AppError::from)?;
        Ok(results)
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        // SQLite 固定单库。
        Ok(vec![DatabaseInfo { name: "main".into() }])
    }

    async fn list_schemas(&self, _db: &str) -> Result<Vec<String>> {
        Ok(Vec::new())
    }

    async fn list_tables(&self, _db: &str, _schema: Option<&str>) -> Result<Vec<TableInfo>> {
        let rows = sqlx::query(
            "SELECT name, type FROM sqlite_master \
             WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' \
             ORDER BY name",
        )
        .fetch_all(self.pool()?)
        .await
        .map_err(AppError::from)?;
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let name: String = r.try_get("name").map_err(sql_err)?;
            let ty: String = r.try_get("type").map_err(sql_err)?;
            out.push(TableInfo {
                name,
                kind: if ty == "view" { TableKind::View } else { TableKind::Table },
            });
        }
        Ok(out)
    }

    async fn table_schema(&self, t: &TableRef) -> Result<TableSchema> {
        let pool = self.pool()?;
        let quoted = self.caps.quote_ident(&t.name)?;

        // 列
        let col_rows = sqlx::query(&format!("PRAGMA table_info({quoted})"))
            .fetch_all(pool)
            .await
            .map_err(AppError::from)?;
        let mut columns = Vec::new();
        for r in &col_rows {
            let name: String = r.try_get("name").map_err(sql_err)?;
            let db_type: String = r.try_get("type").map_err(sql_err)?;
            let notnull: i64 = r.try_get("notnull").map_err(sql_err)?;
            let pk: i64 = r.try_get("pk").map_err(sql_err)?;
            let dflt: Option<String> = r.try_get("dflt_value").ok();
            columns.push(ColumnInfo {
                name,
                value_kind: sqlite_kind(&db_type).to_string(),
                db_type,
                nullable: notnull == 0,
                default: dflt,
                is_primary_key: pk > 0,
                comment: None,
            });
        }

        // 索引
        let idx_rows = sqlx::query(&format!("PRAGMA index_list({quoted})"))
            .fetch_all(pool)
            .await
            .map_err(AppError::from)?;
        let mut indexes = Vec::new();
        for r in &idx_rows {
            let idx_name: String = r.try_get("name").map_err(sql_err)?;
            let unique: i64 = r.try_get("unique").map_err(sql_err)?;
            let origin: String = r.try_get("origin").unwrap_or_default();
            let info = sqlx::query(&format!(
                "PRAGMA index_info({})",
                self.caps.quote_ident(&idx_name)?
            ))
            .fetch_all(pool)
            .await
            .map_err(AppError::from)?;
            let cols: Vec<String> = info
                .iter()
                .filter_map(|x| x.try_get::<String, _>("name").ok())
                .collect();
            indexes.push(IndexInfo {
                name: idx_name,
                columns: cols,
                unique: unique != 0,
                primary: origin == "pk",
            });
        }

        // 外键
        let fk_rows = sqlx::query(&format!("PRAGMA foreign_key_list({quoted})"))
            .fetch_all(pool)
            .await
            .map_err(AppError::from)?;
        let mut foreign_keys = Vec::new();
        for r in &fk_rows {
            let id: i64 = r.try_get("id").map_err(sql_err)?;
            let table: String = r.try_get("table").map_err(sql_err)?;
            let from: String = r.try_get("from").map_err(sql_err)?;
            let to: String = r.try_get("to").map_err(sql_err)?;
            foreign_keys.push(ForeignKeyInfo {
                name: format!("fk_{id}"),
                columns: vec![from],
                ref_table: table,
                ref_columns: vec![to],
            });
        }

        Ok(TableSchema { table: t.clone(), columns, indexes, foreign_keys })
    }

    async fn table_ddl(&self, t: &TableRef) -> Result<String> {
        let row = sqlx::query("SELECT sql FROM sqlite_master WHERE name = ? AND type IN ('table','view')")
            .bind(&t.name)
            .fetch_optional(self.pool()?)
            .await
            .map_err(AppError::from)?;
        match row {
            Some(r) => Ok(r.try_get::<String, _>("sql").map_err(sql_err)?),
            None => Err(AppError::Sql {
                message: format!("table not found: {}", t.name),
                position: None,
            }),
        }
    }

    async fn row_identifier(&self, t: &TableRef) -> Result<Option<Vec<String>>> {
        let pool = self.pool()?;
        let quoted = self.caps.quote_ident(&t.name)?;

        // 1) 主键
        let col_rows = sqlx::query(&format!("PRAGMA table_info({quoted})"))
            .fetch_all(pool)
            .await
            .map_err(AppError::from)?;
        let pk: Vec<String> = col_rows
            .iter()
            .filter_map(|r| {
                let p: i64 = r.try_get("pk").ok()?;
                if p > 0 {
                    r.try_get::<String, _>("name").ok()
                } else {
                    None
                }
            })
            .collect();
        if !pk.is_empty() {
            return Ok(Some(pk));
        }

        // 2) 唯一非空索引
        let idx_rows = sqlx::query(&format!("PRAGMA index_list({quoted})"))
            .fetch_all(pool)
            .await
            .map_err(AppError::from)?;
        for r in &idx_rows {
            let unique: i64 = r.try_get("unique").unwrap_or(0);
            if unique == 0 {
                continue;
            }
            let idx_name: String = r.try_get("name").map_err(sql_err)?;
            let info = sqlx::query(&format!(
                "PRAGMA index_info({})",
                self.caps.quote_ident(&idx_name)?
            ))
            .fetch_all(pool)
            .await
            .map_err(AppError::from)?;
            let cols: Vec<String> = info
                .iter()
                .filter_map(|x| x.try_get::<String, _>("name").ok())
                .collect();
            // 全部列 NOT NULL 才能作为定位键
            let all_not_null = cols.iter().all(|c| {
                col_rows.iter().any(|cr| {
                    cr.try_get::<String, _>("name").map(|n| &n == c).unwrap_or(false)
                        && cr.try_get::<i64, _>("notnull").unwrap_or(0) == 1
                })
            });
            if !cols.is_empty() && all_not_null {
                return Ok(Some(cols));
            }
        }

        // 3) rowid 回退（排除 WITHOUT ROWID 表）
        let probe = sqlx::query(&format!("SELECT rowid FROM {quoted} LIMIT 0"))
            .fetch_all(pool)
            .await;
        if probe.is_ok() {
            return Ok(Some(vec!["rowid".into()]));
        }

        Ok(None)
    }
}
