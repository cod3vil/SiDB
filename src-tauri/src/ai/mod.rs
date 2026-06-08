//! AI 模块骨架（TDD §7，一期交付接口 + 最小实现）。
//!
//! 安全红线（写进代码而非文档）：
//! - AI 只能通过受控工具访问 services，不接触 adapter / 连接池。
//! - 写操作只产出 proposal，执行必须经 `ai_confirm_write`。
//! - `RunReadQuery` 在 service 层做只读校验 + 强制 LIMIT + 超时。
//! - 所有工具调用写入审计日志。

pub mod audit;
pub mod context;
pub mod provider;
pub mod tools;

pub use provider::{AiProvider, ChatRequest, ChatResponse, Msg, ToolDef};
pub use tools::DbTool;
