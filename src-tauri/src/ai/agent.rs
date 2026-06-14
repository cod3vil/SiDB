//! Agent 工具循环（TDD §7）。一次用户输入 → 多轮「模型 ↔ 工具」直到模型给出文本回答。
//! provider 只做单次往返；循环、工具执行、提案收集都在这里，并对每次工具调用落审计。

use crate::ai::proposals::ProposalStore;
use crate::ai::provider::{AiProvider, ChatRequest, ContentBlock, Msg};
use crate::ai::tools::{self, ToolCtx, ToolStep};
use crate::models::AppError;
use crate::services::connection::ConnectionManager;

/// 最大工具往返轮数（防失控）。
const MAX_ITERS: usize = 8;
const MAX_TOKENS: u32 = 4096;

/// 一条提案 DTO（回前端渲染确认卡片）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProposalDto {
    pub id: String,
    pub sql: String,
}

/// 一轮对话结果。
#[derive(Debug, Clone, serde::Serialize)]
pub struct TurnResult {
    pub reply: String,
    pub steps: Vec<ToolStep>,
    pub proposals: Vec<ProposalDto>,
}

/// 运行一轮：history 为既往「用户/助手」纯文本消息，user_msg 为本次输入。
#[allow(clippy::too_many_arguments)]
pub async fn run_turn(
    provider: &dyn AiProvider,
    conns: &ConnectionManager,
    proposals: &ProposalStore,
    conn_id: &str,
    ctx: ToolCtx,
    history: Vec<Msg>,
    user_msg: String,
) -> Result<TurnResult, AppError> {
    let mut brief = crate::ai::context::schema_brief(
        conns,
        conn_id,
        ctx.database.as_deref(),
        ctx.schema.as_deref(),
    )
    .await;
    // 选中了表：把该表的列也注入上下文，模型无需再遍历其它表的结构。
    if let Some(tbl) = ctx.table.as_deref().filter(|t| !t.is_empty()) {
        let t = crate::models::TableRef {
            database: ctx.database.clone(),
            schema: ctx.schema.clone(),
            name: tbl.to_string(),
        };
        let cols = crate::ai::context::table_columns_brief(conns, conn_id, &t).await;
        if !cols.is_empty() {
            brief = if brief.is_empty() {
                cols
            } else {
                format!("{cols}\n{brief}")
            };
        }
    }
    let system = build_system(
        &brief,
        ctx.database.as_deref(),
        ctx.schema.as_deref(),
        ctx.table.as_deref(),
    );
    let tool_defs = tools::tool_defs();

    let mut messages = history;
    messages.push(Msg::user_text(user_msg));

    let mut steps: Vec<ToolStep> = Vec::new();
    let mut out_proposals: Vec<ProposalDto> = Vec::new();

    for _ in 0..MAX_ITERS {
        let resp = provider
            .chat(ChatRequest {
                system: system.clone(),
                messages: messages.clone(),
                tools: tool_defs.clone(),
                max_tokens: MAX_TOKENS,
            })
            .await?;

        // 把助手回合（含 tool_use）原样追加，保持对话连贯。
        messages.push(Msg {
            role: "assistant".into(),
            content: resp.content.clone(),
        });

        let calls = resp.tool_uses();
        if calls.is_empty() {
            return Ok(TurnResult {
                reply: resp.text(),
                steps,
                proposals: out_proposals,
            });
        }

        // 逐个执行工具，结果作为一条 user 消息（多个 tool_result 块）回灌。
        let mut results: Vec<ContentBlock> = Vec::new();
        for (id, name, input) in calls {
            let outcome = tools::execute(conns, proposals, conn_id, &ctx, name, input).await;
            steps.push(outcome.step);
            if let Some((pid, sql)) = outcome.proposal {
                out_proposals.push(ProposalDto { id: pid, sql });
            }
            results.push(ContentBlock::ToolResult {
                tool_use_id: id.to_string(),
                content: outcome.content,
                is_error: outcome.is_error,
            });
        }
        messages.push(Msg {
            role: "user".into(),
            content: results,
        });
    }

    // 轮数用尽仍未收敛：返回已有步骤 + 提示。
    Ok(TurnResult {
        reply: "（已达到工具调用上限，请缩小问题范围或重试）".into(),
        steps,
        proposals: out_proposals,
    })
}

fn build_system(
    brief: &str,
    database: Option<&str>,
    schema: Option<&str>,
    table: Option<&str>,
) -> String {
    let mut s = String::from(
        "你是内嵌在数据库客户端里的中文 AI 助手。你可以使用工具探查并查询当前连接的数据库。\n\
        规则：\n\
        - 需要表/列信息时，先用 list_tables / get_schema，不要凭空猜测表名或列名。\n\
        - 默认在「当前数据库」下操作；用户没要求时不要去查别的库或 SHOW DATABASES。\n\
        - 只读查询（SELECT/WITH/SHOW/EXPLAIN）一律用 run_read_query；服务端会强制单语句、只读、LIMIT 1000、30s 超时。\n\
        - 任何写操作或 DDL（INSERT/UPDATE/DELETE/CREATE/ALTER/DROP 等）只能用 propose_write 产出提案，由用户在界面确认后才执行。绝不要声称写操作已完成。\n\
        - 回答简洁、用中文；给出 SQL 时用 ```sql 代码块。",
    );
    if let Some(db) = database.filter(|d| !d.is_empty()) {
        s.push_str(&format!("\n\n当前数据库：{db}"));
        if let Some(sc) = schema.filter(|x| !x.is_empty()) {
            s.push_str(&format!("（schema：{sc}）"));
        }
        s.push('。');
    }
    if let Some(tbl) = table.filter(|t| !t.is_empty()) {
        s.push_str(&format!(
            "\n用户当前选中的表是 `{tbl}`。除非用户在提问里明确点名了其它表，否则只在 `{tbl}` 这一张表上查询/操作，\
            不要去 list_tables 或遍历、猜测其它表的结构。"
        ));
    }
    if !brief.is_empty() {
        s.push('\n');
        s.push_str(brief);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::provider::{ChatResponse, ContentBlock};
    use async_trait::async_trait;
    use std::sync::Mutex;

    /// 脚本化假 provider：按预设序列逐轮返回。
    struct ScriptedProvider {
        steps: Mutex<std::collections::VecDeque<ChatResponse>>,
    }

    #[async_trait]
    impl AiProvider for ScriptedProvider {
        async fn chat(&self, _req: ChatRequest) -> Result<ChatResponse, AppError> {
            Ok(self
                .steps
                .lock()
                .unwrap()
                .pop_front()
                .expect("scripted step"))
        }
        async fn test(&self) -> Result<(), AppError> {
            Ok(())
        }
    }

    #[tokio::test]
    async fn loops_through_tool_then_text() {
        // 第 1 轮：模型请求 propose_write；第 2 轮：返回纯文本。
        let mut q = std::collections::VecDeque::new();
        q.push_back(ChatResponse {
            content: vec![ContentBlock::ToolUse {
                id: "tu_1".into(),
                name: "propose_write".into(),
                input: serde_json::json!({ "sql": "ALTER TABLE t ADD COLUMN x INT" }),
            }],
            stop_reason: "tool_use".into(),
        });
        q.push_back(ChatResponse {
            content: vec![ContentBlock::Text {
                text: "已生成提案，请确认。".into(),
            }],
            stop_reason: "end_turn".into(),
        });
        let provider = ScriptedProvider {
            steps: Mutex::new(q),
        };
        let conns = ConnectionManager::new();
        let proposals = ProposalStore::new();

        let r = run_turn(
            &provider,
            &conns,
            &proposals,
            "c1",
            ToolCtx::default(),
            vec![],
            "给 t 表加一列 x".into(),
        )
        .await
        .unwrap();

        assert_eq!(r.reply, "已生成提案，请确认。");
        assert_eq!(r.steps.len(), 1);
        assert_eq!(r.steps[0].tool, "propose_write");
        assert_eq!(r.proposals.len(), 1);
        // 提案可被取出执行。
        let p = proposals.take(&r.proposals[0].id).expect("proposal stored");
        assert!(p.sql.contains("ADD COLUMN x"));
    }
}
