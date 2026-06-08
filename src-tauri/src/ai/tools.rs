//! AI 可见的全部能力（TDD §7）。二期填实现；一期定义枚举 + 只读校验逻辑。

use crate::models::TableRef;
use crate::sqlsplit;

pub enum DbTool {
    ListTables { conn_id: String, database: String },
    GetSchema { conn_id: String, table: TableRef },
    /// 强制 LIMIT 1000 / 30s 超时。
    RunReadQuery { conn_id: String, sql: String },
    /// 仅产出提案，必须走确认流。
    ProposeWrite { conn_id: String, sql: String },
}

/// 默认只读行数上限与超时（PRD §3.8 AI 安全红线）。
pub const READ_LIMIT: u64 = 1000;
pub const READ_TIMEOUT_SECS: u64 = 30;

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
}
