//! Redis（KV）引擎 —— 与 SQL 的 `DbAdapter` 平行的独立适配器，仅单机 standalone。
//!
//! 设计要点：
//! - 全部走 raw `redis::cmd`，避免依赖各类型的 typed helper（减少 feature 牵连）。
//! - 连接用 `ConnectionManager`（自动重连）。逻辑库（0–15）不存状态：每个方法先 `SELECT db`
//!   再执行；调用方（Session）用 Mutex 串行化，保证 SELECT+op 原子，不会被并发打断。
//! - 非 UTF-8 的键 / 值用十六进制展示并打 `binary` 标记（Phase 1 已知限制：二进制键以 lossy 名展示）。

use crate::models::{AppError, ConnTarget, Result, SslMode};
use redis::aio::ConnectionManager;
use redis::{cmd, pipe, ConnectionAddr, ConnectionInfo, RedisConnectionInfo, Value as RValue};
use serde::Serialize;

// ---- 对外 DTO ----------------------------------------------------------------

/// 字符串字段：非 UTF-8 时 `text` 为十六进制、`binary=true`。
#[derive(Serialize, Clone)]
pub struct Field {
    pub text: String,
    pub binary: bool,
}

#[derive(Serialize)]
pub struct KeyMeta {
    pub name: String,
    #[serde(rename = "type")]
    pub typ: String,
    pub ttl_ms: i64,
}

#[derive(Serialize)]
pub struct ScanPage {
    pub cursor: String,
    pub keys: Vec<KeyMeta>,
}

#[derive(Serialize)]
pub struct KeyDetail {
    #[serde(rename = "type")]
    pub typ: String,
    pub ttl_ms: i64,
    pub mem_bytes: Option<i64>,
    pub size: i64,
}

#[derive(Serialize)]
pub struct StreamEntry {
    pub id: String,
    pub fields: Vec<(Field, Field)>,
}

/// 按类型的值载荷（带分页游标 / 区间 / 总数）。
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum RedisValue {
    String { value: Field },
    Hash { cursor: String, fields: Vec<(Field, Field)>, total: i64 },
    List { start: i64, stop: i64, items: Vec<Field>, total: i64 },
    Set { cursor: String, members: Vec<Field>, total: i64 },
    Zset { start: i64, stop: i64, items: Vec<(Field, f64)>, total: i64 },
    Stream { entries: Vec<StreamEntry>, total: i64 },
    None,
}

/// 命令台原始回复（映射 RESP）。
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Reply {
    Nil,
    Int { value: i64 },
    Str { text: String, binary: bool },
    Status { text: String },
    Error { text: String },
    Double { value: f64 },
    Bool { value: bool },
    Array { items: Vec<Reply> },
    Map { items: Vec<(Reply, Reply)> },
}

// ---- 工具函数 ----------------------------------------------------------------

fn map_err(e: redis::RedisError) -> AppError {
    AppError::Internal(format!("redis: {e}"))
}

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn to_field(b: Vec<u8>) -> Field {
    match String::from_utf8(b) {
        Ok(text) => Field { text, binary: false },
        Err(e) => Field { text: to_hex(&e.into_bytes()), binary: true },
    }
}

fn db_index(target: &ConnTarget) -> i64 {
    target
        .database
        .as_deref()
        .and_then(|s| s.trim().parse::<i64>().ok())
        .filter(|n| *n >= 0)
        .unwrap_or(0)
}

fn to_reply(v: RValue) -> Reply {
    match v {
        RValue::Nil => Reply::Nil,
        RValue::Int(n) => Reply::Int { value: n },
        RValue::BulkString(b) => {
            let f = to_field(b);
            Reply::Str { text: f.text, binary: f.binary }
        }
        RValue::SimpleString(s) => Reply::Status { text: s },
        RValue::Okay => Reply::Status { text: "OK".into() },
        RValue::Double(d) => Reply::Double { value: d },
        RValue::Boolean(b) => Reply::Bool { value: b },
        RValue::Array(a) | RValue::Set(a) => Reply::Array {
            items: a.into_iter().map(to_reply).collect(),
        },
        RValue::Map(m) => Reply::Map {
            items: m.into_iter().map(|(k, v)| (to_reply(k), to_reply(v))).collect(),
        },
        RValue::ServerError(e) => Reply::Error { text: format!("{e:?}") },
        other => Reply::Status { text: format!("{other:?}") },
    }
}

// ---- 适配器 ------------------------------------------------------------------

pub struct RedisAdapter {
    mgr: ConnectionManager,
}

async fn select(c: &mut ConnectionManager, db: i64) -> Result<()> {
    let _: () = cmd("SELECT").arg(db).query_async(c).await.map_err(map_err)?;
    Ok(())
}

impl RedisAdapter {
    pub async fn connect(target: &ConnTarget) -> Result<Self> {
        let tls = matches!(target.ssl_mode, SslMode::Require);
        let addr = if tls {
            ConnectionAddr::TcpTls {
                host: target.host.clone(),
                port: target.port,
                insecure: true, // Phase 1：不校验证书链（自签常见）
                tls_params: None,
            }
        } else {
            ConnectionAddr::Tcp(target.host.clone(), target.port)
        };
        let redis = RedisConnectionInfo {
            db: db_index(target),
            username: (!target.user.is_empty()).then(|| target.user.clone()),
            password: target.password.clone(),
            protocol: redis::ProtocolVersion::RESP2,
        };
        let client =
            redis::Client::open(ConnectionInfo { addr, redis }).map_err(map_err)?;
        // 套上连接超时 + 减少内部重试，避免连不上时一直「连接中」（默认会重试 + TCP 卡到系统超时）。
        let secs = target.connect_timeout_secs.max(1);
        let cfg = redis::aio::ConnectionManagerConfig::new()
            .set_connection_timeout(std::time::Duration::from_secs(secs))
            .set_number_of_retries(1);
        let mgr = tokio::time::timeout(
            std::time::Duration::from_secs(secs),
            ConnectionManager::new_with_config(client, cfg),
        )
        .await
        .map_err(|_| AppError::Timeout(format!("连接 Redis 超时（{secs}s）")))?
        .map_err(map_err)?;
        Ok(Self { mgr })
    }

    pub async fn ping(&self) -> Result<()> {
        let mut c = self.mgr.clone();
        let _: String = cmd("PING").query_async(&mut c).await.map_err(map_err)?;
        Ok(())
    }

    pub async fn disconnect(&mut self) {
        // ConnectionManager 无显式关闭；丢弃即可（drop 关闭底层连接）。
    }

    /// 逻辑库数量（CONFIG GET databases，受限时回退 16）。
    pub async fn db_count(&self) -> Result<i64> {
        let mut c = self.mgr.clone();
        let res: std::result::Result<Vec<String>, _> = cmd("CONFIG")
            .arg("GET")
            .arg("databases")
            .query_async(&mut c)
            .await;
        Ok(res
            .ok()
            .and_then(|v| v.get(1).and_then(|s| s.parse::<i64>().ok()))
            .unwrap_or(16))
    }

    pub async fn dbsize(&self, db: i64) -> Result<i64> {
        let mut c = self.mgr.clone();
        select(&mut c, db).await?;
        let n: i64 = cmd("DBSIZE").query_async(&mut c).await.map_err(map_err)?;
        Ok(n)
    }

    /// 增量扫描键，并为每个键带回类型与 TTL（pipeline TYPE + PTTL）。
    pub async fn scan(
        &self,
        db: i64,
        pattern: &str,
        cursor: &str,
        count: i64,
    ) -> Result<ScanPage> {
        let mut c = self.mgr.clone();
        select(&mut c, db).await?;
        let (next, keys): (String, Vec<Vec<u8>>) = cmd("SCAN")
            .arg(cursor)
            .arg("MATCH")
            .arg(pattern)
            .arg("COUNT")
            .arg(count)
            .query_async(&mut c)
            .await
            .map_err(map_err)?;

        if keys.is_empty() {
            return Ok(ScanPage { cursor: next, keys: vec![] });
        }
        let mut p = pipe();
        for k in &keys {
            p.cmd("TYPE").arg(k).cmd("PTTL").arg(k);
        }
        let metas: Vec<RValue> = p.query_async(&mut c).await.map_err(map_err)?;

        let mut out = Vec::with_capacity(keys.len());
        for (i, k) in keys.into_iter().enumerate() {
            let typ = match metas.get(i * 2) {
                Some(RValue::SimpleString(s)) => s.clone(),
                Some(RValue::BulkString(b)) => String::from_utf8_lossy(b).into_owned(),
                _ => "unknown".into(),
            };
            let ttl_ms = match metas.get(i * 2 + 1) {
                Some(RValue::Int(n)) => *n,
                _ => -1,
            };
            out.push(KeyMeta {
                name: String::from_utf8_lossy(&k).into_owned(),
                typ,
                ttl_ms,
            });
        }
        Ok(ScanPage { cursor: next, keys: out })
    }

    pub async fn key_detail(&self, db: i64, key: &str) -> Result<KeyDetail> {
        let mut c = self.mgr.clone();
        select(&mut c, db).await?;
        let typ: String = type_of(&mut c, key).await?;
        let ttl_ms: i64 = cmd("PTTL").arg(key).query_async(&mut c).await.map_err(map_err)?;
        let mem_bytes: Option<i64> = cmd("MEMORY")
            .arg("USAGE")
            .arg(key)
            .query_async(&mut c)
            .await
            .ok();
        let size = size_of_key(&mut c, &typ, key).await.unwrap_or(0);
        Ok(KeyDetail { typ, ttl_ms, mem_bytes, size })
    }

    /// 按类型读取值（分页参数按类型取用）。
    pub async fn get_value(
        &self,
        db: i64,
        key: &str,
        cursor: &str,
        count: i64,
        start: i64,
        stop: i64,
    ) -> Result<RedisValue> {
        let mut c = self.mgr.clone();
        select(&mut c, db).await?;
        let typ: String = type_of(&mut c, key).await?;
        match typ.as_str() {
            "string" => {
                let b: Option<Vec<u8>> = cmd("GET").arg(key).query_async(&mut c).await.map_err(map_err)?;
                Ok(RedisValue::String { value: to_field(b.unwrap_or_default()) })
            }
            "hash" => {
                let (next, flat): (String, Vec<Vec<u8>>) = cmd("HSCAN")
                    .arg(key)
                    .arg(cursor)
                    .arg("COUNT")
                    .arg(count)
                    .query_async(&mut c)
                    .await
                    .map_err(map_err)?;
                let total: i64 = cmd("HLEN").arg(key).query_async(&mut c).await.map_err(map_err)?;
                let mut fields = Vec::new();
                let mut it = flat.into_iter();
                while let (Some(f), Some(v)) = (it.next(), it.next()) {
                    fields.push((to_field(f), to_field(v)));
                }
                Ok(RedisValue::Hash { cursor: next, fields, total })
            }
            "list" => {
                let items: Vec<Vec<u8>> = cmd("LRANGE")
                    .arg(key)
                    .arg(start)
                    .arg(stop)
                    .query_async(&mut c)
                    .await
                    .map_err(map_err)?;
                let total: i64 = cmd("LLEN").arg(key).query_async(&mut c).await.map_err(map_err)?;
                Ok(RedisValue::List {
                    start,
                    stop,
                    items: items.into_iter().map(to_field).collect(),
                    total,
                })
            }
            "set" => {
                let (next, members): (String, Vec<Vec<u8>>) = cmd("SSCAN")
                    .arg(key)
                    .arg(cursor)
                    .arg("COUNT")
                    .arg(count)
                    .query_async(&mut c)
                    .await
                    .map_err(map_err)?;
                let total: i64 = cmd("SCARD").arg(key).query_async(&mut c).await.map_err(map_err)?;
                Ok(RedisValue::Set {
                    cursor: next,
                    members: members.into_iter().map(to_field).collect(),
                    total,
                })
            }
            "zset" => {
                let flat: Vec<Vec<u8>> = cmd("ZRANGE")
                    .arg(key)
                    .arg(start)
                    .arg(stop)
                    .arg("WITHSCORES")
                    .query_async(&mut c)
                    .await
                    .map_err(map_err)?;
                let total: i64 = cmd("ZCARD").arg(key).query_async(&mut c).await.map_err(map_err)?;
                let mut items = Vec::new();
                let mut it = flat.into_iter();
                while let (Some(m), Some(s)) = (it.next(), it.next()) {
                    let score = String::from_utf8_lossy(&s).parse::<f64>().unwrap_or(0.0);
                    items.push((to_field(m), score));
                }
                Ok(RedisValue::Zset { start, stop, items, total })
            }
            "stream" => {
                let raw: RValue = cmd("XRANGE")
                    .arg(key)
                    .arg("-")
                    .arg("+")
                    .arg("COUNT")
                    .arg(count)
                    .query_async(&mut c)
                    .await
                    .map_err(map_err)?;
                let total: i64 = cmd("XLEN").arg(key).query_async(&mut c).await.map_err(map_err)?;
                Ok(RedisValue::Stream { entries: parse_stream(raw), total })
            }
            _ => Ok(RedisValue::None),
        }
    }

    /// 导出：扫描匹配的键并连同完整值导出为 JSON（数组，每项 {key,type,ttl_ms,value}）。
    pub async fn dump(&self, db: i64, pattern: &str, max_keys: usize) -> Result<serde_json::Value> {
        let mut c = self.mgr.clone();
        select(&mut c, db).await?;
        let mut cursor = "0".to_string();
        let mut out: Vec<serde_json::Value> = Vec::new();
        loop {
            let (next, keys): (String, Vec<Vec<u8>>) = cmd("SCAN")
                .arg(&cursor)
                .arg("MATCH")
                .arg(pattern)
                .arg("COUNT")
                .arg(500)
                .query_async(&mut c)
                .await
                .map_err(map_err)?;
            for k in keys {
                if out.len() >= max_keys {
                    break;
                }
                let key = String::from_utf8_lossy(&k).into_owned();
                let typ = type_of(&mut c, &key).await?;
                let ttl: i64 = cmd("PTTL").arg(&key).query_async(&mut c).await.unwrap_or(-1);
                let value = dump_value(&mut c, &typ, &key).await?;
                out.push(serde_json::json!({"key": key, "type": typ, "ttl_ms": ttl, "value": value}));
            }
            cursor = next;
            if cursor == "0" || out.len() >= max_keys {
                break;
            }
        }
        Ok(serde_json::Value::Array(out))
    }

    /// 命令台：执行任意命令（先 SELECT db），返回原始回复。
    pub async fn command(&self, db: i64, args: &[String]) -> Result<Reply> {
        if args.is_empty() {
            return Err(AppError::Internal("empty command".into()));
        }
        let mut c = self.mgr.clone();
        select(&mut c, db).await?;
        let mut command = cmd(&args[0]);
        for a in &args[1..] {
            command.arg(a);
        }
        match command.query_async::<RValue>(&mut c).await {
            Ok(v) => Ok(to_reply(v)),
            Err(e) => Ok(Reply::Error { text: e.to_string() }),
        }
    }
}

// ---- 私有辅助 ----------------------------------------------------------------

async fn type_of(c: &mut ConnectionManager, key: &str) -> Result<String> {
    let v: RValue = cmd("TYPE").arg(key).query_async(c).await.map_err(map_err)?;
    Ok(match v {
        RValue::SimpleString(s) => s,
        RValue::BulkString(b) => String::from_utf8_lossy(&b).into_owned(),
        _ => "none".into(),
    })
}

async fn size_of_key(c: &mut ConnectionManager, typ: &str, key: &str) -> Result<i64> {
    let cmd_name = match typ {
        "string" => "STRLEN",
        "list" => "LLEN",
        "set" => "SCARD",
        "zset" => "ZCARD",
        "hash" => "HLEN",
        "stream" => "XLEN",
        _ => return Ok(0),
    };
    let n: i64 = cmd(cmd_name).arg(key).query_async(c).await.map_err(map_err)?;
    Ok(n)
}

fn field_json(b: Vec<u8>) -> serde_json::Value {
    match String::from_utf8(b) {
        Ok(s) => serde_json::Value::String(s),
        Err(e) => serde_json::json!({ "hex": to_hex(&e.into_bytes()) }),
    }
}

/// 按类型读取键的完整值并转 JSON（导出用）。
async fn dump_value(c: &mut ConnectionManager, typ: &str, key: &str) -> Result<serde_json::Value> {
    Ok(match typ {
        "string" => {
            let b: Option<Vec<u8>> = cmd("GET").arg(key).query_async(c).await.map_err(map_err)?;
            b.map(field_json).unwrap_or(serde_json::Value::Null)
        }
        "hash" => {
            let flat: Vec<Vec<u8>> = cmd("HGETALL").arg(key).query_async(c).await.map_err(map_err)?;
            let mut pairs = Vec::new();
            let mut it = flat.into_iter();
            while let (Some(f), Some(v)) = (it.next(), it.next()) {
                pairs.push(serde_json::json!([field_json(f), field_json(v)]));
            }
            serde_json::Value::Array(pairs)
        }
        "list" => {
            let items: Vec<Vec<u8>> = cmd("LRANGE").arg(key).arg(0).arg(-1).query_async(c).await.map_err(map_err)?;
            serde_json::Value::Array(items.into_iter().map(field_json).collect())
        }
        "set" => {
            let items: Vec<Vec<u8>> = cmd("SMEMBERS").arg(key).query_async(c).await.map_err(map_err)?;
            serde_json::Value::Array(items.into_iter().map(field_json).collect())
        }
        "zset" => {
            let flat: Vec<Vec<u8>> = cmd("ZRANGE").arg(key).arg(0).arg(-1).arg("WITHSCORES").query_async(c).await.map_err(map_err)?;
            let mut pairs = Vec::new();
            let mut it = flat.into_iter();
            while let (Some(m), Some(s)) = (it.next(), it.next()) {
                let score = String::from_utf8_lossy(&s).parse::<f64>().unwrap_or(0.0);
                pairs.push(serde_json::json!([field_json(m), score]));
            }
            serde_json::Value::Array(pairs)
        }
        "stream" => {
            let raw: RValue = cmd("XRANGE").arg(key).arg("-").arg("+").query_async(c).await.map_err(map_err)?;
            serde_json::to_value(parse_stream(raw)).unwrap_or(serde_json::Value::Null)
        }
        _ => serde_json::Value::Null,
    })
}

fn parse_stream(v: RValue) -> Vec<StreamEntry> {
    let RValue::Array(entries) = v else { return vec![] };
    let mut out = Vec::new();
    for e in entries {
        let RValue::Array(pair) = e else { continue };
        let mut it = pair.into_iter();
        let id = match it.next() {
            Some(RValue::BulkString(b)) => String::from_utf8_lossy(&b).into_owned(),
            Some(RValue::SimpleString(s)) => s,
            _ => continue,
        };
        let mut fields = Vec::new();
        if let Some(RValue::Array(fv)) = it.next() {
            let mut fi = fv.into_iter();
            while let (Some(f), Some(val)) = (fi.next(), fi.next()) {
                let to = |x: RValue| match x {
                    RValue::BulkString(b) => to_field(b),
                    RValue::SimpleString(s) => Field { text: s, binary: false },
                    _ => Field { text: String::new(), binary: false },
                };
                fields.push((to(f), to(val)));
            }
        }
        out.push(StreamEntry { id, fields });
    }
    out
}
