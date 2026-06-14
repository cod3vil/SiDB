//! Schema 上下文（TDD §7）。给系统提示注入精简的表清单；列细节让模型用 get_schema 工具拉。

use crate::services::connection::ConnectionManager;

/// 系统提示里附带的最多表名数。
const MAX_TABLES: usize = 60;

/// 构建「当前库表清单」简介。失败/为空时返回空串（不阻断对话）。
pub async fn schema_brief(
    conns: &ConnectionManager,
    conn_id: &str,
    database: Option<&str>,
    schema: Option<&str>,
) -> String {
    let Some(s) = conns.get(conn_id) else {
        return String::new();
    };
    let a = s.adapter.lock().await;
    let db = database.unwrap_or("");
    let tables = match a.list_tables(db, schema).await {
        Ok(t) => t,
        Err(_) => return String::new(),
    };
    if tables.is_empty() {
        return String::new();
    }
    let names: Vec<&str> = tables
        .iter()
        .take(MAX_TABLES)
        .map(|t| t.name.as_str())
        .collect();
    let more = if tables.len() > MAX_TABLES {
        format!(" …(+{} more)", tables.len() - MAX_TABLES)
    } else {
        String::new()
    };
    format!(
        "当前数据库的表（共 {}）：{}{}",
        tables.len(),
        names.join(", "),
        more
    )
}

/// 选中表的列清单简介（注入系统提示，省去模型再调 get_schema）。失败/为空返回空串。
pub async fn table_columns_brief(
    conns: &ConnectionManager,
    conn_id: &str,
    t: &crate::models::TableRef,
) -> String {
    let Some(s) = conns.get(conn_id) else {
        return String::new();
    };
    let a = s.adapter.lock().await;
    let schema = match a.table_schema(t).await {
        Ok(s) => s,
        Err(_) => return String::new(),
    };
    if schema.columns.is_empty() {
        return String::new();
    }
    let cols: Vec<String> = schema
        .columns
        .iter()
        .map(|c| format!("{}({})", c.name, c.db_type))
        .collect();
    format!("选中的表 `{}` 的列：{}", t.name, cols.join(", "))
}
