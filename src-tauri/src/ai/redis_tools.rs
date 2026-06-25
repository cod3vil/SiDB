//! Redis（KV）AI 工具：与 SQL 工具平行的一套，供 redis 连接的 agent 使用。
//! 只读命令经 `redis_read`（白名单校验）；写操作只产 proposal，执行经 `ai_confirm_write`。

use crate::ai::proposals::ProposalStore;
use crate::ai::provider::ToolDef;
use crate::ai::tools::{ToolOutcome, ToolStep};
use crate::kv::Reply;
use crate::services::connection::ConnectionManager;

const MAX_RESULT_CHARS: usize = 6000;

/// 只读命令白名单（首词，大写）。写操作一律走 propose_write。
const READ_CMDS: &[&str] = &[
    "GET", "MGET", "STRLEN", "GETRANGE", "SUBSTR", "EXISTS", "TYPE", "TTL", "PTTL", "OBJECT",
    "MEMORY", "HGET", "HGETALL", "HMGET", "HKEYS", "HVALS", "HLEN", "HEXISTS", "HSCAN", "HRANDFIELD",
    "LRANGE", "LLEN", "LINDEX", "LPOS", "SMEMBERS", "SISMEMBER", "SCARD", "SSCAN", "SRANDMEMBER",
    "ZRANGE", "ZREVRANGE", "ZRANGEBYSCORE", "ZREVRANGEBYSCORE", "ZSCORE", "ZMSCORE", "ZCARD",
    "ZRANK", "ZREVRANK", "ZSCAN", "ZCOUNT", "XRANGE", "XREVRANGE", "XLEN", "XINFO", "SCAN", "KEYS",
    "DBSIZE", "RANDOMKEY", "BITCOUNT", "GETBIT", "PFCOUNT",
];

/// 命令分词：支持双引号包裹含空格的参数。
pub fn tokenize(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_q = false;
    let mut has = false;
    for ch in s.chars() {
        match ch {
            '"' => {
                in_q = !in_q;
                has = true;
            }
            c if c.is_whitespace() && !in_q => {
                if has {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => {
                cur.push(c);
                has = true;
            }
        }
    }
    if has {
        out.push(cur);
    }
    out
}

/// 暴露给模型的 Redis 工具。
pub fn tool_defs_redis() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "scan_keys".into(),
            description: "Scan keys in the current Redis DB, returning name + type + TTL. Use a glob pattern like user:* to narrow. Returns up to a few hundred keys.".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {"pattern": {"type": "string", "description": "glob match pattern, default *"}}
            }),
        },
        ToolDef {
            name: "redis_read".into(),
            description: "Run a single READ-ONLY Redis command (e.g. GET key, HGETALL key, LRANGE key 0 -1, TYPE key, TTL key). Server rejects any non-read command.".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {"command": {"type": "string", "description": "the full command line"}},
                "required": ["command"]
            }),
        },
        ToolDef {
            name: "propose_write".into(),
            description: "Propose a write Redis command (SET/DEL/HSET/EXPIRE/...). This does NOT execute it — returns a proposal the user must confirm. Use for any mutation; never claim it happened.".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {"command": {"type": "string", "description": "the full command line to run on confirm"}},
                "required": ["command"]
            }),
        },
    ]
}

fn clip(mut s: String) -> String {
    if s.len() > MAX_RESULT_CHARS {
        s.truncate(MAX_RESULT_CHARS);
        s.push_str("\n…(truncated)");
    }
    s
}

/// 把 Reply 压成给模型回灌的紧凑文本。
pub fn reply_to_text(r: &Reply) -> String {
    match r {
        Reply::Nil => "(nil)".into(),
        Reply::Int { value } => value.to_string(),
        Reply::Double { value } => value.to_string(),
        Reply::Bool { value } => value.to_string(),
        Reply::Status { text } => text.clone(),
        Reply::Error { text } => format!("ERROR: {text}"),
        Reply::Str { text, .. } => text.clone(),
        Reply::Array { items } => items.iter().map(reply_to_text).collect::<Vec<_>>().join(", "),
        Reply::Map { items } => items
            .iter()
            .map(|(k, v)| format!("{}={}", reply_to_text(k), reply_to_text(v)))
            .collect::<Vec<_>>()
            .join(", "),
    }
}

pub async fn execute_redis(
    conns: &ConnectionManager,
    proposals: &ProposalStore,
    conn_id: &str,
    db: i64,
    name: &str,
    input: &serde_json::Value,
) -> ToolOutcome {
    match name {
        "scan_keys" => scan_keys(conns, conn_id, db, input).await,
        "redis_read" => redis_read(conns, conn_id, db, input).await,
        "propose_write" => propose_write(proposals, conn_id, db, input),
        other => err_outcome(other, format!("unknown tool '{other}'")),
    }
}

fn err_outcome(tool: &str, msg: String) -> ToolOutcome {
    ToolOutcome {
        content: format!("ERROR: {msg}"),
        is_error: true,
        step: ToolStep { tool: tool.into(), summary: msg },
        proposal: None,
    }
}

async fn scan_keys(
    conns: &ConnectionManager,
    conn_id: &str,
    db: i64,
    input: &serde_json::Value,
) -> ToolOutcome {
    let pattern = input.get("pattern").and_then(|v| v.as_str()).unwrap_or("*");
    let Some(s) = conns.get_redis(conn_id) else {
        return err_outcome("scan_keys", "redis not connected".into());
    };
    let a = s.adapter.lock().await;
    match a.scan(db, pattern, "0", 300).await {
        Ok(page) => {
            let lines: Vec<String> = page
                .keys
                .iter()
                .map(|k| format!("{} [{}] ttl={}ms", k.name, k.typ, k.ttl_ms))
                .collect();
            let more = if page.cursor != "0" { "\n…(more keys, cursor not exhausted)" } else { "" };
            ToolOutcome {
                content: clip(format!("{} keys (pattern {pattern}):\n{}{}", lines.len(), lines.join("\n"), more)),
                is_error: false,
                step: ToolStep { tool: "scan_keys".into(), summary: format!("scan {pattern} → {} keys", lines.len()) },
                proposal: None,
            }
        }
        Err(e) => err_outcome("scan_keys", e.to_string()),
    }
}

async fn redis_read(
    conns: &ConnectionManager,
    conn_id: &str,
    db: i64,
    input: &serde_json::Value,
) -> ToolOutcome {
    let cmd = input.get("command").and_then(|v| v.as_str()).unwrap_or("").trim();
    let args = tokenize(cmd);
    if args.is_empty() {
        return err_outcome("redis_read", "empty command".into());
    }
    let head = args[0].to_uppercase();
    if !READ_CMDS.contains(&head.as_str()) {
        return err_outcome("redis_read", format!("'{head}' is not a read-only command; use propose_write"));
    }
    let Some(s) = conns.get_redis(conn_id) else {
        return err_outcome("redis_read", "redis not connected".into());
    };
    let a = s.adapter.lock().await;
    match a.command(db, &args).await {
        Ok(reply) => ToolOutcome {
            content: clip(reply_to_text(&reply)),
            is_error: matches!(reply, Reply::Error { .. }),
            step: ToolStep { tool: "redis_read".into(), summary: cmd.to_string() },
            proposal: None,
        },
        Err(e) => err_outcome("redis_read", e.to_string()),
    }
}

fn propose_write(
    proposals: &ProposalStore,
    conn_id: &str,
    db: i64,
    input: &serde_json::Value,
) -> ToolOutcome {
    let cmd = input.get("command").and_then(|v| v.as_str()).unwrap_or("").trim();
    if cmd.is_empty() {
        return err_outcome("propose_write", "empty command".into());
    }
    let id = proposals.put_redis(conn_id, db, cmd);
    ToolOutcome {
        content: format!("Proposal {id} created (awaiting user confirmation): {cmd}"),
        is_error: false,
        step: ToolStep { tool: "propose_write".into(), summary: cmd.to_string() },
        proposal: Some((id, cmd.to_string())),
    }
}
