//! 服务层（TDD §6）。
//!
//! services 只通过 `DbAdapter` trait 访问数据库，不感知方言差异；不在本层 unwrap/expect。

pub mod connection;
pub mod credential;
pub mod dml;
pub mod edit;
pub mod export;
pub mod metadata;
pub mod query;
pub mod settings;

pub use connection::ConnectionManager;
pub use credential::CredentialService;
pub use edit::EditService;
pub use query::QueryService;
