//! 元数据服务（TDD §6）。薄封装：委托给 adapter，并把可编辑性判定集中在此。

use crate::adapters::DbAdapter;
use crate::models::*;

/// 由 `row_identifier()` 推导可编辑性（PRD §3.5.1）。
pub async fn editability(adapter: &dyn DbAdapter, t: &TableRef) -> Result<Editability> {
    match adapter.row_identifier(t).await? {
        Some(cols) if !cols.is_empty() => Ok(Editability::Editable {
            row_id_columns: cols,
        }),
        _ => Ok(Editability::ReadOnly {
            reason: "表无主键或唯一非空索引，结果集只读".into(),
        }),
    }
}

/// 列出列（树展开"列清单"用，PRD §3.2）。
pub async fn list_columns(adapter: &dyn DbAdapter, t: &TableRef) -> Result<Vec<ColumnInfo>> {
    Ok(adapter.table_schema(t).await?.columns)
}
