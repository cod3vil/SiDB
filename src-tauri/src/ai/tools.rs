//! AI 可见能力（TDD §7）：工具定义 + 执行器。
//! 只读工具强制单语句 + 只读校验 + LIMIT + 超时；写操作只产提案，绝不在此执行。
//! 执行器只经 services / adapter 元数据，不在此写 if mysql/pg/sqlite（方言留在 adapters）。

use crate::ai::audit;
use crate::ai::proposals::ProposalStore;
use crate::ai::provider::ToolDef;
use crate::services::connection::ConnectionManager;
use crate::sqlsplit;
use std::time::Duration;

/// 默认只读行数上限与超时（PRD §3.8 AI 安全红线）。
pub const READ_LIMIT: u64 = 1000;
pub const READ_TIMEOUT_SECS: u64 = 30;

/// 回灌给模型的查询结果，最多附带这么多行（节省 token；总行数照实告知）。
const MAX_ROWS_TO_MODEL: usize = 100;
/// tool_result 文本字符上限。
const MAX_RESULT_CHARS: usize = 6000;

/// 默认库 / schema / 选中表（模型未显式指定时用当前 tab 上下文兜底）。
#[derive(Debug, Clone, Default)]
pub struct ToolCtx {
    pub database: Option<String>,
    pub schema: Option<String>,
    /// 用户在界面选中的表；未指明表名时默认只在该表操作。
    pub table: Option<String>,
}

/// 一次工具调用的展示摘要（前端折叠 chip 用）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct ToolStep {
    pub tool: String,
    pub summary: String,
}

/// 工具执行产物。
pub struct ToolOutcome {
    /// 回灌模型的 tool_result 文本。
    pub content: String,
    pub is_error: bool,
    pub step: ToolStep,
    /// propose_write 时携带 (proposal_id, sql)。
    pub proposal: Option<(String, String)>,
}

/// 暴露给模型的工具定义（对齐 Anthropic tools schema）。
pub fn tool_defs() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "list_tables".into(),
            description: "List tables/views in a database (or the current one). Use before guessing table names.".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "database": {"type": "string", "description": "database name; omit to use current"},
                    "schema": {"type": "string", "description": "schema (PostgreSQL only)"}
                }
            }),
        },
        ToolDef {
            name: "get_schema".into(),
            description: "Get a table's columns (name, type, nullable, primary key). Call before writing SQL against a table.".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "table": {"type": "string", "description": "table name"},
                    "database": {"type": "string"},
                    "schema": {"type": "string"}
                },
                "required": ["table"]
            }),
        },
        ToolDef {
            name: "run_read_query".into(),
            description: "Run a single read-only SQL (SELECT/WITH/SHOW/EXPLAIN). Server enforces single statement, read-only, LIMIT 1000 and a 30s timeout. Never use for writes.".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {"sql": {"type": "string"}},
                "required": ["sql"]
            }),
        },
        ToolDef {
            name: "propose_write".into(),
            description: "Propose an INSERT/UPDATE/DELETE/DDL statement. This does NOT execute it — it returns a proposal the user must confirm. Use this for any write; never claim a write happened.".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {"sql": {"type": "string"}},
                "required": ["sql"]
            }),
        },
    ]
}

/// 只读校验：单语句且首关键字属只读集合（TDD §7 硬约束）。
pub fn validate_read_only(sql: &str) -> Result<(), String> {
    let stmts = sqlsplit::split_statements(sql);
    if stmts.len() != 1 {
        return Err("only a single statement is allowed".into());
    }
    let kw = sqlsplit::first_keyword(&stmts[0]);
    if sqlsplit::is_read_only_keyword(&kw) {
        Ok(())
    } else {
        Err(format!("statement '{kw}' is not read-only"))
    }
}

/// 给只读 SQL 外层强制包 LIMIT。
pub fn enforce_limit(sql: &str, limit: u64) -> String {
    let trimmed = sql.trim().trim_end_matches(';');
    format!("SELECT * FROM ({trimmed}) AS _ai_guard LIMIT {limit}")
}

/// 执行一次工具调用，返回回灌模型的产物。错误以 is_error=true 回灌（让模型自我纠正）。
pub async fn execute(
    conns: &ConnectionManager,
    proposals: &ProposalStore,
    conn_id: &str,
    ctx: &ToolCtx,
    name: &str,
    input: &serde_json::Value,
) -> ToolOutcome {
    let out = match name {
        "list_tables" => list_tables(conns, conn_id, ctx, input).await,
        "get_schema" => get_schema(conns, conn_id, ctx, input).await,
        "run_read_query" => run_read_query(conns, conn_id, input).await,
        "propose_write" => return propose_write(proposals, conn_id, input),
        other => Err(format!("unknown tool '{other}'")),
    };
    match out {
        Ok((content, summary)) => {
            audit::record(conn_id, name, sql_of(input), &summary);
            ToolOutcome { content, is_error: false, step: ToolStep { tool: name.into(), summary }, proposal: None }
        }
        Err(msg) => {
            audit::record(conn_id, name, sql_of(input), &format!("error: {msg}"));
            ToolOutcome {
                content: format!("error: {msg}"),
                is_error: true,
                step: ToolStep { tool: name.into(), summary: format!("失败：{msg}") },
                proposal: None,
            }
        }
    }
}

fn sql_of(input: &serde_json::Value) -> &str {
    input.get("sql").and_then(|v| v.as_str()).unwrap_or("")
}

fn str_field<'a>(input: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(|v| v.as_str()).filter(|s| !s.is_empty())
}

async fn list_tables(
    conns: &ConnectionManager,
    conn_id: &str,
    ctx: &ToolCtx,
    input: &serde_json::Value,
) -> Result<(String, String), String> {
    let s = conns.get(conn_id).ok_or("not connected")?;
    let a = s.adapter.lock().await;
    let db = str_field(input, "database")
        .map(String::from)
        .or_else(|| ctx.database.clone())
        .unwrap_or_default();
    let schema = str_field(input, "schema")
        .map(String::from)
        .or_else(|| ctx.schema.clone());
    let tables = a.list_tables(&db, schema.as_deref()).await.map_err(|e| e.to_string())?;
    let names: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
    let content = serde_json::json!({ "tables": names }).to_string();
    Ok((cap(content), format!("列出 {} 张表/视图", tables.len())))
}

async fn get_schema(
    conns: &ConnectionManager,
    conn_id: &str,
    ctx: &ToolCtx,
    input: &serde_json::Value,
) -> Result<(String, String), String> {
    let name = str_field(input, "table").ok_or("missing 'table'")?;
    let s = conns.get(conn_id).ok_or("not connected")?;
    let a = s.adapter.lock().await;
    let t = crate::models::TableRef {
        database: str_field(input, "database").map(String::from).or_else(|| ctx.database.clone()),
        schema: str_field(input, "schema").map(String::from).or_else(|| ctx.schema.clone()),
        name: name.to_string(),
    };
    let schema = a.table_schema(&t).await.map_err(|e| e.to_string())?;
    let cols: Vec<serde_json::Value> = schema
        .columns
        .iter()
        .map(|c| {
            serde_json::json!({
                "name": c.name,
                "type": c.db_type,
                "nullable": c.nullable,
                "pk": c.is_primary_key,
            })
        })
        .collect();
    let content = serde_json::json!({ "table": name, "columns": cols }).to_string();
    Ok((cap(content), format!("读取 {} 结构 · {} 列", name, schema.columns.len())))
}

async fn run_read_query(
    conns: &ConnectionManager,
    conn_id: &str,
    input: &serde_json::Value,
) -> Result<(String, String), String> {
    let sql = str_field(input, "sql").ok_or("missing 'sql'")?;
    validate_read_only(sql)?;
    // 只有 SELECT/WITH 能被包进子查询加 LIMIT；SHOW/EXPLAIN/PRAGMA 原样执行（本身有界）。
    let kw = sqlsplit::first_keyword(sql);
    let to_run = if kw == "SELECT" || kw == "WITH" {
        enforce_limit(sql, READ_LIMIT)
    } else {
        sql.to_string()
    };
    let s = conns.get(conn_id).ok_or("not connected")?;
    let a = s.adapter.lock().await;
    let fut = a.query("ai_read", &to_run, &[]);
    let raw = match tokio::time::timeout(Duration::from_secs(READ_TIMEOUT_SECS), fut).await {
        Ok(r) => r.map_err(|e| e.to_string())?,
        Err(_) => return Err(format!("query exceeded {READ_TIMEOUT_SECS}s timeout")),
    };
    let cols: Vec<&str> = raw.columns.iter().map(|c| c.name.as_str()).collect();
    let rows: Vec<Vec<serde_json::Value>> = raw
        .rows
        .iter()
        .take(MAX_ROWS_TO_MODEL)
        .map(|r| r.iter().map(cell_json).collect())
        .collect();
    let content = serde_json::json!({
        "columns": cols,
        "row_count": raw.rows.len(),
        "rows": rows,
        "truncated": raw.rows.len() > MAX_ROWS_TO_MODEL,
    })
    .to_string();
    Ok((cap(content), format!("查询 · {} 行", raw.rows.len())))
}

fn propose_write(
    proposals: &ProposalStore,
    conn_id: &str,
    input: &serde_json::Value,
) -> ToolOutcome {
    let Some(sql) = str_field(input, "sql") else {
        return ToolOutcome {
            content: "error: missing 'sql'".into(),
            is_error: true,
            step: ToolStep { tool: "propose_write".into(), summary: "失败：缺少 sql".into() },
            proposal: None,
        };
    };
    let id = proposals.put(conn_id, sql);
    audit::record(conn_id, "propose_write", sql, &id);
    ToolOutcome {
        content: format!(
            "Proposal created (id={id}). NOT executed. The user must confirm it in the UI. Do not claim the write has been applied."
        ),
        is_error: false,
        step: ToolStep { tool: "propose_write".into(), summary: "写操作提案".into() },
        proposal: Some((id, sql.to_string())),
    }
}

/// 把单元格 Value 渲染成精简 JSON 标量（省 token，便于模型读取）。
fn cell_json(v: &crate::models::Value) -> serde_json::Value {
    use crate::models::Value as V;
    match v {
        V::Null => serde_json::Value::Null,
        V::Bool(b) => serde_json::json!(b),
        V::Int(i) => serde_json::json!(i),
        V::UInt(u) => serde_json::json!(u),
        V::Float(f) => serde_json::json!(f),
        V::Decimal(s) | V::Text(s) | V::Date(s) | V::Time(s) | V::DateTime(s) | V::Unknown(s) => {
            serde_json::json!(s)
        }
        V::Bytes { len, .. } => serde_json::json!(format!("<{len} bytes>")),
        V::Json(j) => j.clone(),
        V::Array(a) => serde_json::Value::Array(a.iter().map(cell_json).collect()),
    }
}

/// 截断超长 tool_result 文本。
fn cap(mut s: String) -> String {
    if s.len() > MAX_RESULT_CHARS {
        s.truncate(MAX_RESULT_CHARS);
        s.push_str("…(truncated)");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_single_select() {
        assert!(validate_read_only("SELECT * FROM t").is_ok());
        assert!(validate_read_only("WITH x AS (SELECT 1) SELECT * FROM x").is_ok());
    }

    #[test]
    fn rejects_write_and_multi() {
        assert!(validate_read_only("DELETE FROM t").is_err());
        assert!(validate_read_only("SELECT 1; DROP TABLE t").is_err());
    }

    #[test]
    fn limit_wrapping() {
        assert_eq!(
            enforce_limit("SELECT * FROM t;", 1000),
            "SELECT * FROM (SELECT * FROM t) AS _ai_guard LIMIT 1000"
        );
    }

    #[test]
    fn tool_defs_present() {
        let names: Vec<_> = tool_defs().into_iter().map(|t| t.name).collect();
        assert!(names.contains(&"run_read_query".to_string()));
        assert!(names.contains(&"propose_write".to_string()));
    }
}
