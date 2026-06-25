//! 适配器层（TDD §4）。
//!
//! **数据库方言差异（系统表查询、引号、占位符、类型映射）只允许存在于本模块内部。**
//! services 与前端不得出现任何 `if mysql/pg/sqlite` 分支，差异统一经 [`DbCapabilities`] 表达。

pub mod mysql;
pub mod postgres;
pub mod sqlite;
pub mod type_map;

use crate::models::*;
use async_trait::async_trait;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct DbCapabilities {
    pub supports_ssh: bool,
    pub supports_cancel: bool,
    /// PG true。
    pub supports_schemas: bool,
    /// SQLite false。
    pub supports_multi_database: bool,
    /// 会话内可切换当前数据库（MySQL `USE db`）。PG 单库连接、SQLite 单文件，均为 false。
    pub supports_use_database: bool,
    pub param_style: ParamStyle,
    /// `` ` `` 或 `"`
    pub quote_char: char,
    /// SQLite true。
    pub has_rowid_fallback: bool,
}

impl DbCapabilities {
    /// 标识符引号化：来源必须是元数据（非前端拼接），并拒绝包含引号字符的标识符
    /// （CLAUDE.md 铁律 #3、TDD §6.3）。
    pub fn quote_ident(&self, ident: &str) -> Result<String> {
        if ident.contains(self.quote_char) || ident.contains('\0') {
            return Err(AppError::Internal(format!(
                "illegal identifier contains quote char: {ident}"
            )));
        }
        Ok(format!("{0}{1}{0}", self.quote_char, ident))
    }

    /// 引号化带 schema 的表名，如 `"public"."t"` 或 `` `db`.`t` ``。
    pub fn quote_table(&self, t: &TableRef) -> Result<String> {
        let mut parts = Vec::new();
        if self.supports_schemas {
            if let Some(s) = &t.schema {
                parts.push(self.quote_ident(s)?);
            }
        } else if self.supports_multi_database {
            if let Some(db) = &t.database {
                parts.push(self.quote_ident(db)?);
            }
        }
        parts.push(self.quote_ident(&t.name)?);
        Ok(parts.join("."))
    }
}

#[async_trait]
pub trait DbAdapter: Send + Sync {
    fn capabilities(&self) -> &DbCapabilities;

    /// 本方言生成 SQL 字面量（导出 INSERT）的规则。
    fn sql_dialect(&self) -> SqlDialect;

    async fn connect(&mut self, target: &ConnTarget) -> Result<()>;
    async fn disconnect(&mut self);
    async fn ping(&self) -> Result<()>;

    /// 查询：`query_id` 用于取消登记。
    async fn query(&self, query_id: &str, sql: &str, params: &[Value]) -> Result<RawResultSet>;
    async fn execute(&self, query_id: &str, sql: &str, params: &[Value]) -> Result<ExecResult>;
    async fn cancel(&self, query_id: &str) -> Result<()>;

    /// 切换后续语句所在的数据库（仅 `supports_use_database` 的方言，如 MySQL）。
    /// 默认无操作（PG/SQLite）。`None`/空串表示沿用连接默认库。
    async fn use_database(&mut self, _db: Option<String>) -> Result<()> {
        Ok(())
    }

    /// 事务化批量执行（数据编辑提交用）。任一失败全部回滚。
    async fn execute_in_transaction(
        &self,
        stmts: Vec<(String, Vec<Value>)>,
    ) -> Result<Vec<ExecResult>>;

    // ---- 元数据 ----
    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>>;
    /// 非 PG 返回空。
    async fn list_schemas(&self, db: &str) -> Result<Vec<String>>;
    async fn list_tables(&self, db: &str, schema: Option<&str>) -> Result<Vec<TableInfo>>;
    /// 函数 / 存储过程。无该概念的方言（SQLite）返回空。
    async fn list_functions(&self, _db: &str, _schema: Option<&str>) -> Result<Vec<RoutineInfo>> {
        Ok(Vec::new())
    }
    async fn table_schema(&self, t: &TableRef) -> Result<TableSchema>;
    async fn table_ddl(&self, t: &TableRef) -> Result<String>;
    /// 函数 / 存储过程定义（源码 / DDL）。无该概念或未实现的方言默认报错。
    async fn function_ddl(&self, _r: &RoutineRef) -> Result<String> {
        Err(AppError::NotEditable(
            "function definition not supported for this database".into(),
        ))
    }
    /// 创建函数 / 存储过程。`definition` 是完整的 CREATE 语句（可能含 `BEGIN…END` 等
    /// 内部分号，整体执行不得切分；MySQL 预处理协议不支持此类 DDL，须走简单查询协议）。
    /// 无该概念的方言默认报错。
    async fn create_function(&self, _definition: &str) -> Result<()> {
        Err(AppError::NotEditable(
            "function creation not supported for this database".into(),
        ))
    }
    /// 替换（更新）已存在的函数 / 存储过程。`definition` 是完整的 CREATE 语句
    /// （[`function_ddl`](Self::function_ddl) 的输出，可能含内部分号，整体执行不得切分）。
    /// PG 经 `CREATE OR REPLACE` 原地更新；MySQL 等无该语法的方言先删后建。
    async fn replace_function(&self, _r: &RoutineRef, _definition: &str) -> Result<()> {
        Err(AppError::NotEditable(
            "function update not supported for this database".into(),
        ))
    }
    /// 行定位列：主键 → 唯一非空索引 → rowid（仅 SQLite）→ None。
    async fn row_identifier(&self, t: &TableRef) -> Result<Option<Vec<String>>>;
}

/// 工厂（TDD §4.1）。
pub fn create_adapter(kind: DbKind) -> Box<dyn DbAdapter> {
    match kind {
        DbKind::Mysql => Box::new(mysql::MySqlAdapter::new()),
        DbKind::Postgres => Box::new(postgres::PostgresAdapter::new()),
        DbKind::Sqlite => Box::new(sqlite::SqliteAdapter::new()),
        // Redis 不是 SQL adapter；连接路由在 ConnectionManager 层分叉，绝不会走到这里。
        DbKind::Redis => unreachable!("redis uses RedisAdapter, not create_adapter"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pg_caps() -> DbCapabilities {
        DbCapabilities {
            supports_ssh: true,
            supports_cancel: true,
            supports_schemas: true,
            supports_multi_database: true,
            supports_use_database: false,
            param_style: ParamStyle::Dollar,
            quote_char: '"',
            has_rowid_fallback: false,
        }
    }

    fn mysql_caps() -> DbCapabilities {
        DbCapabilities {
            supports_ssh: true,
            supports_cancel: true,
            supports_schemas: false,
            supports_multi_database: true,
            supports_use_database: true,
            param_style: ParamStyle::Question,
            quote_char: '`',
            has_rowid_fallback: false,
        }
    }

    #[test]
    fn quote_ident_wraps() {
        assert_eq!(pg_caps().quote_ident("col").unwrap(), r#""col""#);
        assert_eq!(mysql_caps().quote_ident("col").unwrap(), "`col`");
    }

    #[test]
    fn quote_ident_rejects_embedded_quote() {
        assert!(pg_caps().quote_ident(r#"a"b"#).is_err());
        assert!(mysql_caps().quote_ident("a`b").is_err());
    }

    #[test]
    fn quote_table_pg_uses_schema() {
        let t = TableRef {
            database: Some("d".into()),
            schema: Some("public".into()),
            name: "users".into(),
        };
        assert_eq!(pg_caps().quote_table(&t).unwrap(), r#""public"."users""#);
    }

    #[test]
    fn quote_table_mysql_uses_database() {
        let t = TableRef {
            database: Some("shop".into()),
            schema: None,
            name: "orders".into(),
        };
        assert_eq!(mysql_caps().quote_table(&t).unwrap(), "`shop`.`orders`");
    }
}
