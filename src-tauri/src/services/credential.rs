//! 凭证服务（TDD §6.5）。
//!
//! 凭证（密码 / 私钥口令 / API key）只允许经此服务进系统钥匙串；
//! 禁止写入配置文件、日志、错误信息（CLAUDE.md 架构铁律 #4）。
//!
//! - 生产实现 [`KeyringStore`] 封装 `keyring` crate，service 名固定 `dblite`。
//! - 测试 / CI（无钥匙串）用 [`MemoryStore`]。

use crate::models::AppError;
use std::collections::HashMap;
use std::sync::Mutex;

/// 钥匙串 key 约定：
/// - `conn:{uuid}:password`
/// - `conn:{uuid}:ssh_passphrase`
/// - `conn:{uuid}:ssh_password`
/// - `ai:{provider}:api_key`
pub mod keys {
    pub fn conn_password(conn_id: &str) -> String {
        format!("conn:{conn_id}:password")
    }
    pub fn conn_ssh_passphrase(conn_id: &str) -> String {
        format!("conn:{conn_id}:ssh_passphrase")
    }
    pub fn conn_ssh_password(conn_id: &str) -> String {
        format!("conn:{conn_id}:ssh_password")
    }
    pub fn ai_api_key(provider: &str) -> String {
        format!("ai:{provider}:api_key")
    }
}

pub trait CredentialStore: Send + Sync {
    fn set(&self, key: &str, secret: &str) -> Result<(), AppError>;
    fn get(&self, key: &str) -> Result<Option<String>, AppError>;
    fn delete(&self, key: &str) -> Result<(), AppError>;
}

/// 生产实现：系统钥匙串。
pub struct KeyringStore {
    service: String,
}

impl KeyringStore {
    pub fn new() -> Self {
        Self {
            service: "dblite".to_string(),
        }
    }

    fn entry(&self, key: &str) -> Result<keyring::Entry, AppError> {
        keyring::Entry::new(&self.service, key).map_err(|e| AppError::Credential(e.to_string()))
    }
}

impl Default for KeyringStore {
    fn default() -> Self {
        Self::new()
    }
}

impl CredentialStore for KeyringStore {
    fn set(&self, key: &str, secret: &str) -> Result<(), AppError> {
        self.entry(key)?
            .set_password(secret)
            .map_err(|e| AppError::Credential(e.to_string()))
    }

    fn get(&self, key: &str) -> Result<Option<String>, AppError> {
        match self.entry(key)?.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::Credential(e.to_string())),
        }
    }

    fn delete(&self, key: &str) -> Result<(), AppError> {
        match self.entry(key)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::Credential(e.to_string())),
        }
    }
}

/// 测试 / CI 实现：进程内内存。
#[derive(Default)]
pub struct MemoryStore {
    inner: Mutex<HashMap<String, String>>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl CredentialStore for MemoryStore {
    fn set(&self, key: &str, secret: &str) -> Result<(), AppError> {
        self.inner
            .lock()
            .map_err(|_| AppError::Credential("poisoned mutex".into()))?
            .insert(key.to_string(), secret.to_string());
        Ok(())
    }

    fn get(&self, key: &str) -> Result<Option<String>, AppError> {
        Ok(self
            .inner
            .lock()
            .map_err(|_| AppError::Credential("poisoned mutex".into()))?
            .get(key)
            .cloned())
    }

    fn delete(&self, key: &str) -> Result<(), AppError> {
        self.inner
            .lock()
            .map_err(|_| AppError::Credential("poisoned mutex".into()))?
            .remove(key);
        Ok(())
    }
}

/// 对外封装：持有一个 `Box<dyn CredentialStore>`，统一入口。
pub struct CredentialService {
    store: Box<dyn CredentialStore>,
}

impl CredentialService {
    pub fn new(store: Box<dyn CredentialStore>) -> Self {
        Self { store }
    }

    /// 生产构造：系统钥匙串。
    pub fn keyring() -> Self {
        Self::new(Box::new(KeyringStore::new()))
    }

    /// 测试构造：内存。
    pub fn memory() -> Self {
        Self::new(Box::new(MemoryStore::new()))
    }

    pub fn set(&self, key: &str, secret: &str) -> Result<(), AppError> {
        self.store.set(key, secret)
    }

    pub fn get(&self, key: &str) -> Result<Option<String>, AppError> {
        self.store.get(key)
    }

    pub fn delete(&self, key: &str) -> Result<(), AppError> {
        self.store.delete(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_crud() {
        let svc = CredentialService::memory();
        let k = keys::conn_password("abc");

        assert_eq!(svc.get(&k).unwrap(), None);
        svc.set(&k, "s3cr3t").unwrap();
        assert_eq!(svc.get(&k).unwrap().as_deref(), Some("s3cr3t"));

        svc.set(&k, "rotated").unwrap();
        assert_eq!(svc.get(&k).unwrap().as_deref(), Some("rotated"));

        svc.delete(&k).unwrap();
        assert_eq!(svc.get(&k).unwrap(), None);
        // delete 幂等
        svc.delete(&k).unwrap();
    }

    #[test]
    fn key_conventions() {
        assert_eq!(keys::conn_password("u1"), "conn:u1:password");
        assert_eq!(keys::conn_ssh_passphrase("u1"), "conn:u1:ssh_passphrase");
        assert_eq!(keys::ai_api_key("anthropic"), "ai:anthropic:api_key");
    }
}
