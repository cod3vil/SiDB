//! 保存的查询（PRD §3.3）：持久化到 `~/.dblite/queries.json`（原子写）。
//! 按 (conn_id, database, schema) 归属到对象树的「查询」节点。

use super::settings::data_dir;
use crate::models::*;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedQuery {
    pub id: String,
    pub name: String,
    pub conn_id: String,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub sql: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SavedQueryInput {
    pub id: Option<String>,
    pub name: String,
    pub conn_id: String,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub sql: String,
}

fn store_path() -> PathBuf {
    data_dir().join("queries.json")
}

pub fn load() -> Vec<SavedQuery> {
    match std::fs::read_to_string(store_path()) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn save_all(list: &[SavedQuery]) -> Result<()> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| AppError::Internal(e.to_string()))?;
    let tmp = dir.join("queries.json.tmp");
    let body = serde_json::to_string_pretty(list).map_err(|e| AppError::Internal(e.to_string()))?;
    std::fs::write(&tmp, body).map_err(|e| AppError::Internal(e.to_string()))?;
    std::fs::rename(&tmp, store_path()).map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(())
}

pub fn save(input: SavedQueryInput) -> Result<SavedQuery> {
    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let q = SavedQuery {
        id: id.clone(),
        name: input.name,
        conn_id: input.conn_id,
        database: input.database,
        schema: input.schema,
        sql: input.sql,
    };
    let mut list = load();
    if let Some(existing) = list.iter_mut().find(|x| x.id == id) {
        *existing = q.clone();
    } else {
        list.push(q.clone());
    }
    save_all(&list)?;
    Ok(q)
}

pub fn delete(id: &str) -> Result<()> {
    let mut list = load();
    list.retain(|x| x.id != id);
    save_all(&list)
}
