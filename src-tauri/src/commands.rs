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
use crate::services::export;
use crate::services::metadata;
use crate::services::query::{self, Page};
use crate::services::saved_query;
use crate::services::settings::{self, Settings};
use crate::tunnel::{SshAuth, TunnelManager, TunnelSpec};
use dashmap::DashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

/// 全局应用状态。
pub struct AppState {
    pub conns: ConnectionManager,
    pub cred: CredentialService,
    pub tunnels: TunnelManager,
    /// AI 写操作提案暂存（经 `ai_confirm_write` 执行）。
    pub proposals: crate::ai::proposals::ProposalStore,
    /// 进行中的导出任务取消标志（task_id → flag）。
    pub exports: Arc<DashMap<String, Arc<AtomicBool>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            conns: ConnectionManager::new(),
            cred: CredentialService::keyring(),
            tunnels: TunnelManager::new(),
            proposals: crate::ai::proposals::ProposalStore::new(),
            exports: Arc::new(DashMap::new()),
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
            SshAuth::Key {
                pem,
                passphrase: ssh_passphrase,
            }
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
    let dur = |secs: u64| (secs > 0).then(|| std::time::Duration::from_secs(secs));
    let timeouts = connection::SessionTimeouts {
        keepalive: dur(cfg.keepalive_secs),
        read: dur(cfg.read_timeout_secs),
        write: dur(cfg.write_timeout_secs),
    };
    match state
        .conns
        .connect(&cfg, target, tunnel_id.clone(), timeouts)
        .await
    {
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
pub async fn list_functions(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    schema: Option<String>,
) -> R<Vec<RoutineInfo>> {
    let s = session(&state, &conn_id)?;
    let a = s.adapter.lock().await;
    a.list_functions(&database, schema.as_deref()).await
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

#[tauri::command]
pub async fn get_function_ddl(
    state: State<'_, AppState>,
    conn_id: String,
    routine: RoutineRef,
) -> R<String> {
    let s = session(&state, &conn_id)?;
    let a = s.adapter.lock().await;
    a.function_ddl(&routine).await
}

#[tauri::command]
pub async fn create_function(
    state: State<'_, AppState>,
    conn_id: String,
    database: Option<String>,
    definition: String,
) -> R<()> {
    let s = session(&state, &conn_id)?;
    let mut a = s.adapter.lock().await;
    // 确保在编辑器选定的库中创建（仅 MySQL 等会话切换方言生效；PG/SQLite 无操作）。
    a.use_database(database).await?;
    a.create_function(&definition).await
}

#[tauri::command]
pub async fn replace_function(
    state: State<'_, AppState>,
    conn_id: String,
    routine: RoutineRef,
    definition: String,
) -> R<()> {
    let s = session(&state, &conn_id)?;
    let mut a = s.adapter.lock().await;
    // 切到函数所在库，保证 CREATE（定义内函数名未带库前缀）落在正确的库（MySQL）。
    a.use_database(routine.database.clone()).await?;
    a.replace_function(&routine, &definition).await
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
    let sort = sort_column
        .as_deref()
        .map(|c| (c, sort_asc.unwrap_or(true)));
    let sql = query::browse_sql(&s.caps, &table, pg, sort)?;
    let qid = uuid::Uuid::new_v4().to_string();
    let started = std::time::Instant::now();
    let raw = query::with_timeout(s.read_timeout, a.query(&qid, &sql, &[])).await?;
    let returned = raw.rows.len() as u64;
    let editable = metadata::editability(&**a, &table).await?;
    let total_hint = query::count_table(&**a, &s.caps, &table, s.read_timeout).await;
    Ok(ResultSet {
        columns: raw.columns,
        rows: raw.rows,
        total_hint,
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
    Affected {
        affected_rows: u64,
        last_insert_id: Option<i64>,
        elapsed_ms: u64,
        statement: String,
    },
}

#[tauri::command]
pub async fn run_sql(
    state: State<'_, AppState>,
    conn_id: String,
    tab_id: String,
    sql: String,
    page: u64,
    page_size: u64,
    database: Option<String>,
) -> R<Vec<RunResult>> {
    let s = session(&state, &conn_id)?;
    let mut a = s.adapter.lock().await;
    // 编辑器选定的当前库（仅 MySQL 等支持会话切换的方言生效；其余为无操作）。
    a.use_database(database).await?;
    let pg = Page { page, page_size };
    let outcomes =
        query::run_script(&**a, &tab_id, &sql, pg, s.read_timeout, s.write_timeout).await?;
    Ok(outcomes
        .into_iter()
        .map(|o| match o {
            query::RunOutcome::Rows(rs) => RunResult::Rows(rs),
            query::RunOutcome::Affected {
                affected_rows,
                last_insert_id,
                elapsed_ms,
                statement,
            } => RunResult::Affected {
                affected_rows,
                last_insert_id,
                elapsed_ms,
                statement,
            },
        })
        .collect())
}

#[tauri::command]
pub async fn cancel_query(state: State<'_, AppState>, conn_id: String, query_id: String) -> R<()> {
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

// ---- 保存的查询 -----------------------------------------------------------

#[tauri::command]
pub fn list_queries() -> R<Vec<saved_query::SavedQuery>> {
    Ok(saved_query::load())
}

#[tauri::command]
pub fn save_query(input: saved_query::SavedQueryInput) -> R<saved_query::SavedQuery> {
    saved_query::save(input)
}

#[tauri::command]
pub fn delete_query(id: String) -> R<()> {
    saved_query::delete(&id)
}

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
            AnthropicProvider {
                api_key: input.api_key.clone(),
                model: input.model,
            }
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

// ---- AI（二期：对话 + 工具循环 + 写提案确认）----------------------------

#[derive(serde::Deserialize)]
pub struct AiChatMsg {
    pub role: String,
    pub text: String,
}

#[derive(serde::Deserialize)]
pub struct AiChatInput {
    pub conn_id: String,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub table: Option<String>,
    pub history: Vec<AiChatMsg>,
    pub message: String,
}

/// 据当前 AiSettings + 钥匙串 key 构造 provider。
fn build_provider(state: &AppState) -> R<Box<dyn AiProvider>> {
    let ai = settings::load().ai;
    let key = state
        .cred
        .get(&keys::ai_api_key(&ai.provider))?
        .filter(|k| !k.is_empty())
        .ok_or_else(|| AppError::Internal("AI 未配置：请先在设置中填写并测试 API Key".into()))?;
    let provider: Box<dyn AiProvider> = match ai.provider.as_str() {
        "anthropic" => Box::new(AnthropicProvider {
            api_key: key,
            model: ai.model,
        }),
        _ => Box::new(OpenAiCompatProvider {
            api_key: key,
            model: ai.model,
            base_url: ai
                .base_url
                .unwrap_or_else(|| "https://api.openai.com/v1".into()),
        }),
    };
    Ok(provider)
}

#[tauri::command]
pub async fn ai_chat(
    state: State<'_, AppState>,
    input: AiChatInput,
) -> R<crate::ai::agent::TurnResult> {
    let provider = build_provider(&state)?;
    // 切换会话当前库到所选库（MySQL 生效；PG/SQLite 无操作），
    // 让 AI 的裸查询（SELECT DATABASE() / 未限定表名）命中用户选中的数据库而非连接默认库。
    {
        let s = session(&state, &input.conn_id)?;
        let mut a = s.adapter.lock().await;
        a.use_database(input.database.clone()).await?;
    }
    let history: Vec<crate::ai::provider::Msg> = input
        .history
        .into_iter()
        .map(|m| {
            let role = if m.role == "assistant" {
                "assistant"
            } else {
                "user"
            };
            crate::ai::provider::Msg {
                role: role.into(),
                content: vec![crate::ai::provider::ContentBlock::Text { text: m.text }],
            }
        })
        .collect();
    let ctx = crate::ai::tools::ToolCtx {
        database: input.database,
        schema: input.schema,
        table: input.table,
    };
    crate::ai::agent::run_turn(
        provider.as_ref(),
        &state.conns,
        &state.proposals,
        &input.conn_id,
        ctx,
        history,
        input.message,
    )
    .await
}

#[derive(serde::Deserialize)]
pub struct AiConfirmInput {
    pub conn_id: String,
    pub proposal_id: String,
}

#[tauri::command]
pub async fn ai_confirm_write(
    state: State<'_, AppState>,
    input: AiConfirmInput,
) -> R<Vec<RunResult>> {
    let p = state
        .proposals
        .take(&input.proposal_id)
        .ok_or_else(|| AppError::Internal("提案不存在或已过期".into()))?;
    if p.conn_id != input.conn_id {
        return Err(AppError::Internal("提案与当前连接不匹配".into()));
    }
    let s = session(&state, &input.conn_id)?;
    let a = s.adapter.lock().await;
    let pg = Page {
        page: 0,
        page_size: 1,
    };
    let outcomes = query::run_script(
        &**a,
        "ai_write",
        &p.sql,
        pg,
        s.read_timeout,
        s.write_timeout,
    )
    .await?;
    crate::ai::audit::record(&input.conn_id, "confirm_write", &p.sql, "executed");
    Ok(outcomes
        .into_iter()
        .map(|o| match o {
            query::RunOutcome::Rows(rs) => RunResult::Rows(rs),
            query::RunOutcome::Affected {
                affected_rows,
                last_insert_id,
                elapsed_ms,
                statement,
            } => RunResult::Affected {
                affected_rows,
                last_insert_id,
                elapsed_ms,
                statement,
            },
        })
        .collect())
}

// ---- 导出（后台任务 + 进度事件） -----------------------------------------

/// 导出进度事件载荷（事件名 `export:progress`）。
#[derive(Clone, serde::Serialize)]
pub struct ExportProgress {
    pub task_id: String,
    pub written: u64,
    pub total: Option<u64>,
    /// running | done | cancelled | error
    pub status: String,
    pub message: Option<String>,
}

fn emit_progress(app: &AppHandle, p: ExportProgress) {
    let _ = app.emit("export:progress", p);
}

/// 取消进行中的导出任务。
#[tauri::command]
pub fn cancel_export(state: State<'_, AppState>, task_id: String) -> R<()> {
    if let Some(flag) = state.exports.get(&task_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// 导出结果集（表浏览或自定义查询）→ CSV / XLSX / SQL。返回 task_id，进度走 `export:progress` 事件。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn start_export_result(
    app: AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    sql: Option<String>,
    table: Option<TableRef>,
    format: String,
    scope: String,
    page: u64,
    page_size: u64,
    limit: Option<u64>,
    sql_table_name: Option<String>,
    path: String,
) -> R<String> {
    let s = session(&state, &conn_id)?;
    let fmt = export::ExportFormat::parse(&format)?;
    let source = match (table.clone(), sql) {
        (Some(t), _) => export::ExportSource::Table(t),
        (None, Some(q)) => export::ExportSource::Query(q),
        _ => return Err(AppError::Internal("export: no source".into())),
    };
    let sc = match scope.as_str() {
        "all" => export::ExportScope::All,
        "page" => export::ExportScope::Page(page),
        "rows" => export::ExportScope::Rows(limit.unwrap_or(0)),
        other => return Err(AppError::Internal(format!("export: bad scope {other}"))),
    };
    let table_name = sql_table_name
        .or_else(|| table.as_ref().map(|t| t.name.clone()))
        .unwrap_or_else(|| "result".into());

    let task_id = uuid::Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    state.exports.insert(task_id.clone(), cancel.clone());
    let registry = state.exports.clone();
    let tid = task_id.clone();
    let page_size = page_size.max(1);

    tokio::spawn(async move {
        let res = export::run_result_export(
            &s,
            source,
            fmt,
            sc,
            page_size,
            &path,
            &table_name,
            &cancel,
            |t| {
                emit_progress(
                    &app,
                    ExportProgress {
                        task_id: tid.clone(),
                        written: t.written,
                        total: t.total,
                        status: "running".into(),
                        message: t.message,
                    },
                );
            },
        )
        .await;
        finish_export(&app, &registry, &tid, &path, res);
    });
    Ok(task_id)
}

/// 转存表 / 数据库结构（可含数据）→ .sql。返回 task_id。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn start_export_structure(
    app: AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    table: Option<TableRef>,
    is_view: Option<bool>,
    database: Option<String>,
    schema: Option<String>,
    with_data: bool,
    path: String,
) -> R<String> {
    let s = session(&state, &conn_id)?;
    let tables: Vec<export::DumpTable> = if let Some(t) = table {
        vec![export::DumpTable {
            tref: t,
            with_data: with_data && !is_view.unwrap_or(false),
        }]
    } else {
        let db = database.clone().unwrap_or_default();
        let a = s.adapter.lock().await;
        let list = a.list_tables(&db, schema.as_deref()).await?;
        drop(a);
        list.into_iter()
            .map(|ti| export::DumpTable {
                tref: TableRef {
                    database: database.clone(),
                    schema: schema.clone(),
                    name: ti.name,
                },
                with_data: with_data && matches!(ti.kind, TableKind::Table),
            })
            .collect()
    };

    let task_id = uuid::Uuid::new_v4().to_string();
    let cancel = Arc::new(AtomicBool::new(false));
    state.exports.insert(task_id.clone(), cancel.clone());
    let registry = state.exports.clone();
    let tid = task_id.clone();

    tokio::spawn(async move {
        let res = export::run_structure_export(&s, tables, 1000, &path, &cancel, |t| {
            emit_progress(
                &app,
                ExportProgress {
                    task_id: tid.clone(),
                    written: t.written,
                    total: t.total,
                    status: "running".into(),
                    message: t.message,
                },
            );
        })
        .await;
        finish_export(&app, &registry, &tid, &path, res);
    });
    Ok(task_id)
}

/// 统一收尾：清理取消标志、删除取消时的半成品文件、发终态事件。
fn finish_export(
    app: &AppHandle,
    registry: &Arc<DashMap<String, Arc<AtomicBool>>>,
    task_id: &str,
    path: &str,
    res: R<export::ExportOutcome>,
) {
    registry.remove(task_id);
    let p = match res {
        Ok(o) if o.cancelled => {
            let _ = std::fs::remove_file(path);
            ExportProgress {
                task_id: task_id.into(),
                written: o.written,
                total: None,
                status: "cancelled".into(),
                message: None,
            }
        }
        Ok(o) => ExportProgress {
            task_id: task_id.into(),
            written: o.written,
            total: Some(o.written),
            status: "done".into(),
            message: Some(path.to_string()),
        },
        Err(e) => {
            let _ = std::fs::remove_file(path);
            ExportProgress {
                task_id: task_id.into(),
                written: 0,
                total: None,
                status: "error".into(),
                message: Some(e.to_string()),
            }
        }
    };
    emit_progress(app, p);
}
