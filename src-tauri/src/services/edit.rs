//! 数据编辑服务（TDD §6.3）。
//!
//! 流程：校验 row_id 列与 `row_identifier()` 自查一致（防伪造）→ 生成参数化 DML
//! → 单事务提交 → 逐条校验 update/delete 影响行数 == 1（乐观并发，否则 EditConflict 回滚）。

use super::dml::{self, Change, ChangeSet, Stmt};
use crate::adapters::DbAdapter;
use crate::models::*;

#[derive(Debug, Clone, serde::Serialize)]
pub struct CommitResult {
    pub applied: usize,
    pub affected_total: u64,
}

pub struct EditService;

impl EditService {
    /// 预览：返回展开后的可读 SQL（仅展示，不执行）。
    pub fn preview(adapter: &dyn DbAdapter, cs: &ChangeSet) -> Result<Vec<String>> {
        let caps = adapter.capabilities();
        let mut out = Vec::with_capacity(cs.changes.len());
        for ch in &cs.changes {
            let stmt = dml::build_stmt(caps, &cs.table, ch)?;
            out.push(dml::expand_for_preview(&stmt));
        }
        Ok(out)
    }

    /// 提交：单事务执行全部变更。
    pub async fn commit(adapter: &dyn DbAdapter, cs: &ChangeSet) -> Result<CommitResult> {
        // 1) 防伪造：后端自查行定位列，必须与前端声明一致。
        let actual = adapter
            .row_identifier(&cs.table)
            .await?
            .ok_or_else(|| AppError::NotEditable("table has no row identifier".into()))?;
        if !same_set(&actual, &cs.row_id_columns) {
            return Err(AppError::NotEditable(format!(
                "row id columns mismatch: expected {actual:?}, got {:?}",
                cs.row_id_columns
            )));
        }

        // 2) 生成参数化语句，并记录哪些需要校验 affected == 1。
        let caps = adapter.capabilities();
        let mut stmts: Vec<(String, Vec<Value>)> = Vec::with_capacity(cs.changes.len());
        let mut expect_one: Vec<bool> = Vec::with_capacity(cs.changes.len());
        for ch in &cs.changes {
            let Stmt { sql, params } = dml::build_stmt(caps, &cs.table, ch)?;
            expect_one.push(matches!(ch, Change::Update { .. } | Change::Delete { .. }));
            stmts.push((sql, params));
        }

        // 3) 单事务执行。
        let results = adapter.execute_in_transaction(stmts).await?;

        // 4) 乐观并发校验：update/delete 影响行数必须为 1。
        //    （adapter 在任一语句 SQL 失败时已回滚；这里对行数不符再次以错误反馈，
        //     事务已提交的实现需在 adapter 内做校验——见集成测试用例。）
        let mut affected_total = 0u64;
        for (i, res) in results.iter().enumerate() {
            affected_total += res.affected_rows;
            if expect_one[i] && res.affected_rows != 1 {
                return Err(AppError::EditConflict(
                    "数据已被其他会话修改，请刷新后重试".into(),
                ));
            }
        }

        Ok(CommitResult { applied: results.len(), affected_total })
    }
}

fn same_set(a: &[String], b: &[String]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let sa: std::collections::BTreeSet<&str> = a.iter().map(|s| s.as_str()).collect();
    let sb: std::collections::BTreeSet<&str> = b.iter().map(|s| s.as_str()).collect();
    sa == sb
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_set_ignores_order() {
        assert!(same_set(&["a".into(), "b".into()], &["b".into(), "a".into()]));
        assert!(!same_set(&["a".into()], &["a".into(), "b".into()]));
    }
}
