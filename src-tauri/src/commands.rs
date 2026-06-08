//! IPC 边界层（TDD §8）。
//!
//! **只做参数校验 + DTO 转换，禁止业务逻辑**（CLAUDE.md 铁律 #2）。
//! 业务委托给 services；返回的 `AppError` 经 serde 暴露给前端按 `code` 分支处理。

use crate::ai::provider::{AiProvider, AnthropicProvider, OpenAiCompatProvider};
use crate::models::*;
use crate::services::connection::{
    self, ConnConfig, ConnConfigInput, ConnectionManager,
};
use crate::services::credential::{keys, CredentialService};
use crate::services::dml::ChangeSet;
use crate::services::edit::{CommitResult, EditService};
use crate::services::metadata;
use crate::services::query::{self, Page};
use crate::services::settings::{self, Settings};
use crate::tunnel::TunnelManager;
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

type R<T> = std::result::Result<T, AppError>;

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
    // 临时构造配置与目标做连通测试，不持久化。
    let cfg = ConnConfig {
        id: "__test__".into(),
        name: input.name.clone(),
        kind: input.kind,
        group: None,
        host: input.host.clone(),
        port: input.port,
        user: input.user.clone(),
        database: input.database.clone(),
        schema: input.schema.clone(),
        ssl_mode: input.ssl_mode,
        connect_timeout_secs: input.connect_timeout_secs.unwrap_or(10),
        sqlite_path: input.sqlite_path.clone(),
        ssh: input.ssh.clone(),
        has_password: input.password.is_some(),
    };
    let target = ConnTarget {
        kind: input.kind,
        host: input.host.unwrap_or_else(|| "127.0.0.1".into()),
        port: input.port.unwrap_or(0),
        user: input.user.unwrap_or_default(),
        password: input.password,
        database: input.database,
        schema: input.schema,
        ssl_mode: input.ssl_mode.unwrap_or(SslMode::Prefer),
        connect_timeout_secs: cfg.connect_timeout_secs,
        sqlite_path: input.sqlite_path,
    };
    let mut adapter = crate::adapters::create_adapter(input.kind);
    adapter.connect(&target).await?;
    adapter.ping().await?;
    adapter.disconnect().await;
    Ok(())
}

#[tauri::command]
pub async fn connect(state: State<'_, AppState>, conn_id: String) -> R<DbCapabilities> {
    let cfg = connection::load_configs()
        .into_iter()
        .find(|c| c.id == conn_id)
        .ok_or_else(|| AppError::Internal("connection not found".into()))?;
    // 一期：SSH 隧道由 TunnelManager 建立后用 override 改写目标（M2 接通）。
    let target = connection::build_target(&state.cred, &cfg, None)?;
    state.conns.connect(&cfg, target, None).await
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, conn_id: String) -> R<()> {
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
