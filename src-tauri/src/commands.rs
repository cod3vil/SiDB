//! IPC 边界层（TDD §8）。
//!
//! **只做参数校验 + DTO 转换，禁止业务逻辑**（CLAUDE.md 铁律 #2）。
//! 业务委托给 services；返回的 `AppError` 经 serde 暴露给前端按 `code` 分支处理。

use crate::adapters::DbCapabilities;
use crate::ai::provider::{AiProvider, AnthropicProvider, OpenAiCompatProvider};
use crate::models::*;
use crate::services::connection::{
    self, ConnConfig, ConnConfigInput, ConnectionManager, SshAuthKind, SshConfig,
};
use crate::services::credential::{keys, CredentialService};
use crate::services::dml::ChangeSet;
use crate::services::edit::{CommitResult, EditService};
use crate::services::metadata;
use crate::services::query::{self, Page};
use crate::services::settings::{self, Settings};
use crate::tunnel::{SshAuth, TunnelManager, TunnelSpec};
use std::sync::Arc;
use tauri::State;

/// 全局应用状态。
pub struct AppState {
    pub conns: ConnectionManager,
    pub cred: CredentialService,
    pub tunnels: TunnelManager,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            conns: ConnectionManager::new(),
            cred: CredentialService::keyring(),
            tunnels: TunnelManager::new(),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

type R<T> = std::result::Result<T, AppError>;

/// 建立 SSH 隧道，返回 `(tunnel_id, 本地转发地址)`（TDD §5 流程 1–2）。
/// 凭证（口令 / 私钥口令）由调用方取出后传入，用后即弃。
async fn open_tunnel(
    tunnels: &TunnelManager,
    ssh: &SshConfig,
    ssh_password: Option<String>,
    ssh_passphrase: Option<String>,
    remote_host: String,
    remote_port: u16,
) -> R<(String, (String, u16))> {
    let auth = match ssh.auth {
        SshAuthKind::Password => {
            SshAuth::Password(ssh_password.ok_or_else(|| AppError::Ssh("缺少 SSH 密码".into()))?)
        }
        SshAuthKind::Key => {
            let path = ssh
                .key_path
                .clone()
                .ok_or_else(|| AppError::Ssh("缺少私钥路径".into()))?;
            let pem = std::fs::read_to_string(&path)
                .map_err(|e| AppError::Ssh(format!("读取私钥失败: {e}")))?;
            SshAuth::Key { pem, passphrase: ssh_passphrase }
        }
    };
    let spec = TunnelSpec {
        ssh_host: ssh.host.clone(),
        ssh_port: ssh.port,
        ssh_user: ssh.user.clone(),
        auth,
        remote_host,
        remote_port,
    };
    let (id, addr) = tunnels.open(spec).await?;
    Ok((id, (addr.ip().to_string(), addr.port())))
}

// ---- 连接管理 -------------------------------------------------------------

#[tauri::command]
pub fn list_connections() -> R<Vec<ConnConfig>> {
    Ok(connection::load_configs())
}

#[tauri::command]
pub fn save_connection(state: State<'_, AppState>, input: ConnConfigInput) -> R<ConnConfig> {
    if input.name.trim().is_empty() {
        return Err(AppError::Internal("connection name required".into()));
    }
    connection::save_connection(&state.cred, input)
}

#[tauri::command]
pub fn delete_connection(state: State<'_, AppState>, id: String) -> R<()> {
    connection::delete_connection(&state.cred, &id)
}

#[tauri::command]
pub async fn test_connection(state: State<'_, AppState>, input: ConnConfigInput) -> R<()> {
    let timeout = input.connect_timeout_secs.unwrap_or(10);
    let mut host = input.host.clone().unwrap_or_else(|| "127.0.0.1".into());
    let mut port = input.port.unwrap_or(connection::default_port(input.kind));

    // 含 SSH 时先建隧道，把数据库目标改写到本地转发地址（凭证用 input 明文，测试不落盘）。
    let mut tunnel_id: Option<String> = None;
    if let (Some(ssh), false) = (&input.ssh, matches!(input.kind, DbKind::Sqlite)) {
        let (id, addr) = open_tunnel(
            &state.tunnels,
            ssh,
            input.ssh_password.clone(),
            input.ssh_passphrase.clone(),
            host.clone(),
            port,
        )
        .await?;
        tunnel_id = Some(id);
        host = addr.0;
        port = addr.1;
    }

    let target = ConnTarget {
        kind: input.kind,
        host,
        port,
        user: input.user.clone().unwrap_or_default(),
        password: input.password.clone(),
        database: input.database.clone(),
        schema: input.schema.clone(),
        ssl_mode: input.ssl_mode.unwrap_or(SslMode::Prefer),
        connect_timeout_secs: timeout,
        sqlite_path: input.sqlite_path.clone(),
    };
    let mut adapter = crate::adapters::create_adapter(input.kind);
    let result = async {
        adapter.connect(&target).await?;
        adapter.ping().await?;
        Ok::<(), AppError>(())
    }
    .await;
    adapter.disconnect().await;
    if let Some(id) = tunnel_id {
        state.tunnels.close(&id);
    }
    result
}

#[tauri::command]
pub async fn connect(state: State<'_, AppState>, conn_id: String) -> R<DbCapabilities> {
    let cfg = connection::load_configs()
        .into_iter()
        .find(|c| c.id == conn_id)
        .ok_or_else(|| AppError::Internal("connection not found".into()))?;

    // SSH 隧道：建立后用本地转发地址改写目标（TDD §5）。凭证从钥匙串取出，用后即弃。
    let mut tunnel_id: Option<String> = None;
    let mut host_override: Option<(String, u16)> = None;
    if let (Some(ssh), false) = (&cfg.ssh, matches!(cfg.kind, DbKind::Sqlite)) {
        let pw = state.cred.get(&keys::conn_ssh_password(&cfg.id))?;
        let pp = state.cred.get(&keys::conn_ssh_passphrase(&cfg.id))?;
        let remote_host = cfg.host.clone().unwrap_or_else(|| "127.0.0.1".into());
        let remote_port = cfg.port.unwrap_or(connection::default_port(cfg.kind));
        let (id, addr) = open_tunnel(&state.tunnels, ssh, pw, pp, remote_host, remote_port).await?;
        tunnel_id = Some(id);
        host_override = Some(addr);
    }

    let target = connection::build_target(&state.cred, &cfg, host_override)?;
    match state.conns.connect(&cfg, target, tunnel_id.clone()).await {
        Ok(caps) => Ok(caps),
        Err(e) => {
            // 连接失败时回收隧道。
            if let Some(id) = tunnel_id {
                state.tunnels.close(&id);
            }
            Err(e)
        }
    }
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, conn_id: String) -> R<()> {
    // 先关隧道（若有），再断开会话。
    if let Some(session) = state.conns.get(&conn_id) {
        if let Some(tid) = &session.tunnel {
            state.tunnels.close(tid);
        }
    }
    state.conns.disconnect(&conn_id).await;
    Ok(())
}

// ---- 元数据（树懒加载）----------------------------------------------------

fn session(state: &AppState, conn_id: &str) -> R<Arc<connection::Session>> {
    state
        .conns
        .get(conn_id)
        .ok_or_else(|| AppError::Internal("not connected".into()))
}

#[tauri::command]
pub async fn list_databases(state: State<'_, AppState>, conn_id: String) -> R<Vec<DatabaseInfo>> {
    let s = session(&state, &conn_id)?;
    let a = s.adapter.lock().await;
    a.list_databases().await
}

#[tauri::command]
pub async fn list_schemas(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
) -> R<Vec<String>> {
    let s = session(&state, &conn_id)?;
    let a = s.adapter.lock().await;
    a.list_schemas(&database).await
}

#[tauri::command]
pub async fn list_tables(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    schema: Option<String>,
) -> R<Vec<TableInfo>> {
    let s = session(&state, &conn_id)?;
    let a = s.adapter.lock().await;
    a.list_tables(&database, schema.as_deref()).await
}

#[tauri::command]
pub async fn list_columns(
    state: State<'_, AppState>,
    conn_id: String,
    table: TableRef,
) -> R<Vec<ColumnInfo>> {
    let s = session(&state, &conn_id)?;
    let a = s.adapter.lock().await;
    metadata::list_columns(&**a, &table).await
}

#[tauri::command]
pub async fn get_table_schema(
    state: State<'_, AppState>,
    conn_id: String,
    table: TableRef,
) -> R<TableSchema> {
    let s = session(&state, &conn_id)?;
    let a = s.adapter.lock().await;
    a.table_schema(&table).await
}

#[tauri::command]
pub async fn get_table_ddl(
    state: State<'_, AppState>,
    conn_id: String,
    table: TableRef,
) -> R<String> {
    let s = session(&state, &conn_id)?;
    let a = s.adapter.lock().await;
    a.table_ddl(&table).await
}

// ---- 查询 / 浏览 ----------------------------------------------------------

#[tauri::command]
pub async fn open_table_data(
    state: State<'_, AppState>,
    conn_id: String,
    table: TableRef,
    page: u64,
    page_size: u64,
    sort_column: Option<String>,
    sort_asc: Option<bool>,
) -> R<ResultSet> {
    let s = session(&state, &conn_id)?;
    let a = s.adapter.lock().await;
    let pg = Page { page, page_size };
    let sort = sort_column.as_deref().map(|c| (c, sort_asc.unwrap_or(true)));
    let sql = query::browse_sql(&s.caps, &table, pg, sort)?;
    let qid = uuid::Uuid::new_v4().to_string();
    let started = std::time::Instant::now();
    let raw = a.query(&qid, &sql, &[]).await?;
    let returned = raw.rows.len() as u64;
    let editable = metadata::editability(&**a, &table).await?;
    Ok(ResultSet {
        columns: raw.columns,
        rows: raw.rows,
        total_hint: None,
        page: query::page_info(pg, returned),
        elapsed_ms: started.elapsed().as_millis() as u64,
        editable,
    })
}

/// 一条语句的运行结果 DTO。
#[derive(serde::Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum RunResult {
    Rows(ResultSet),
    Affected { affected_rows: u64, last_insert_id: Option<i64> },
}

#[tauri::command]
pub async fn run_sql(
    state: State<'_, AppState>,
    conn_id: String,
    tab_id: String,
    sql: String,
    page: u64,
    page_size: u64,
) -> R<Vec<RunResult>> {
    let s = session(&state, &conn_id)?;
    let a = s.adapter.lock().await;
    let pg = Page { page, page_size };
    let outcomes = query::run_script(&**a, &tab_id, &sql, pg).await?;
    Ok(outcomes
        .into_iter()
        .map(|o| match o {
            query::RunOutcome::Rows(rs) => RunResult::Rows(rs),
            query::RunOutcome::Affected { affected_rows, last_insert_id } => {
                RunResult::Affected { affected_rows, last_insert_id }
            }
        })
        .collect())
}

#[tauri::command]
pub async fn cancel_query(
    state: State<'_, AppState>,
    conn_id: String,
    query_id: String,
) -> R<()> {
    let s = session(&state, &conn_id)?;
    let a = s.adapter.lock().await;
    a.cancel(&query_id).await
}

// ---- 数据编辑 -------------------------------------------------------------

#[tauri::command]
pub async fn preview_changes(
    state: State<'_, AppState>,
    conn_id: String,
    change_set: ChangeSet,
) -> R<Vec<String>> {
    let s = session(&state, &conn_id)?;
    let a = s.adapter.lock().await;
    EditService::preview(&**a, &change_set)
}

#[tauri::command]
pub async fn commit_changes(
    state: State<'_, AppState>,
    conn_id: String,
    change_set: ChangeSet,
) -> R<CommitResult> {
    let s = session(&state, &conn_id)?;
    let a = s.adapter.lock().await;
    EditService::commit(&**a, &change_set).await
}

// ---- 设置 -----------------------------------------------------------------

#[tauri::command]
pub fn get_settings() -> R<Settings> {
    Ok(settings::load())
}

#[tauri::command]
pub fn set_settings(settings: Settings) -> R<()> {
    settings::save(&settings)
}

// ---- AI（一期：测试连通）-------------------------------------------------

#[derive(serde::Deserialize)]
pub struct AiProviderInput {
    pub provider: String,
    pub api_key: String,
    pub model: String,
    pub base_url: Option<String>,
}

#[tauri::command]
pub async fn ai_test_provider(state: State<'_, AppState>, input: AiProviderInput) -> R<()> {
    let result = match input.provider.as_str() {
        "anthropic" => {
            AnthropicProvider { api_key: input.api_key.clone(), model: input.model }
                .test()
                .await
        }
        _ => {
            let base = input
                .base_url
                .clone()
                .unwrap_or_else(|| "https://api.openai.com/v1".into());
            OpenAiCompatProvider {
                api_key: input.api_key.clone(),
                model: input.model,
                base_url: base,
            }
            .test()
            .await
        }
    };
    // 连通成功后把 key 写入钥匙串（而非配置文件）。
    if result.is_ok() {
        state
            .cred
            .set(&keys::ai_api_key(&input.provider), &input.api_key)?;
    }
    result
}
