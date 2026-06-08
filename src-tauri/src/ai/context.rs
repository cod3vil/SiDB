//! Schema 上下文构建器（TDD §7，二期核心，一期留接口 + 空实现）。

#[derive(Debug, Clone)]
pub enum ContextScope {
    Database(String),
    Tables(Vec<String>),
}

pub trait SchemaContextBuilder {
    fn build(&self, conn_id: &str, scope: ContextScope, budget_tokens: usize) -> String;
}

/// 一期空实现：返回占位提示。
pub struct NoopContextBuilder;

impl SchemaContextBuilder for NoopContextBuilder {
    fn build(&self, _conn_id: &str, _scope: ContextScope, _budget_tokens: usize) -> String {
        String::new()
    }
}
