//! 写操作提案暂存（TDD §7）。`propose_write` 工具只产提案，执行经 `ai_confirm_write`。
//! 内存存储 + 5 分钟过期；id 用「自增序号」，避免引入 uuid 依赖。

use chrono::{DateTime, Utc};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

const TTL_SECS: i64 = 300;

#[derive(Debug, Clone)]
pub struct Proposal {
    pub id: String,
    pub conn_id: String,
    pub sql: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Default)]
pub struct ProposalStore {
    inner: Mutex<HashMap<String, Proposal>>,
    seq: AtomicU64,
}

impl ProposalStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// 暂存一条写提案，返回其 id。
    pub fn put(&self, conn_id: &str, sql: &str) -> String {
        let id = format!("wp_{}", self.seq.fetch_add(1, Ordering::Relaxed));
        let p = Proposal {
            id: id.clone(),
            conn_id: conn_id.to_string(),
            sql: sql.to_string(),
            created_at: Utc::now(),
        };
        if let Ok(mut m) = self.inner.lock() {
            m.retain(|_, v| !is_expired(v));
            m.insert(id.clone(), p);
        }
        id
    }

    /// 取出并移除一条未过期提案。
    pub fn take(&self, id: &str) -> Option<Proposal> {
        let mut m = self.inner.lock().ok()?;
        let p = m.remove(id)?;
        if is_expired(&p) {
            None
        } else {
            Some(p)
        }
    }
}

fn is_expired(p: &Proposal) -> bool {
    (Utc::now() - p.created_at).num_seconds() > TTL_SECS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn put_then_take_once() {
        let s = ProposalStore::new();
        let id = s.put("c1", "ALTER TABLE t ADD COLUMN x INT");
        let p = s.take(&id).expect("present");
        assert_eq!(p.conn_id, "c1");
        assert!(p.sql.contains("ALTER TABLE"));
        // 取过即无
        assert!(s.take(&id).is_none());
    }

    #[test]
    fn unknown_id_is_none() {
        let s = ProposalStore::new();
        assert!(s.take("wp_999").is_none());
    }
}
