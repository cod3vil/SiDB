//! 查询服务（TDD §6.2）。
//!
//! - 分页是结果集的唯一数据通道（CLAUDE.md 铁律 #5）。
//! - 语句切分见 [`crate::sqlsplit`]；表浏览模式包装 `LIMIT/OFFSET`。
//! - 取消登记由各 adapter 内部维护（按 query_id）。

use crate::adapters::{DbAdapter, DbCapabilities};
use crate::models::*;
use crate::sqlsplit;
use std::time::Duration;

/// 给一个返回 `Result<T>` 的 future 套上可选超时；超时映射为 `AppError::Timeout`。
/// `None` 表示不限制。
pub async fn with_timeout<F, T>(dur: Option<Duration>, fut: F) -> Result<T>
where
    F: std::future::Future<Output = Result<T>>,
{
    match dur {
        Some(d) => match tokio::time::timeout(d, fut).await {
            Ok(r) => r,
            Err(_) => Err(AppError::Timeout(format!("操作超过 {} 秒", d.as_secs()))),
        },
        None => fut.await,
    }
}

/// 分页参数。
#[derive(Debug, Clone, Copy)]
pub struct Page {
    pub page: u64,
    pub page_size: u64,
}

impl Default for Page {
    fn default() -> Self {
        Self {
            page: 0,
            page_size: 1000,
        }
    }
}

impl Page {
    pub fn offset(&self) -> u64 {
        self.page * self.page_size
    }
}

/// 把单条 SELECT 包装为分页查询：`SELECT * FROM (<sql>) AS _t LIMIT n OFFSET m`。
///
/// 适用于"自定义 SQL"的分页（TDD §6.2 step 3）。表浏览模式直接拼 LIMIT/OFFSET。
pub fn wrap_pagination(sql: &str, page: Page) -> String {
    let sql = sql.trim().trim_end_matches(';');
    format!(
        "SELECT * FROM ({sql}) AS _sidb_page LIMIT {} OFFSET {}",
        page.page_size,
        page.offset()
    )
}

/// 表浏览：构造 `SELECT * FROM <table> [ORDER BY ...] LIMIT n OFFSET m`。
pub fn browse_sql(
    caps: &DbCapabilities,
    table: &TableRef,
    page: Page,
    sort: Option<(&str, bool)>, // (列名, 升序)
) -> Result<String> {
    let qt = caps.quote_table(table)?;
    let mut sql = format!("SELECT * FROM {qt}");
    if let Some((col, asc)) = sort {
        let qc = caps.quote_ident(col)?;
        sql.push_str(&format!(
            " ORDER BY {qc} {}",
            if asc { "ASC" } else { "DESC" }
        ));
    }
    sql.push_str(&format!(
        " LIMIT {} OFFSET {}",
        page.page_size,
        page.offset()
    ));
    Ok(sql)
}

pub fn page_info(page: Page, returned: u64) -> PageInfo {
    PageInfo {
        page: page.page,
        page_size: page.page_size,
        offset: page.offset() + 1, // 1-based 起始行
        returned,
        has_more: returned == page.page_size,
    }
}

/// 一条语句执行的结果（SELECT → ResultSet；其它 → 影响行数摘要）。
pub enum RunOutcome {
    Rows(ResultSet),
    Affected {
        affected_rows: u64,
        last_insert_id: Option<i64>,
        elapsed_ms: u64,
        statement: String,
    },
}

/// 浏览模式的总行数（best-effort，用于分页「末页 / 页码」）。失败/超时返回 None。
pub async fn count_table(
    adapter: &dyn DbAdapter,
    caps: &DbCapabilities,
    table: &TableRef,
    timeout: Option<Duration>,
) -> Option<u64> {
    let qt = caps.quote_table(table).ok()?;
    let sql = format!("SELECT COUNT(*) FROM {qt}");
    let raw = with_timeout(timeout, adapter.query("__count__", &sql, &[]))
        .await
        .ok()?;
    match raw.rows.first()?.first()? {
        Value::Int(n) => (*n >= 0).then_some(*n as u64),
        Value::UInt(n) => Some(*n),
        _ => None,
    }
}

/// 识别「简单单表 `SELECT * FROM 表`」（可带 WHERE/ORDER BY/LIMIT），用于让其结果可编辑。
/// 保守起见：必须 `SELECT *`、单表、无 join/逗号/子查询/聚合/别名；否则返回 None（按只读处理）。
pub fn simple_select_table(sql: &str, caps: &DbCapabilities) -> Option<TableRef> {
    let s = sql.trim().trim_end_matches(';').trim();
    let toks: Vec<&str> = s.split_whitespace().collect();
    if toks.len() < 4 {
        return None;
    }
    if !toks[0].eq_ignore_ascii_case("select")
        || toks[1] != "*"
        || !toks[2].eq_ignore_ascii_case("from")
    {
        return None;
    }
    // 表标识符后若还有内容，只允许 where / order / limit 起头。
    if let Some(next) = toks.get(4) {
        let next = next.to_ascii_lowercase();
        if !matches!(next.as_str(), "where" | "order" | "limit") {
            return None;
        }
    }
    let ident = toks[3];
    if ident.chars().any(|c| matches!(c, ',' | '(' | ')' | ';')) {
        return None;
    }
    let parts: Vec<String> = ident
        .split('.')
        .map(|p| p.trim_matches(|c| c == '`' || c == '"').to_string())
        .collect();
    if parts.iter().any(|p| p.is_empty()) {
        return None;
    }
    let (database, schema, name) = match parts.as_slice() {
        [name] => (None, None, name.clone()),
        [a, b] if caps.supports_schemas => (None, Some(a.clone()), b.clone()),
        [a, b] => (Some(a.clone()), None, b.clone()),
        [a, b, c] => (Some(a.clone()), Some(b.clone()), c.clone()),
        _ => return None,
    };
    Some(TableRef {
        database,
        schema,
        name,
    })
}

/// 执行一段脚本（可能多语句），返回每条语句的结果。
/// `query_id_prefix` 用于取消登记（每条语句拼 `:idx`）。`ctx_database` 为编辑器当前库。
#[allow(clippy::too_many_arguments)]
pub async fn run_script(
    adapter: &dyn DbAdapter,
    query_id_prefix: &str,
    script: &str,
    page: Page,
    ctx_database: Option<&str>,
    ctx_schema: Option<&str>,
    read_timeout: Option<Duration>,
    write_timeout: Option<Duration>,
) -> Result<Vec<RunOutcome>> {
    let stmts = sqlsplit::split_statements(script);
    let mut outcomes = Vec::with_capacity(stmts.len());
    for (i, stmt) in stmts.iter().enumerate() {
        let qid = format!("{query_id_prefix}:{i}");
        let kw = sqlsplit::first_keyword(stmt);
        let started = std::time::Instant::now();
        if is_result_producing(&kw) {
            let wrapped = wrap_pagination(stmt, page);
            let mut raw = with_timeout(read_timeout, adapter.query(&qid, &wrapped, &[])).await?;
            let returned = raw.rows.len() as u64;
            // 简单单表 SELECT *：解析出表 → 标记主键列（结果元数据不含主键）+ 判定可编辑性。
            let mut editable = Editability::ReadOnly {
                reason: "custom-query".into(),
            };
            let mut editable_table = None;
            if let Some(mut t) = simple_select_table(stmt, adapter.capabilities()) {
                if t.database.is_none() {
                    t.database = ctx_database.map(|s| s.to_string());
                }
                if t.schema.is_none() {
                    t.schema = ctx_schema.map(|s| s.to_string());
                }
                // 用表结构补主键标记，让结果集列头显示主键图标。
                if let Ok(schema) = adapter.table_schema(&t).await {
                    let pks: std::collections::HashSet<&str> = schema
                        .columns
                        .iter()
                        .filter(|c| c.is_primary_key)
                        .map(|c| c.name.as_str())
                        .collect();
                    if !pks.is_empty() {
                        for col in raw.columns.iter_mut() {
                            if pks.contains(col.name.as_str()) {
                                col.is_primary_key = true;
                            }
                        }
                    }
                }
                if let Ok(ed @ Editability::Editable { .. }) =
                    crate::services::metadata::editability(adapter, &t).await
                {
                    editable = ed;
                    editable_table = Some(t);
                }
            }
            outcomes.push(RunOutcome::Rows(ResultSet {
                columns: raw.columns,
                rows: raw.rows,
                total_hint: None,
                page: page_info(page, returned),
                elapsed_ms: started.elapsed().as_millis() as u64,
                editable,
                editable_table,
            }));
        } else {
            let res = with_timeout(write_timeout, adapter.execute(&qid, stmt, &[])).await?;
            outcomes.push(RunOutcome::Affected {
                affected_rows: res.affected_rows,
                last_insert_id: res.last_insert_id,
                elapsed_ms: started.elapsed().as_millis() as u64,
                statement: stmt.trim().to_string(),
            });
        }
    }
    Ok(outcomes)
}

fn is_result_producing(kw: &str) -> bool {
    matches!(
        kw,
        "SELECT" | "WITH" | "SHOW" | "PRAGMA" | "EXPLAIN" | "DESCRIBE" | "DESC"
    )
}

/// 高层服务封装（持有取消能力的入口由 commands 层注入 session）。
pub struct QueryService;

impl QueryService {
    pub async fn cancel(adapter: &dyn DbAdapter, query_id: &str) -> Result<()> {
        adapter.cancel(query_id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps() -> DbCapabilities {
        DbCapabilities {
            supports_ssh: false,
            supports_cancel: true,
            supports_schemas: false,
            supports_multi_database: false,
            supports_use_database: false,
            param_style: ParamStyle::Question,
            quote_char: '"',
            has_rowid_fallback: true,
        }
    }

    #[test]
    fn wrap_pagination_strips_semicolon() {
        let s = wrap_pagination(
            "SELECT * FROM t;",
            Page {
                page: 2,
                page_size: 100,
            },
        );
        assert_eq!(
            s,
            "SELECT * FROM (SELECT * FROM t) AS _sidb_page LIMIT 100 OFFSET 200"
        );
    }

    #[test]
    fn browse_with_sort() {
        let t = TableRef {
            database: None,
            schema: None,
            name: "t".into(),
        };
        let s = browse_sql(
            &caps(),
            &t,
            Page {
                page: 0,
                page_size: 50,
            },
            Some(("id", false)),
        )
        .unwrap();
        assert_eq!(
            s,
            r#"SELECT * FROM "t" ORDER BY "id" DESC LIMIT 50 OFFSET 0"#
        );
    }

    #[test]
    fn page_info_offsets() {
        let pi = page_info(
            Page {
                page: 1,
                page_size: 1000,
            },
            1000,
        );
        assert_eq!(pi.offset, 1001);
        assert!(pi.has_more);
        let pi2 = page_info(
            Page {
                page: 1,
                page_size: 1000,
            },
            320,
        );
        assert!(!pi2.has_more);
    }

    #[test]
    fn result_producing_classification() {
        assert!(is_result_producing("SELECT"));
        assert!(is_result_producing("WITH"));
        assert!(!is_result_producing("INSERT"));
        assert!(!is_result_producing("UPDATE"));
    }

    fn pg_caps() -> DbCapabilities {
        DbCapabilities {
            supports_schemas: true,
            quote_char: '"',
            ..caps()
        }
    }

    #[test]
    fn simple_select_matches() {
        let c = caps(); // 非 schema 方言（MySQL 类）
        assert_eq!(
            simple_select_table("SELECT * FROM users", &c).unwrap().name,
            "users"
        );
        assert_eq!(
            simple_select_table("select * from users where id=1", &c)
                .unwrap()
                .name,
            "users"
        );
        assert_eq!(
            simple_select_table("SELECT * FROM users ORDER BY id LIMIT 10", &c)
                .unwrap()
                .name,
            "users"
        );
        // 库限定（MySQL）：db.tbl
        let t = simple_select_table("SELECT * FROM kwy.kwy_redpack;", &c).unwrap();
        assert_eq!(
            (t.database.as_deref(), t.name.as_str()),
            (Some("kwy"), "kwy_redpack")
        );
        // PG schema 限定：schema.tbl
        let p = simple_select_table("SELECT * FROM public.users", &pg_caps()).unwrap();
        assert_eq!(
            (p.schema.as_deref(), p.name.as_str()),
            (Some("public"), "users")
        );
    }

    #[test]
    fn simple_select_rejects_complex() {
        let c = caps();
        assert!(simple_select_table("SELECT id, name FROM users", &c).is_none()); // 非 *
        assert!(simple_select_table("SELECT * FROM a JOIN b ON a.id=b.id", &c).is_none()); // join
        assert!(simple_select_table("SELECT * FROM a, b", &c).is_none()); // 多表
        assert!(simple_select_table("SELECT * FROM users u", &c).is_none()); // 别名
        assert!(simple_select_table("SELECT * FROM (SELECT 1) x", &c).is_none()); // 子查询
        assert!(simple_select_table("SELECT * FROM t GROUP BY x", &c).is_none()); // 聚合
        assert!(simple_select_table("UPDATE t SET x=1", &c).is_none());
    }
}
