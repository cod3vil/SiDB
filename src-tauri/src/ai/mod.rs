//! AI 模块（TDD §7）。
//!
//! 安全红线（写进代码而非文档）：
//! - AI 只能通过受控工具访问 services，不接触 adapter / 连接池裸接口。
//! - 写操作只产出 proposal，执行必须经 `ai_confirm_write`。
//! - `run_read_query` 在工具层做只读校验 + 强制 LIMIT + 超时。
//! - 所有工具调用写入审计日志。

pub mod agent;
pub mod audit;
pub mod context;
pub mod proposals;
pub mod provider;
pub mod tools;

pub use provider::{
    AiProvider, AnthropicProvider, ChatRequest, ChatResponse, Msg, OpenAiCompatProvider, ToolDef,
};
