//! 参数化 DML 生成（TDD §6.3）。纯函数、独立可测。
//!
//! 由 [`super::edit::EditService`] 调用：把变更集（update/insert/delete）转成
//! 参数化语句 `(sql, params)`。标识符经引号化函数且来源于元数据；用户数据一律走占位符。

use crate::adapters::DbCapabilities;
use crate::models::*;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// 单条变更（前端 → 后端，TDD §6.3）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Change {
    Update {
        key: BTreeMap<String, Value>,
        set: BTreeMap<String, Value>,
    },
    Insert {
        values: BTreeMap<String, Value>,
    },
    Delete {
        key: BTreeMap<String, Value>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeSet {
    pub table: TableRef,
    pub row_id_columns: Vec<String>,
    pub changes: Vec<Change>,
}

/// 一条参数化语句。
#[derive(Debug, Clone, PartialEq)]
pub struct Stmt {
    pub sql: String,
    pub params: Vec<Value>,
}

/// 把单条变更编译为参数化语句。`caps` 提供引号字符与占位符风格。
pub fn build_stmt(caps: &DbCapabilities, table: &TableRef, change: &Change) -> Result<Stmt> {
    let qt = caps.quote_table(table)?;
    match change {
        Change::Insert { values } => {
            if values.is_empty() {
                return Err(AppError::Internal("insert with no columns".into()));
            }
            let mut cols = Vec::new();
            let mut placeholders = Vec::new();
            let mut params = Vec::new();
            for (i, (col, val)) in values.iter().enumerate() {
                cols.push(caps.quote_ident(col)?);
                placeholders.push(caps.param_style.placeholder(i));
                params.push(val.clone());
            }
            let sql = format!(
                "INSERT INTO {qt} ({}) VALUES ({})",
                cols.join(", "),
                placeholders.join(", ")
            );
            Ok(Stmt { sql, params })
        }
        Change::Update { key, set } => {
            if set.is_empty() {
                return Err(AppError::Internal("update with no SET".into()));
            }
            if key.is_empty() {
                return Err(AppError::NotEditable("update without row key".into()));
            }
            let mut params = Vec::new();
            let mut idx = 0usize;
            let mut set_parts = Vec::new();
            for (col, val) in set {
                set_parts.push(format!(
                    "{} = {}",
                    caps.quote_ident(col)?,
                    caps.param_style.placeholder(idx)
                ));
                params.push(val.clone());
                idx += 1;
            }
            let where_clause = build_where(caps, key, &mut params, &mut idx)?;
            let sql = format!("UPDATE {qt} SET {} WHERE {}", set_parts.join(", "), where_clause);
            Ok(Stmt { sql, params })
        }
        Change::Delete { key } => {
            if key.is_empty() {
                return Err(AppError::NotEditable("delete without row key".into()));
            }
            let mut params = Vec::new();
            let mut idx = 0usize;
            let where_clause = build_where(caps, key, &mut params, &mut idx)?;
            let sql = format!("DELETE FROM {qt} WHERE {where_clause}");
            Ok(Stmt { sql, params })
        }
    }
}

/// 构造 WHERE：`col = $n AND ...`；NULL 用 `IS NULL`（不占位）。
fn build_where(
    caps: &DbCapabilities,
    key: &BTreeMap<String, Value>,
    params: &mut Vec<Value>,
    idx: &mut usize,
) -> Result<String> {
    let mut parts = Vec::new();
    for (col, val) in key {
        let qc = caps.quote_ident(col)?;
        if val.is_null() {
            parts.push(format!("{qc} IS NULL"));
        } else {
            parts.push(format!("{qc} = {}", caps.param_style.placeholder(*idx)));
            params.push(val.clone());
            *idx += 1;
        }
    }
    Ok(parts.join(" AND "))
}

/// 把参数化语句展开为**可读**（仅展示，不执行）的 SQL —— 用于 preview（TDD §6.3）。
pub fn expand_for_preview(stmt: &Stmt) -> String {
    let mut result = String::new();
    let mut pi = 0usize;
    let bytes = stmt.sql.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        // $n 占位符（Dollar 风格）
        if c == b'$' && i + 1 < bytes.len() && bytes[i + 1].is_ascii_digit() {
            let mut j = i + 1;
            while j < bytes.len() && bytes[j].is_ascii_digit() {
                j += 1;
            }
            let n: usize = stmt.sql[i + 1..j].parse().unwrap_or(0);
            if n >= 1 && n <= stmt.params.len() {
                result.push_str(&literal(&stmt.params[n - 1]));
            } else {
                result.push_str(&stmt.sql[i..j]);
            }
            i = j;
            continue;
        }
        // ? 占位符（Question 风格）
        if c == b'?' {
            if pi < stmt.params.len() {
                result.push_str(&literal(&stmt.params[pi]));
                pi += 1;
            } else {
                result.push('?');
            }
            i += 1;
            continue;
        }
        result.push(c as char);
        i += 1;
    }
    result
}

fn literal(v: &Value) -> String {
    match v {
        Value::Null => "NULL".into(),
        Value::Bool(b) => if *b { "TRUE".into() } else { "FALSE".into() },
        Value::Int(n) => n.to_string(),
        Value::UInt(n) => n.to_string(),
        Value::Float(f) => f.to_string(),
        Value::Decimal(s) => s.clone(),
        Value::Text(s) | Value::Unknown(s) | Value::Date(s) | Value::Time(s) | Value::DateTime(s) => {
            format!("'{}'", s.replace('\'', "''"))
        }
        Value::Json(j) => format!("'{}'", j.to_string().replace('\'', "''")),
        Value::Bytes { len, .. } => format!("X'..{len} bytes..'"),
        Value::Array(_) => format!("'{}'", serde_json::to_string(v).unwrap_or_default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ParamStyle;

    fn pg_caps() -> DbCapabilities {
        DbCapabilities {
            supports_ssh: true,
            supports_cancel: true,
            supports_schemas: true,
            supports_multi_database: true,
            supports_use_database: false,
            param_style: ParamStyle::Dollar,
            quote_char: '"',
            has_rowid_fallback: false,
        }
    }
    fn mysql_caps() -> DbCapabilities {
        DbCapabilities {
            supports_ssh: true,
            supports_cancel: true,
            supports_schemas: false,
            supports_multi_database: true,
            supports_use_database: false,
            param_style: ParamStyle::Question,
            quote_char: '`',
            has_rowid_fallback: false,
        }
    }
    fn tref() -> TableRef {
        TableRef { database: None, schema: Some("public".into()), name: "users".into() }
    }
    fn tref_mysql() -> TableRef {
        TableRef { database: Some("shop".into()), schema: None, name: "users".into() }
    }

    #[test]
    fn insert_pg() {
        let mut values = BTreeMap::new();
        values.insert("name".to_string(), Value::Text("ann".into()));
        values.insert("age".to_string(), Value::Int(30));
        let s = build_stmt(&pg_caps(), &tref(), &Change::Insert { values }).unwrap();
        // BTreeMap 有序：age, name
        assert_eq!(
            s.sql,
            r#"INSERT INTO "public"."users" ("age", "name") VALUES ($1, $2)"#
        );
        assert_eq!(s.params, vec![Value::Int(30), Value::Text("ann".into())]);
    }

    #[test]
    fn update_with_key_pg() {
        let mut set = BTreeMap::new();
        set.insert("name".to_string(), Value::Text("bob".into()));
        let mut key = BTreeMap::new();
        key.insert("id".to_string(), Value::Int(7));
        let s = build_stmt(&pg_caps(), &tref(), &Change::Update { key, set }).unwrap();
        assert_eq!(s.sql, r#"UPDATE "public"."users" SET "name" = $1 WHERE "id" = $2"#);
        assert_eq!(s.params, vec![Value::Text("bob".into()), Value::Int(7)]);
    }

    #[test]
    fn delete_mysql_question_style() {
        let mut key = BTreeMap::new();
        key.insert("id".to_string(), Value::Int(7));
        let s = build_stmt(&mysql_caps(), &tref_mysql(), &Change::Delete { key }).unwrap();
        assert_eq!(s.sql, "DELETE FROM `shop`.`users` WHERE `id` = ?");
        assert_eq!(s.params, vec![Value::Int(7)]);
    }

    #[test]
    fn null_key_uses_is_null() {
        let mut set = BTreeMap::new();
        set.insert("x".to_string(), Value::Int(1));
        let mut key = BTreeMap::new();
        key.insert("a".to_string(), Value::Null);
        key.insert("b".to_string(), Value::Int(2));
        let s = build_stmt(&pg_caps(), &tref(), &Change::Update { key, set }).unwrap();
        // a IS NULL（不占位），b = $2
        assert_eq!(
            s.sql,
            r#"UPDATE "public"."users" SET "x" = $1 WHERE "a" IS NULL AND "b" = $2"#
        );
        assert_eq!(s.params, vec![Value::Int(1), Value::Int(2)]);
    }

    #[test]
    fn rejects_quote_in_identifier() {
        let mut values = BTreeMap::new();
        values.insert(r#"ev"il"#.to_string(), Value::Int(1));
        assert!(build_stmt(&pg_caps(), &tref(), &Change::Insert { values }).is_err());
    }

    #[test]
    fn preview_expands_dollar() {
        let stmt = Stmt {
            sql: r#"UPDATE "t" SET "n" = $1 WHERE "id" = $2"#.into(),
            params: vec![Value::Text("o'brien".into()), Value::Int(5)],
        };
        let p = expand_for_preview(&stmt);
        assert_eq!(p, r#"UPDATE "t" SET "n" = 'o''brien' WHERE "id" = 5"#);
    }

    #[test]
    fn preview_expands_question() {
        let stmt = Stmt {
            sql: "DELETE FROM `t` WHERE `id` = ?".into(),
            params: vec![Value::Int(9)],
        };
        assert_eq!(expand_for_preview(&stmt), "DELETE FROM `t` WHERE `id` = 9");
    }
}
