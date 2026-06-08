//! AI Provider 抽象（TDD §7）。一期实现 `test()`（最小连通），其余返回未实现。

use crate::models::AppError;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Msg {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub messages: Vec<Msg>,
    pub tools: Vec<ToolDef>,
    pub max_tokens: u32,
}

#[derive(Debug, Clone)]
pub struct ChatResponse {
    pub text: String,
}

#[async_trait]
pub trait AiProvider: Send + Sync {
    async fn chat(&self, req: ChatRequest) -> Result<ChatResponse, AppError>;
    /// 设置页"测试连通"。
    async fn test(&self) -> Result<(), AppError>;
}

/// Anthropic provider（一期仅 `test()`）。
pub struct AnthropicProvider {
    pub api_key: String,
    pub model: String,
}

#[async_trait]
impl AiProvider for AnthropicProvider {
    async fn chat(&self, _req: ChatRequest) -> Result<ChatResponse, AppError> {
        Err(AppError::Internal("not implemented (phase 2)".into()))
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

/// OpenAI 兼容 provider（一期仅 `test()`）。
pub struct OpenAiCompatProvider {
    pub api_key: String,
    pub model: String,
    pub base_url: String,
}

#[async_trait]
impl AiProvider for OpenAiCompatProvider {
    async fn chat(&self, _req: ChatRequest) -> Result<ChatResponse, AppError> {
        Err(AppError::Internal("not implemented (phase 2)".into()))
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
