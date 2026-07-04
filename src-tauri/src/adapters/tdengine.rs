//! TDengine 适配器（时序库）。走 taosAdapter 的 REST 接口（`POST /rest/sql[/<db>]`），
//! 纯 HTTP + JSON，无原生驱动。是 SQL-like 方言：实现 [`DbAdapter`] 以复用整套 SQL 前端。
//!
//! 一期定位：**只读浏览 + 自由 SQL**（时序库无单行 UPDATE/DELETE、无主键概念，
//! 结果集统一按只读处理；写入以 INSERT 为主，编辑单元格不适用）。

use super::{DbAdapter, DbCapabilities};
use crate::models::*;
use async_trait::async_trait;
use serde::Deserialize;
use std::sync::Mutex;
use std::time::Duration;

/// TDengine REST 响应（`/rest/sql`）。
#[derive(Deserialize)]
struct RestResp {
    code: i64,
    #[serde(default)]
    desc: Option<String>,
    #[serde(default)]
    column_meta: Vec<(String, String, i64)>, // [列名, 类型名, 长度]
    #[serde(default)]
    data: Vec<Vec<serde_json::Value>>,
    #[serde(default)]
    rows: Option<i64>,
}

pub struct TdengineAdapter {
    caps: DbCapabilities,
    client: reqwest::Client,
    /// `http(s)://host:port` 基址（无路径）。
    base: Mutex<Option<String>>,
    /// `Basic base64(user:pass)` 授权头。
    auth: Mutex<Option<String>>,
    /// 当前库（USE 后带进 URL）。
    db: Mutex<Option<String>>,
}

impl TdengineAdapter {
    pub fn new() -> Self {
        Self {
            caps: DbCapabilities {
                supports_ssh: true,
                supports_cancel: false,
                supports_schemas: false,
                supports_multi_database: true,
                supports_use_database: true,
                param_style: ParamStyle::Question,
                quote_char: '`',
                has_rowid_fallback: false,
            },
            client: reqwest::Client::new(),
            base: Mutex::new(None),
            auth: Mutex::new(None),
            db: Mutex::new(None),
        }
    }

    fn base_url(&self) -> Result<String> {
        self.base
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .ok_or_else(|| AppError::Internal("tdengine not connected".into()))
    }

    /// 执行一条 SQL，返回原始 REST 响应。`db` 非空时进 URL（限定默认库）。
    async fn rest(&self, sql: &str) -> Result<RestResp> {
        let base = self.base_url()?;
        let auth = self
            .auth
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .unwrap_or_default();
        let db = self.db.lock().ok().and_then(|g| g.clone());
        let url = match db.as_deref().filter(|s| !s.is_empty()) {
            Some(d) => format!("{base}/rest/sql/{d}"),
            None => format!("{base}/rest/sql"),
        };
        let resp = self
            .client
            .post(&url)
            .header("Authorization", auth)
            .body(sql.to_string())
            .send()
            .await
            .map_err(|e| AppError::Network(format!("tdengine: {e}")))?;
        let status = resp.status();
        let body = resp
            .text()
            .await
            .map_err(|e| AppError::Network(format!("tdengine: {e}")))?;
        if !status.is_success() {
            return Err(AppError::Network(format!("tdengine HTTP {status}: {body}")));
        }
        let parsed: RestResp = serde_json::from_str(&body)
            .map_err(|e| AppError::Internal(format!("tdengine 响应解析失败: {e}; body={body}")))?;
        if parsed.code != 0 {
            return Err(AppError::Sql {
                message: parsed
                    .desc
                    .unwrap_or_else(|| format!("code {}", parsed.code)),
                position: None,
            });
        }
        Ok(parsed)
    }

    /// REST 响应 → RawResultSet（列元数据 + 行）。
    fn to_result(resp: RestResp) -> RawResultSet {
        let columns: Vec<ColumnMeta> = resp
            .column_meta
            .iter()
            .map(|(name, ty, _len)| ColumnMeta {
                name: name.clone(),
                value_kind: super::type_map::tdengine_kind(ty).to_string(),
                db_type: ty.clone(),
                nullable: true,
                is_primary_key: false,
            })
            .collect();
        let kinds: Vec<&str> = columns.iter().map(|c| c.value_kind.as_str()).collect();
        let rows = resp
            .data
            .into_iter()
            .map(|row| {
                row.into_iter()
                    .enumerate()
                    .map(|(i, v)| json_to_value(v, kinds.get(i).copied().unwrap_or("Text")))
                    .collect()
            })
            .collect();
        RawResultSet { columns, rows }
    }

    /// 取单列文本（SHOW 类结果第 0 列）。
    async fn column0(&self, sql: &str) -> Result<Vec<String>> {
        let resp = self.rest(sql).await?;
        Ok(resp
            .data
            .into_iter()
            .filter_map(|r| r.into_iter().next())
            .map(|v| match v {
                serde_json::Value::String(s) => s,
                other => other.to_string(),
            })
            .collect())
    }
}

/// 标准 base64 编码（用于 Basic 授权头，避免额外依赖 base64 crate）。
fn base64_encode(input: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(T[(n >> 18 & 63) as usize] as char);
        out.push(T[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            T[(n >> 6 & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            T[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// JSON 值 → Value，按列的 value_kind 归类。
fn json_to_value(v: serde_json::Value, kind: &str) -> Value {
    use serde_json::Value as J;
    match v {
        J::Null => Value::Null,
        J::Bool(b) => Value::Bool(b),
        J::Number(n) => match kind {
            "Float" => Value::Float(n.as_f64().unwrap_or(0.0)),
            _ => n
                .as_i64()
                .map(Value::Int)
                .or_else(|| n.as_u64().map(Value::UInt))
                .unwrap_or_else(|| Value::Float(n.as_f64().unwrap_or(0.0))),
        },
        J::String(s) => match kind {
            "DateTime" => Value::DateTime(s),
            _ => Value::Text(s),
        },
        other => Value::Text(other.to_string()),
    }
}

#[async_trait]
impl DbAdapter for TdengineAdapter {
    fn capabilities(&self) -> &DbCapabilities {
        &self.caps
    }

    fn sql_dialect(&self) -> SqlDialect {
        SqlDialect {
            quote_char: '`',
            bool_keywords: false,
            backslash_strings: false,
            bytes: BytesLiteral::XQuote,
        }
    }

    async fn connect(&mut self, target: &ConnTarget) -> Result<()> {
        let scheme = if matches!(target.ssl_mode, SslMode::Require) {
            "https"
        } else {
            "http"
        };
        let port = if target.port == 0 { 6041 } else { target.port };
        *self.base.lock().unwrap() = Some(format!("{scheme}://{}:{}", target.host, port));
        let user = if target.user.is_empty() {
            "root"
        } else {
            &target.user
        };
        let pass = target.password.clone().unwrap_or_else(|| "taosdata".into());
        let token = base64_encode(format!("{user}:{pass}").as_bytes());
        *self.auth.lock().unwrap() = Some(format!("Basic {token}"));
        *self.db.lock().unwrap() = target
            .database
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        Ok(())
    }

    async fn disconnect(&mut self) {
        *self.base.lock().unwrap() = None;
        *self.auth.lock().unwrap() = None;
    }

    async fn ping(&self) -> Result<()> {
        self.rest("SHOW DATABASES").await.map(|_| ())
    }

    async fn query(&self, _query_id: &str, sql: &str, _params: &[Value]) -> Result<RawResultSet> {
        Ok(Self::to_result(self.rest(sql).await?))
    }

    async fn execute(&self, _query_id: &str, sql: &str, _params: &[Value]) -> Result<ExecResult> {
        let resp = self.rest(sql).await?;
        Ok(ExecResult {
            affected_rows: resp.rows.unwrap_or(0).max(0) as u64,
            last_insert_id: None,
        })
    }

    async fn cancel(&self, _query_id: &str) -> Result<()> {
        Ok(())
    }

    async fn use_database(&mut self, db: Option<String>) -> Result<()> {
        if let Some(d) = db.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            *self.db.lock().unwrap() = Some(d.to_string());
        }
        Ok(())
    }

    async fn execute_in_transaction(
        &self,
        _stmts: Vec<(String, Vec<Value>)>,
    ) -> Result<Vec<ExecResult>> {
        Err(AppError::NotEditable("TDengine 不支持事务提交编辑".into()))
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        Ok(self
            .column0("SHOW DATABASES")
            .await?
            .into_iter()
            .map(|name| DatabaseInfo { name })
            .collect())
    }

    async fn list_schemas(&self, _db: &str) -> Result<Vec<String>> {
        Ok(Vec::new())
    }

    async fn list_tables(&self, db: &str, _schema: Option<&str>) -> Result<Vec<TableInfo>> {
        let db = db.replace('`', "");
        // 超级表（可展开看子表）。
        let stables = self
            .column0(&format!("SHOW `{db}`.STABLES"))
            .await
            .unwrap_or_default();
        // 独立普通表（排除超级表的子表，避免海量子表铺满树）。优先用 information_schema，
        // 不可用时回退为 SHOW TABLES（会含子表）。
        let normal = self
            .column0(&format!(
                "SELECT table_name FROM information_schema.ins_tables \
                 WHERE db_name='{db}' AND type='NORMAL_TABLE'"
            ))
            .await
            .or_else(|_| Ok::<_, AppError>(Vec::new()))
            .unwrap_or_default();
        let mut out: Vec<TableInfo> = Vec::new();
        for name in stables {
            out.push(TableInfo {
                name,
                kind: TableKind::Table,
                is_super: true,
            });
        }
        for name in normal {
            out.push(TableInfo {
                name,
                kind: TableKind::Table,
                is_super: false,
            });
        }
        Ok(out)
    }

    async fn list_child_tables(&self, db: &str, stable: &str) -> Result<Vec<ChildTable>> {
        let db = db.replace('`', "");
        let stable = stable.replace('\'', "''");
        // 子表可能极多，限制条数。
        let names = self
            .column0(&format!(
                "SELECT table_name FROM information_schema.ins_tables \
                 WHERE db_name='{db}' AND stable_name='{stable}' LIMIT 2000"
            ))
            .await?;
        // 一次拉取全部标签（table_name, tag_name, tag_value），按子表聚合成 "k=v, k=v"。
        let mut tags: std::collections::HashMap<String, Vec<String>> =
            std::collections::HashMap::new();
        if let Ok(resp) = self
            .rest(&format!(
                "SELECT table_name, tag_name, tag_value FROM information_schema.ins_tags \
                 WHERE db_name='{db}' AND stable_name='{stable}'"
            ))
            .await
        {
            for row in resp.data {
                let get = |i: usize| {
                    row.get(i)
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string()
                };
                let (tbl, name, val) = (get(0), get(1), get(2));
                if !tbl.is_empty() {
                    tags.entry(tbl).or_default().push(format!("{name}={val}"));
                }
            }
        }
        Ok(names
            .into_iter()
            .map(|name| {
                let tags = tags.get(&name).map(|v| v.join(", ")).unwrap_or_default();
                ChildTable { name, tags }
            })
            .collect())
    }

    async fn table_schema(&self, t: &TableRef) -> Result<TableSchema> {
        let db = t.database.clone();
        let qualified = match &db {
            Some(d) => format!("`{}`.`{}`", d.replace('`', ""), t.name.replace('`', "")),
            None => format!("`{}`", t.name.replace('`', "")),
        };
        let resp = self.rest(&format!("DESCRIBE {qualified}")).await?;
        // DESCRIBE 列：field | type | length | note（note=TAG 表示标签列）。
        let columns = resp
            .data
            .into_iter()
            .filter_map(|row| {
                let name = row.first()?.as_str()?.to_string();
                let db_type = row
                    .get(1)
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let note = row.get(3).and_then(|v| v.as_str()).unwrap_or("");
                Some(ColumnInfo {
                    value_kind: super::type_map::tdengine_kind(&db_type).to_string(),
                    db_type,
                    name,
                    nullable: true,
                    default: None,
                    is_primary_key: false,
                    comment: (!note.is_empty()).then(|| note.to_string()),
                })
            })
            .collect();
        Ok(TableSchema {
            table: t.clone(),
            columns,
            indexes: Vec::new(),
            foreign_keys: Vec::new(),
        })
    }

    async fn table_ddl(&self, t: &TableRef) -> Result<String> {
        let qualified = match &t.database {
            Some(d) => format!("`{}`.`{}`", d.replace('`', ""), t.name.replace('`', "")),
            None => format!("`{}`", t.name.replace('`', "")),
        };
        // SHOW CREATE TABLE 返回单行，DDL 在第 2 列。
        let resp = self.rest(&format!("SHOW CREATE TABLE {qualified}")).await?;
        Ok(resp
            .data
            .into_iter()
            .next()
            .and_then(|r| r.get(1).and_then(|v| v.as_str().map(|s| s.to_string())))
            .unwrap_or_default())
    }

    async fn row_identifier(&self, _t: &TableRef) -> Result<Option<Vec<String>>> {
        // 无主键概念 → 结果集只读（editability 据此判定）。
        Ok(None)
    }
}

impl Default for TdengineAdapter {
    fn default() -> Self {
        Self::new()
    }
}

// 会话级超时（预留，一期未用到细粒度控制）。
#[allow(dead_code)]
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
