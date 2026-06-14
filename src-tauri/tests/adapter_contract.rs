//! 适配器契约测试套件（TDD §11 / T1.1）。
//!
//! 同一套行为测试可跑三个适配器：SQLite 用临时文件（默认运行）；
//! MySQL / PG 标记 `#[ignore]`，仅在本地有 Docker（testcontainers）时运行。
//!
//! 统一建表（CLAUDE.md 测试数据约定）：`t_pk` / `t_no_pk` / `t_unique_nn`。

use sidb_lib::adapters::{create_adapter, DbAdapter};
use sidb_lib::models::*;

async fn sqlite_adapter() -> (Box<dyn DbAdapter>, tempfile::NamedTempFile) {
    let file = tempfile::Builder::new().suffix(".db").tempfile().unwrap();
    let path = file.path().to_string_lossy().to_string();
    let mut a = create_adapter(DbKind::Sqlite);
    let target = ConnTarget {
        kind: DbKind::Sqlite,
        host: String::new(),
        port: 0,
        user: String::new(),
        password: None,
        database: None,
        schema: None,
        ssl_mode: SslMode::Disable,
        connect_timeout_secs: 5,
        sqlite_path: Some(path),
    };
    a.connect(&target).await.unwrap();
    (a, file)
}

fn tref(name: &str) -> TableRef {
    TableRef { database: None, schema: None, name: name.into() }
}

async fn setup_tables(a: &dyn DbAdapter) {
    let qid = "setup";
    a.execute(qid, "CREATE TABLE t_pk (id INTEGER PRIMARY KEY, name TEXT NOT NULL)", &[])
        .await
        .unwrap();
    a.execute(qid, "CREATE TABLE t_no_pk (a INTEGER, b TEXT)", &[])
        .await
        .unwrap();
    a.execute(
        qid,
        "CREATE TABLE t_unique_nn (code TEXT NOT NULL UNIQUE, val INTEGER)",
        &[],
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn ping_works() {
    let (a, _f) = sqlite_adapter().await;
    a.ping().await.unwrap();
}

#[tokio::test]
async fn capabilities_reflect_sqlite() {
    let (a, _f) = sqlite_adapter().await;
    let caps = a.capabilities();
    assert!(!caps.supports_ssh);
    assert!(!caps.supports_schemas);
    assert!(!caps.supports_multi_database);
    assert!(caps.has_rowid_fallback);
    assert_eq!(caps.quote_char, '"');
}

#[tokio::test]
async fn insert_query_roundtrip() {
    let (a, _f) = sqlite_adapter().await;
    setup_tables(&*a).await;

    let res = a
        .execute(
            "q",
            "INSERT INTO t_pk (id, name) VALUES (?, ?)",
            &[Value::Int(1), Value::Text("alice".into())],
        )
        .await
        .unwrap();
    assert_eq!(res.affected_rows, 1);

    let rows = a.query("q", "SELECT id, name FROM t_pk", &[]).await.unwrap();
    assert_eq!(rows.rows.len(), 1);
    assert_eq!(rows.rows[0][0], Value::Int(1));
    assert_eq!(rows.rows[0][1], Value::Text("alice".into()));
}

#[tokio::test]
async fn null_distinct_from_empty_string() {
    let (a, _f) = sqlite_adapter().await;
    setup_tables(&*a).await;
    a.execute("q", "INSERT INTO t_no_pk (a, b) VALUES (?, ?)", &[Value::Null, Value::Text("".into())])
        .await
        .unwrap();
    let rows = a.query("q", "SELECT a, b FROM t_no_pk", &[]).await.unwrap();
    assert_eq!(rows.rows[0][0], Value::Null);
    assert_eq!(rows.rows[0][1], Value::Text("".into()));
}

#[tokio::test]
async fn row_identifier_primary_key() {
    let (a, _f) = sqlite_adapter().await;
    setup_tables(&*a).await;
    let id = a.row_identifier(&tref("t_pk")).await.unwrap();
    assert_eq!(id, Some(vec!["id".to_string()]));
}

#[tokio::test]
async fn row_identifier_unique_not_null() {
    let (a, _f) = sqlite_adapter().await;
    setup_tables(&*a).await;
    let id = a.row_identifier(&tref("t_unique_nn")).await.unwrap();
    assert_eq!(id, Some(vec!["code".to_string()]));
}

#[tokio::test]
async fn row_identifier_rowid_fallback() {
    let (a, _f) = sqlite_adapter().await;
    setup_tables(&*a).await;
    // 无主键/唯一非空 → 回退 rowid
    let id = a.row_identifier(&tref("t_no_pk")).await.unwrap();
    assert_eq!(id, Some(vec!["rowid".to_string()]));
}

#[tokio::test]
async fn list_tables_and_ddl() {
    let (a, _f) = sqlite_adapter().await;
    setup_tables(&*a).await;
    let tables = a.list_tables("main", None).await.unwrap();
    let names: Vec<&str> = tables.iter().map(|t| t.name.as_str()).collect();
    assert!(names.contains(&"t_pk"));
    let ddl = a.table_ddl(&tref("t_pk")).await.unwrap();
    assert!(ddl.to_uppercase().contains("CREATE TABLE"));
}

#[tokio::test]
async fn transaction_commits_all_or_nothing() {
    let (a, _f) = sqlite_adapter().await;
    setup_tables(&*a).await;
    let stmts = vec![
        ("INSERT INTO t_pk (id, name) VALUES (?, ?)".to_string(), vec![Value::Int(1), Value::Text("a".into())]),
        ("INSERT INTO t_pk (id, name) VALUES (?, ?)".to_string(), vec![Value::Int(2), Value::Text("b".into())]),
    ];
    let res = a.execute_in_transaction(stmts).await.unwrap();
    assert_eq!(res.len(), 2);
    let rows = a.query("q", "SELECT COUNT(*) FROM t_pk", &[]).await.unwrap();
    assert_eq!(rows.rows[0][0], Value::Int(2));
}

#[tokio::test]
async fn transaction_rolls_back_on_error() {
    let (a, _f) = sqlite_adapter().await;
    setup_tables(&*a).await;
    let stmts = vec![
        ("INSERT INTO t_pk (id, name) VALUES (?, ?)".to_string(), vec![Value::Int(1), Value::Text("a".into())]),
        // 主键冲突 → 整个事务回滚
        ("INSERT INTO t_pk (id, name) VALUES (?, ?)".to_string(), vec![Value::Int(1), Value::Text("dup".into())]),
    ];
    let err = a.execute_in_transaction(stmts).await;
    assert!(err.is_err());
    let rows = a.query("q", "SELECT COUNT(*) FROM t_pk", &[]).await.unwrap();
    assert_eq!(rows.rows[0][0], Value::Int(0), "事务应整体回滚");
}
