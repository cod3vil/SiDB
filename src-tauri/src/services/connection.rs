//! 连接管理（TDD §6.1）。
//!
//! - 连接配置持久化到 `~/.dblite/connections.json`，**只存钥匙串引用键，不含明文**。
//! - 配置读写带原子写（临时文件 + rename）。
//! - `ConnectionManager` 持有活动会话（adapter + 可选隧道）。

use super::credential::{keys, CredentialService};
use super::settings::data_dir;
use crate::adapters::{create_adapter, DbAdapter, DbCapabilities};
use crate::models::*;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SshAuthKind {
    Password,
    Key,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuthKind,
    /// 私钥文件路径（Key 认证时）。
    pub key_path: Option<String>,
    // 口令 / 密码均存钥匙串，引用键由 conn_id 推导。
}

/// 持久化的连接配置（**不含明文凭证**）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnConfig {
    pub id: String,
    pub name: String,
    pub kind: DbKind,
    pub group: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub ssl_mode: Option<SslMode>,
    pub connect_timeout_secs: u64,
    pub sqlite_path: Option<String>,
    pub ssh: Option<SshConfig>,
    /// 是否设置了密码（明文在钥匙串，不在此结构）。
    pub has_password: bool,
}

/// 前端保存连接时传入（含明文密码，仅本次传输；写钥匙串后丢弃）。
#[derive(Debug, Clone, Deserialize)]
pub struct ConnConfigInput {
    pub id: Option<String>,
    pub name: String,
    pub kind: DbKind,
    pub group: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub user: Option<String>,
    pub password: Option<String>,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub ssl_mode: Option<SslMode>,
    pub connect_timeout_secs: Option<u64>,
    pub sqlite_path: Option<String>,
    pub ssh: Option<SshConfig>,
    pub ssh_password: Option<String>,
    pub ssh_passphrase: Option<String>,
}

fn config_path() -> PathBuf {
    data_dir().join("connections.json")
}

/// 读全部连接配置（不含凭证）。
pub fn load_configs() -> Vec<ConnConfig> {
    match std::fs::read_to_string(config_path()) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn save_configs(list: &[ConnConfig]) -> Result<()> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| AppError::Internal(e.to_string()))?;
    let tmp = dir.join("connections.json.tmp");
    let body = serde_json::to_string_pretty(list).map_err(|e| AppError::Internal(e.to_string()))?;
    std::fs::write(&tmp, body).map_err(|e| AppError::Internal(e.to_string()))?;
    std::fs::rename(&tmp, config_path()).map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(())
}

/// 保存（新增或更新）一条连接：明文密码写钥匙串后丢弃，配置只留引用。
pub fn save_connection(cred: &CredentialService, input: ConnConfigInput) -> Result<ConnConfig> {
    let id = input.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // 凭证入钥匙串。
    if let Some(pw) = &input.password {
        cred.set(&keys::conn_password(&id), pw)?;
    }
    if let Some(pw) = &input.ssh_password {
        cred.set(&keys::conn_ssh_password(&id), pw)?;
    }
    if let Some(pp) = &input.ssh_passphrase {
        cred.set(&keys::conn_ssh_passphrase(&id), pp)?;
    }

    let cfg = ConnConfig {
        id: id.clone(),
        name: input.name,
        kind: input.kind,
        group: input.group,
        host: input.host,
        port: input.port,
        user: input.user,
        database: input.database,
        schema: input.schema,
        ssl_mode: input.ssl_mode,
        connect_timeout_secs: input.connect_timeout_secs.unwrap_or(10),
        sqlite_path: input.sqlite_path,
        ssh: input.ssh,
        has_password: input.password.is_some(),
    };

    let mut list = load_configs();
    if let Some(existing) = list.iter_mut().find(|c| c.id == id) {
        *existing = cfg.clone();
    } else {
        list.push(cfg.clone());
    }
    save_configs(&list)?;
    Ok(cfg)
}

/// 删除连接，并同步清理钥匙串条目。
pub fn delete_connection(cred: &CredentialService, id: &str) -> Result<()> {
    let mut list = load_configs();
    list.retain(|c| c.id != id);
    save_configs(&list)?;
    let _ = cred.delete(&keys::conn_password(id));
    let _ = cred.delete(&keys::conn_ssh_password(id));
    let _ = cred.delete(&keys::conn_ssh_passphrase(id));
    Ok(())
}

/// 由配置 + 钥匙串凭证构造 adapter 连接目标。`host_override`/`port_override` 供隧道改写。
pub fn build_target(
    cred: &CredentialService,
    cfg: &ConnConfig,
    host_override: Option<(String, u16)>,
) -> Result<ConnTarget> {
    let password = if cfg.has_password {
        cred.get(&keys::conn_password(&cfg.id))?
    } else {
        None
    };
    let (host, port) = match host_override {
        Some((h, p)) => (h, p),
        None => (
            cfg.host.clone().unwrap_or_else(|| "127.0.0.1".into()),
            cfg.port.unwrap_or(default_port(cfg.kind)),
        ),
    };
    Ok(ConnTarget {
        kind: cfg.kind,
        host,
        port,
        user: cfg.user.clone().unwrap_or_default(),
        password,
        database: cfg.database.clone(),
        schema: cfg.schema.clone(),
        ssl_mode: cfg.ssl_mode.unwrap_or(SslMode::Prefer),
        connect_timeout_secs: cfg.connect_timeout_secs,
        sqlite_path: cfg.sqlite_path.clone(),
    })
}

fn default_port(kind: DbKind) -> u16 {
    match kind {
        DbKind::Mysql => 3306,
        DbKind::Postgres => 5432,
        DbKind::Sqlite => 0,
    }
}

/// 活动会话。
pub struct Session {
    pub conn_id: String,
    pub adapter: tokio::sync::Mutex<Box<dyn DbAdapter>>,
    pub caps: DbCapabilities,
    pub tunnel: Option<String>,
}

#[derive(Default)]
pub struct ConnectionManager {
    sessions: DashMap<String, Arc<Session>>,
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, conn_id: &str) -> Option<Arc<Session>> {
        self.sessions.get(conn_id).map(|s| s.clone())
    }

    /// 建立连接（隧道由 commands 层在调用前完成并通过 override 传入）。
    pub async fn connect(
        &self,
        cfg: &ConnConfig,
        target: ConnTarget,
        tunnel: Option<String>,
    ) -> Result<DbCapabilities> {
        let mut adapter = create_adapter(cfg.kind);
        adapter.connect(&target).await?;
        adapter.ping().await?;
        let caps = adapter.capabilities().clone();
        let session = Session {
            conn_id: cfg.id.clone(),
            adapter: tokio::sync::Mutex::new(adapter),
            caps: caps.clone(),
            tunnel,
        };
        self.sessions.insert(cfg.id.clone(), Arc::new(session));
        Ok(caps)
    }

    pub async fn disconnect(&self, conn_id: &str) {
        if let Some((_, session)) = self.sessions.remove(conn_id) {
            session.adapter.lock().await.disconnect().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_ports() {
        assert_eq!(default_port(DbKind::Mysql), 3306);
        assert_eq!(default_port(DbKind::Postgres), 5432);
    }

    #[test]
    fn build_target_uses_override() {
        let cred = CredentialService::memory();
        let cfg = ConnConfig {
            id: "x".into(),
            name: "t".into(),
            kind: DbKind::Postgres,
            group: None,
            host: Some("db.internal".into()),
            port: Some(5432),
            user: Some("u".into()),
            database: Some("app".into()),
            schema: Some("public".into()),
            ssl_mode: Some(SslMode::Require),
            connect_timeout_secs: 10,
            sqlite_path: None,
            ssh: None,
            has_password: false,
        };
        let t = build_target(&cred, &cfg, Some(("127.0.0.1".into(), 54321))).unwrap();
        assert_eq!(t.host, "127.0.0.1");
        assert_eq!(t.port, 54321);
        assert_eq!(t.database.as_deref(), Some("app"));
    }
}
