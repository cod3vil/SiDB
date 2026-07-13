//! 本地 MCP 服务：把 SiDB 管理的数据库经 MCP（Model Context Protocol）暴露给外部 AI 工具
//! （Claude Code / Codex 等），供其浏览结构、跑只读查询、并以「提案」方式发起写操作。
//!
//! - 传输：Streamable HTTP（JSON-RPC 2.0），仅绑定 `127.0.0.1`，`Authorization: Bearer <token>` 鉴权。
//! - 工具：`list_connections` + 每连接的 `list_databases/list_schemas/list_tables/get_schema/
//!   run_read_query/propose_write`。只读与 LIMIT 约束复用 [`crate::ai::tools`]。
//! - 安全：写操作只产提案（不执行），经 Tauri 事件 `mcp-proposal` 推给 SiDB 界面由用户确认。
//! - 连接：按需自动连接（复用 [`crate::commands::ensure_connected`]），每连接串行化避免竞态建连。

use crate::ai;
use crate::ai::proposals::ProposalStore;
use crate::ai::tools::ToolCtx;
use crate::models::{AppError, DbKind};
use crate::services::connection::{self, ConnConfig, ConnectionManager};
use crate::services::credential::{keys, CredentialService};
use crate::tunnel::TunnelManager;
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use dashmap::DashMap;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, Mutex as TokioMutex};

/// 运行中的服务句柄（端口 + 优雅关闭信号）。
struct RunHandle {
    port: u16,
    shutdown: oneshot::Sender<()>,
}

/// MCP 服务。所有字段 Arc 化，可作为 axum 状态廉价克隆。
#[derive(Clone)]
pub struct McpServer {
    conns: Arc<ConnectionManager>,
    cred: Arc<CredentialService>,
    tunnels: Arc<TunnelManager>,
    proposals: Arc<ProposalStore>,
    app: Arc<StdMutex<Option<AppHandle>>>,
    run: Arc<StdMutex<Option<RunHandle>>>,
    /// 已解析的 Bearer 令牌缓存（避免每请求读钥匙串）。
    token: Arc<StdMutex<Option<String>>>,
    /// 按 conn_id 串行化自动建连。
    connect_locks: Arc<DashMap<String, Arc<TokioMutex<()>>>>,
}

impl McpServer {
    pub fn new(
        conns: Arc<ConnectionManager>,
        cred: Arc<CredentialService>,
        tunnels: Arc<TunnelManager>,
        proposals: Arc<ProposalStore>,
    ) -> Self {
        Self {
            conns,
            cred,
            tunnels,
            proposals,
            app: Arc::new(StdMutex::new(None)),
            run: Arc::new(StdMutex::new(None)),
            token: Arc::new(StdMutex::new(None)),
            connect_locks: Arc::new(DashMap::new()),
        }
    }

    /// 注入 AppHandle（在 Tauri setup 阶段调用）。emit 事件需要它。
    pub fn set_app(&self, app: AppHandle) {
        *self.app.lock().unwrap() = Some(app);
    }

    // ---- 令牌 ----

    /// 取（或首次生成）Bearer 令牌，并缓存。
    pub fn ensure_token(&self) -> Result<String, AppError> {
        if let Some(t) = self.token.lock().unwrap().clone() {
            return Ok(t);
        }
        let t = match self.cred.get(&keys::mcp_token())? {
            Some(t) if !t.is_empty() => t,
            _ => {
                let t = gen_token();
                self.cred.set(&keys::mcp_token(), &t)?;
                t
            }
        };
        *self.token.lock().unwrap() = Some(t.clone());
        Ok(t)
    }

    /// 重新生成令牌（旧令牌立即失效）。
    pub fn rotate_token(&self) -> Result<String, AppError> {
        let t = gen_token();
        self.cred.set(&keys::mcp_token(), &t)?;
        *self.token.lock().unwrap() = Some(t.clone());
        Ok(t)
    }

    // ---- 生命周期 ----

    /// 启动服务（幂等：先停旧的）。返回实际绑定端口。
    pub async fn start(&self, port: u16) -> Result<u16, AppError> {
        self.stop().await;
        self.ensure_token()?; // 确保 token 已缓存供 handler 校验
                              // AppHandle 用于把写提案 emit 到界面；缺失时（如无头测试）emit 静默跳过，不阻断启动。
        let router = Router::new()
            .route("/mcp", post(handle_post).get(handle_get))
            .with_state(self.clone());
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let listener = tokio::net::TcpListener::bind(addr)
            .await
            .map_err(|e| AppError::Network(format!("MCP 端口 {port} 绑定失败: {e}")))?;
        let bound = listener
            .local_addr()
            .map_err(|e| AppError::Internal(e.to_string()))?
            .port();
        let (tx, rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = rx.await;
                })
                .await;
        });
        *self.run.lock().unwrap() = Some(RunHandle {
            port: bound,
            shutdown: tx,
        });
        tracing::info!("MCP server listening on 127.0.0.1:{bound}");
        Ok(bound)
    }

    /// 停止服务（未运行则无操作）。
    pub async fn stop(&self) {
        let handle = self.run.lock().unwrap().take();
        if let Some(h) = handle {
            let _ = h.shutdown.send(());
        }
    }

    /// (是否运行中, 端口)。
    pub fn status(&self) -> (bool, u16) {
        match &*self.run.lock().unwrap() {
            Some(h) => (true, h.port),
            None => (false, 0),
        }
    }

    // ---- 自动建连 ----

    async fn ensure_connected(&self, conn_id: &str) -> Result<(), AppError> {
        if self.conns.get(conn_id).is_some() {
            return Ok(());
        }
        let lock = self
            .connect_locks
            .entry(conn_id.to_string())
            .or_insert_with(|| Arc::new(TokioMutex::new(())))
            .clone();
        let _g = lock.lock().await;
        if self.conns.get(conn_id).is_some() {
            return Ok(());
        }
        crate::commands::ensure_connected(&self.conns, &self.cred, &self.tunnels, conn_id).await
    }

    // ---- 工具执行 ----

    fn initialize_result(&self, params: &Value) -> Value {
        // 回显客户端请求的协议版本（不支持时退回本服务默认版本）。
        let ver = params
            .get("protocolVersion")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("2025-06-18");
        json!({
            "protocolVersion": ver,
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "SiDB", "version": env!("CARGO_PKG_VERSION") },
            "instructions": "SiDB exposes the databases it manages. Call list_connections first to get a connection's id/name, then pass it as the required `connection` argument to the other tools. Writes are proposals the human approves inside SiDB — never assume a write ran."
        })
    }

    /// tools/call：始终返回 result（工具错误经 isError=true 表达）。
    async fn call_tool(&self, params: &Value) -> Result<Value, (i64, String)> {
        let name = params
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or((-32602, "missing tool name".to_string()))?;
        let args = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let (text, is_error) = self.run_tool(name, &args).await;
        Ok(json!({
            "content": [ { "type": "text", "text": text } ],
            "isError": is_error,
        }))
    }

    async fn run_tool(&self, name: &str, args: &Value) -> (String, bool) {
        if name == "list_connections" {
            return match list_connections() {
                Ok(s) => (s, false),
                Err(e) => (e, true),
            };
        }
        self.db_tool(name, args).await
    }

    /// 需要具体连接的工具：解析 connection → 自动建连 → 执行。
    async fn db_tool(&self, name: &str, args: &Value) -> (String, bool) {
        let Some(conn_ref) = str_arg(args, "connection") else {
            return (
                "missing required 'connection' (an id or name from list_connections)".into(),
                true,
            );
        };
        let Some(cfg) = resolve_conn(&conn_ref) else {
            return (format!("no saved connection matching '{conn_ref}'"), true);
        };
        if matches!(cfg.kind, DbKind::Redis) {
            return (
                "Redis connections are not exposed over MCP yet".into(),
                true,
            );
        }
        if let Err(e) = self.ensure_connected(&cfg.id).await {
            return (format!("connect failed: {e}"), true);
        }
        match name {
            "list_databases" => wrap(self.td_list_databases(&cfg.id).await),
            "list_schemas" => wrap(self.td_list_schemas(&cfg.id, args).await),
            "list_tables" | "get_schema" | "run_read_query" | "propose_write" => {
                let ctx = ToolCtx {
                    database: str_arg(args, "database"),
                    schema: str_arg(args, "schema"),
                    table: None,
                };
                let outcome =
                    ai::tools::execute(&self.conns, &self.proposals, &cfg.id, &ctx, name, args)
                        .await;
                // 写提案：推给 SiDB 界面等待用户确认。
                if let Some((id, sql)) = &outcome.proposal {
                    if let Some(app) = self.app.lock().unwrap().as_ref() {
                        let _ = app.emit(
                            "mcp-proposal",
                            json!({ "id": id, "conn_id": cfg.id, "conn_name": cfg.name, "sql": sql }),
                        );
                    }
                }
                (outcome.content, outcome.is_error)
            }
            other => (format!("unknown tool '{other}'"), true),
        }
    }

    async fn td_list_databases(&self, conn_id: &str) -> Result<String, String> {
        let s = self.conns.get(conn_id).ok_or("not connected")?;
        let a = s.adapter.lock().await;
        let dbs = a.list_databases().await.map_err(|e| e.to_string())?;
        Ok(
            json!({ "databases": dbs.iter().map(|d| d.name.as_str()).collect::<Vec<_>>() })
                .to_string(),
        )
    }

    async fn td_list_schemas(&self, conn_id: &str, args: &Value) -> Result<String, String> {
        let db = str_arg(args, "database").unwrap_or_default();
        let s = self.conns.get(conn_id).ok_or("not connected")?;
        let a = s.adapter.lock().await;
        let schemas = a.list_schemas(&db).await.map_err(|e| e.to_string())?;
        Ok(json!({ "schemas": schemas }).to_string())
    }
}

// ---- HTTP handlers ----

async fn handle_post(
    State(srv): State<McpServer>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    let token = srv.token.lock().unwrap().clone().unwrap_or_default();
    if !bearer_ok(&headers, &token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(rpc_error(Value::Null, -32001, "unauthorized")),
        )
            .into_response();
    }
    let method = body.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let id = body.get("id").cloned().unwrap_or(Value::Null);
    let has_id = !id.is_null();
    let params = body.get("params").cloned().unwrap_or_else(|| json!({}));

    // 通知（无 id，如 notifications/initialized）：无需响应体。
    if !has_id {
        return StatusCode::ACCEPTED.into_response();
    }
    let resp = match method {
        "initialize" => rpc_result(id, srv.initialize_result(&params)),
        "ping" => rpc_result(id, json!({})),
        "tools/list" => rpc_result(id, json!({ "tools": mcp_tool_defs() })),
        "tools/call" => match srv.call_tool(&params).await {
            Ok(r) => rpc_result(id, r),
            Err((code, msg)) => rpc_error(id, code, &msg),
        },
        _ => rpc_error(id, -32601, "Method not found"),
    };
    Json(resp).into_response()
}

/// GET /mcp：本服务不提供服务端主动推流的 SSE 通道，按规范返回 405。
async fn handle_get() -> Response {
    StatusCode::METHOD_NOT_ALLOWED.into_response()
}

fn bearer_ok(headers: &HeaderMap, token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| {
            s.strip_prefix("Bearer ")
                .or_else(|| s.strip_prefix("bearer "))
        })
        .map(|t| t == token)
        .unwrap_or(false)
}

fn rpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

// ---- helpers ----

fn gen_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn str_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
}

fn wrap(r: Result<String, String>) -> (String, bool) {
    match r {
        Ok(s) => (s, false),
        Err(e) => (format!("error: {e}"), true),
    }
}

/// 按 id 或 name 解析一条已保存连接。
fn resolve_conn(reference: &str) -> Option<ConnConfig> {
    let list = connection::load_configs();
    list.iter()
        .find(|c| c.id == reference)
        .or_else(|| list.iter().find(|c| c.name == reference))
        .cloned()
}

/// `list_connections` 工具：返回所有已保存连接（id / name / kind）。
fn list_connections() -> Result<String, String> {
    let list = connection::load_configs();
    let arr: Vec<Value> = list
        .iter()
        .map(|c| {
            json!({
                "id": c.id,
                "name": c.name,
                "kind": serde_json::to_value(c.kind).unwrap_or(Value::Null),
                "database": c.database,
            })
        })
        .collect();
    Ok(json!({ "connections": arr }).to_string())
}

/// MCP tools/list 定义。所有需连接的工具都带 required `connection` 参数。
fn mcp_tool_defs() -> Vec<Value> {
    let conn_prop = json!({
        "type": "string",
        "description": "connection id or name (from list_connections)"
    });
    vec![
        json!({
            "name": "list_connections",
            "description": "List the database connections SiDB manages (id, name, kind). Call this first to obtain a `connection` for the other tools.",
            "inputSchema": { "type": "object", "properties": {} }
        }),
        json!({
            "name": "list_databases",
            "description": "List databases on a connection.",
            "inputSchema": {
                "type": "object",
                "properties": { "connection": conn_prop },
                "required": ["connection"]
            }
        }),
        json!({
            "name": "list_schemas",
            "description": "List schemas within a database (PostgreSQL / SQL Server).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": conn_prop,
                    "database": { "type": "string" }
                },
                "required": ["connection"]
            }
        }),
        json!({
            "name": "list_tables",
            "description": "List tables/views in a database. Use before guessing table names.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": conn_prop,
                    "database": { "type": "string", "description": "omit to use the connection default" },
                    "schema": { "type": "string", "description": "PostgreSQL / SQL Server" }
                },
                "required": ["connection"]
            }
        }),
        json!({
            "name": "get_schema",
            "description": "Get a table's columns (name, type, nullable, primary key). Call before writing SQL against a table.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": conn_prop,
                    "table": { "type": "string" },
                    "database": { "type": "string" },
                    "schema": { "type": "string" }
                },
                "required": ["connection", "table"]
            }
        }),
        json!({
            "name": "run_read_query",
            "description": "Run a single read-only SQL (SELECT/WITH/SHOW/EXPLAIN). The server enforces single statement, read-only, LIMIT 1000 and a 30s timeout. Never use for writes.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": conn_prop,
                    "sql": { "type": "string" },
                    "database": { "type": "string" },
                    "schema": { "type": "string" }
                },
                "required": ["connection", "sql"]
            }
        }),
        json!({
            "name": "propose_write",
            "description": "Propose an INSERT/UPDATE/DELETE/DDL. This does NOT execute — it creates a proposal the SiDB user must approve. Use for any write; never claim the write happened.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection": conn_prop,
                    "sql": { "type": "string" }
                },
                "required": ["connection", "sql"]
            }
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_parsing() {
        let mut h = HeaderMap::new();
        h.insert("authorization", "Bearer abc123".parse().unwrap());
        assert!(bearer_ok(&h, "abc123"));
        assert!(!bearer_ok(&h, "nope"));
        assert!(!bearer_ok(&HeaderMap::new(), "abc123"));
        // 空 token 一律拒绝（未配置时不放行）。
        assert!(!bearer_ok(&h, ""));
    }

    #[test]
    fn tool_defs_cover_expected() {
        let names: Vec<String> = mcp_tool_defs()
            .iter()
            .map(|t| t["name"].as_str().unwrap().to_string())
            .collect();
        for n in [
            "list_connections",
            "list_databases",
            "list_schemas",
            "list_tables",
            "get_schema",
            "run_read_query",
            "propose_write",
        ] {
            assert!(names.contains(&n.to_string()), "missing tool {n}");
        }
    }

    #[test]
    fn rpc_shapes() {
        let r = rpc_result(json!(1), json!({"ok": true}));
        assert_eq!(r["jsonrpc"], "2.0");
        assert_eq!(r["id"], 1);
        assert_eq!(r["result"]["ok"], true);
        let e = rpc_error(json!("x"), -32601, "Method not found");
        assert_eq!(e["error"]["code"], -32601);
    }

    #[test]
    fn token_is_hex_64() {
        let t = gen_token();
        assert_eq!(t.len(), 64);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    }

    fn test_server() -> McpServer {
        McpServer::new(
            Arc::new(ConnectionManager::new()),
            Arc::new(CredentialService::memory()),
            Arc::new(TunnelManager::new()),
            Arc::new(ProposalStore::new()),
        )
    }

    /// 端到端跑一遍真实 HTTP + JSON-RPC：鉴权 / initialize / tools/list / tools/call。
    #[tokio::test]
    async fn http_protocol_end_to_end() {
        let srv = test_server();
        let token = srv.ensure_token().unwrap();
        let port = srv.start(0).await.unwrap();
        let url = format!("http://127.0.0.1:{port}/mcp");
        let http = reqwest::Client::new();

        // 无令牌 → 401
        let r = http
            .post(&url)
            .json(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status().as_u16(), 401);

        // initialize（带令牌）
        let r: Value = http
            .post(&url)
            .bearer_auth(&token)
            .json(&json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(r["result"]["serverInfo"]["name"], "SiDB");
        assert_eq!(r["result"]["protocolVersion"], "2025-06-18");

        // 通知（无 id）→ 202，无响应体
        let r = http
            .post(&url)
            .bearer_auth(&token)
            .json(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
            .send()
            .await
            .unwrap();
        assert_eq!(r.status().as_u16(), 202);

        // tools/list 含预期工具
        let r: Value = http
            .post(&url)
            .bearer_auth(&token)
            .json(&json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let names: Vec<&str> = r["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert!(names.contains(&"list_connections"));
        assert!(names.contains(&"run_read_query"));

        // tools/call list_connections → 返回 content 文本（连接列表 JSON）
        let r: Value = http
            .post(&url)
            .bearer_auth(&token)
            .json(&json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_connections","arguments":{}}}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(r["result"]["isError"], false);
        let text = r["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("connections"));

        // 缺 connection 的 db 工具 → isError=true
        let r: Value = http
            .post(&url)
            .bearer_auth(&token)
            .json(&json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_tables","arguments":{}}}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(r["result"]["isError"], true);

        // 未知方法 → JSON-RPC error -32601
        let r: Value = http
            .post(&url)
            .bearer_auth(&token)
            .json(&json!({"jsonrpc":"2.0","id":5,"method":"bogus/method"}))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(r["error"]["code"], -32601);

        srv.stop().await;
    }
}
