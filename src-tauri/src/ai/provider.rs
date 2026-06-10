//! AI Provider 抽象（TDD §7）。
//! `test()` 最小连通；`chat()` 单次往返（消息+工具 → 文本/工具调用），多轮循环由 `agent.rs` 驱动。

use crate::models::AppError;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// 一段消息内容块。serde 形态对齐 Anthropic Messages API 的 content block。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
        #[serde(default)]
        is_error: bool,
    },
}

/// 一轮消息（role + 内容块）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Msg {
    pub role: String,
    pub content: Vec<ContentBlock>,
}

impl Msg {
    pub fn user_text(text: impl Into<String>) -> Self {
        Self {
            role: "user".into(),
            content: vec![ContentBlock::Text { text: text.into() }],
        }
    }
    pub fn assistant_text(text: impl Into<String>) -> Self {
        Self {
            role: "assistant".into(),
            content: vec![ContentBlock::Text { text: text.into() }],
        }
    }
}

/// 工具定义（对齐 Anthropic tools 字段）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub system: String,
    pub messages: Vec<Msg>,
    pub tools: Vec<ToolDef>,
    pub max_tokens: u32,
}

/// 助手单次回复：内容块（文本 + 可能的 tool_use）+ 停止原因。
#[derive(Debug, Clone)]
pub struct ChatResponse {
    pub content: Vec<ContentBlock>,
    pub stop_reason: String,
}

impl ChatResponse {
    /// 拼接所有文本块。
    pub fn text(&self) -> String {
        self.content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
    /// 提取 tool_use 块。
    pub fn tool_uses(&self) -> Vec<(&str, &str, &serde_json::Value)> {
        self.content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::ToolUse { id, name, input } => {
                    Some((id.as_str(), name.as_str(), input))
                }
                _ => None,
            })
            .collect()
    }
}

#[async_trait]
pub trait AiProvider: Send + Sync {
    async fn chat(&self, req: ChatRequest) -> Result<ChatResponse, AppError>;
    /// 设置页"测试连通"。
    async fn test(&self) -> Result<(), AppError>;
}

/// Anthropic provider。
pub struct AnthropicProvider {
    pub api_key: String,
    pub model: String,
}

#[async_trait]
impl AiProvider for AnthropicProvider {
    async fn chat(&self, req: ChatRequest) -> Result<ChatResponse, AppError> {
        let mut body = serde_json::json!({
            "model": self.model,
            "max_tokens": req.max_tokens,
            "messages": req.messages,
        });
        if !req.system.is_empty() {
            body["system"] = serde_json::Value::String(req.system);
        }
        if !req.tools.is_empty() {
            body["tools"] = serde_json::to_value(&req.tools)
                .map_err(|e| AppError::Internal(e.to_string()))?;
        }
        let resp = reqwest::Client::new()
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Network(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(api_error(resp).await);
        }
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Network(e.to_string()))?;
        let content: Vec<ContentBlock> = serde_json::from_value(json["content"].clone())
            .map_err(|e| AppError::Internal(format!("decode content: {e}")))?;
        let stop_reason = json["stop_reason"].as_str().unwrap_or("end_turn").to_string();
        Ok(ChatResponse { content, stop_reason })
    }

    async fn test(&self) -> Result<(), AppError> {
        let body = serde_json::json!({
            "model": self.model,
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "ping"}]
        });
        let resp = reqwest::Client::new()
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Network(e.to_string()))?;
        if resp.status().is_success() {
            Ok(())
        } else if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            Err(AppError::AuthFailed("invalid api key".into()))
        } else {
            Err(AppError::Network(format!("status {}", resp.status())))
        }
    }
}

/// OpenAI 兼容 provider（OpenAI / DeepSeek / 自建网关等）。chat() 走 function-calling。
pub struct OpenAiCompatProvider {
    pub api_key: String,
    pub model: String,
    pub base_url: String,
}

#[async_trait]
impl AiProvider for OpenAiCompatProvider {
    async fn chat(&self, req: ChatRequest) -> Result<ChatResponse, AppError> {
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));

        // 把内部消息模型映射成 OpenAI messages（system 进数组、tool_use→tool_calls、tool_result→role:tool）。
        let mut messages: Vec<serde_json::Value> = Vec::new();
        if !req.system.is_empty() {
            messages.push(serde_json::json!({"role": "system", "content": req.system}));
        }
        for m in &req.messages {
            push_openai_messages(&mut messages, m);
        }

        let tools: Vec<serde_json::Value> = req
            .tools
            .iter()
            .map(|t| {
                serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    }
                })
            })
            .collect();

        let mut body = serde_json::json!({
            "model": self.model,
            "max_tokens": req.max_tokens,
            "messages": messages,
        });
        if !tools.is_empty() {
            body["tools"] = serde_json::Value::Array(tools);
        }

        let resp = reqwest::Client::new()
            .post(url)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Network(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(api_error(resp).await);
        }
        let json: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| AppError::Network(e.to_string()))?;
        let choice = &json["choices"][0];
        let msg = &choice["message"];

        let mut content = Vec::new();
        if let Some(text) = msg["content"].as_str() {
            if !text.is_empty() {
                content.push(ContentBlock::Text { text: text.to_string() });
            }
        }
        if let Some(calls) = msg["tool_calls"].as_array() {
            for c in calls {
                let args = c["function"]["arguments"].as_str().unwrap_or("{}");
                content.push(ContentBlock::ToolUse {
                    id: c["id"].as_str().unwrap_or_default().to_string(),
                    name: c["function"]["name"].as_str().unwrap_or_default().to_string(),
                    input: serde_json::from_str(args).unwrap_or_else(|_| serde_json::json!({})),
                });
            }
        }
        let stop_reason = choice["finish_reason"].as_str().unwrap_or("stop").to_string();
        Ok(ChatResponse { content, stop_reason })
    }

    async fn test(&self) -> Result<(), AppError> {
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let body = serde_json::json!({
            "model": self.model,
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "ping"}]
        });
        let resp = reqwest::Client::new()
            .post(url)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|e| AppError::Network(e.to_string()))?;
        if resp.status().is_success() {
            Ok(())
        } else if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            Err(AppError::AuthFailed("invalid api key".into()))
        } else {
            Err(AppError::Network(format!("status {}", resp.status())))
        }
    }
}

/// 把一条内部消息追加为若干条 OpenAI 消息：
/// - assistant：文本 + tool_calls 合并成一条 `{role:assistant, content, tool_calls}`。
/// - user：文本一条 `{role:user}`；每个 tool_result 一条 `{role:tool, tool_call_id, content}`。
fn push_openai_messages(out: &mut Vec<serde_json::Value>, m: &Msg) {
    let mut text = String::new();
    let mut tool_calls: Vec<serde_json::Value> = Vec::new();
    let mut tool_results: Vec<(String, String)> = Vec::new();
    for b in &m.content {
        match b {
            ContentBlock::Text { text: t } => {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(t);
            }
            ContentBlock::ToolUse { id, name, input } => tool_calls.push(serde_json::json!({
                "id": id,
                "type": "function",
                "function": { "name": name, "arguments": input.to_string() },
            })),
            ContentBlock::ToolResult { tool_use_id, content, .. } => {
                tool_results.push((tool_use_id.clone(), content.clone()))
            }
        }
    }

    if m.role == "assistant" {
        let mut msg = serde_json::json!({ "role": "assistant" });
        msg["content"] = if text.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::Value::String(text)
        };
        if !tool_calls.is_empty() {
            msg["tool_calls"] = serde_json::Value::Array(tool_calls);
        }
        out.push(msg);
    } else {
        if !text.is_empty() {
            out.push(serde_json::json!({ "role": "user", "content": text }));
        }
        for (id, content) in tool_results {
            out.push(serde_json::json!({ "role": "tool", "tool_call_id": id, "content": content }));
        }
    }
}

/// 把失败响应映射成 AppError（带 body 片段便于排查）。
async fn api_error(resp: reqwest::Response) -> AppError {
    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return AppError::AuthFailed("invalid api key".into());
    }
    let body = resp.text().await.unwrap_or_default();
    let snippet: String = body.chars().take(300).collect();
    AppError::Network(format!("status {status}: {snippet}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真实打 DeepSeek（OpenAI 兼容）验证两跳工具对话映射。
    /// 仅在设置了 `DEEPSEEK_KEY` 时跑：
    /// `DEEPSEEK_KEY=sk-... cargo test --manifest-path src-tauri/Cargo.toml -- --ignored --nocapture deepseek`
    #[tokio::test]
    #[ignore]
    async fn deepseek_tool_roundtrip() {
        let Ok(key) = std::env::var("DEEPSEEK_KEY") else {
            eprintln!("DEEPSEEK_KEY not set; skipping");
            return;
        };
        let p = OpenAiCompatProvider {
            api_key: key,
            model: "deepseek-v4-flash".into(),
            base_url: "https://api.deepseek.com".into(),
        };
        let tools = vec![ToolDef {
            name: "list_tables".into(),
            description: "List tables in a database".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {"database": {"type": "string"}},
                "required": ["database"]
            }),
        }];

        // 第一跳：期望模型请求 tool_use。
        let r1 = p
            .chat(ChatRequest {
                system: "你必须调用 list_tables 工具来回答，不要直接问用户。".into(),
                messages: vec![Msg::user_text("列出 app 库里的表")],
                tools: tools.clone(),
                max_tokens: 256,
            })
            .await
            .expect("chat 1");
        let calls = r1.tool_uses();
        assert!(!calls.is_empty(), "expected tool_use, got {:?}", r1.content);
        let (id, name, _) = calls[0];
        assert_eq!(name, "list_tables");
        println!("HOP1 requested tool: {name}");

        // 第二跳：回灌 tool_result，期望最终文本（验证 tool_result→role:tool 映射被接受）。
        let convo = vec![
            Msg::user_text("列出 app 库里的表"),
            Msg { role: "assistant".into(), content: r1.content.clone() },
            Msg {
                role: "user".into(),
                content: vec![ContentBlock::ToolResult {
                    tool_use_id: id.to_string(),
                    content: "{\"tables\":[\"users\",\"orders\",\"products\"]}".into(),
                    is_error: false,
                }],
            },
        ];
        let r2 = p
            .chat(ChatRequest { system: String::new(), messages: convo, tools, max_tokens: 256 })
            .await
            .expect("chat 2");
        assert!(!r2.text().is_empty(), "expected final text, got {:?}", r2.content);
        println!("HOP2 final reply: {}", r2.text());
    }
}
