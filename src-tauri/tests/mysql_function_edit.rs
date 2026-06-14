//! MySQL 函数「查看定义 → 编辑 → 保存」真实验证（手动跑，需本地 MySQL）。
//!
//! 走的是应用真实代码路径：`MySqlAdapter::function_ddl` + `replace_function`。
//! 重点验证：函数体含 `BEGIN … END`（内部分号）时，DROP+CREATE 整体执行不被切分。
//!
//! 注：MySQL 的预处理协议无法 CREATE/DROP FUNCTION（"not supported in the prepared
//! statement protocol"），故 routine DDL 必须走简单查询协议——这正是 `replace_function`
//! 的实现要点。本测试的 setup/teardown 也用原生简单查询协议完成，避开该限制。
//!
//! 运行（标记 ignore，普通 `cargo test` 不触发）：
//!   MYSQL_TEST_PWD=你的密码 MYSQL_TEST_DB=sidb_test \
//!   cargo test --manifest-path src-tauri/Cargo.toml --test mysql_function_edit \
//!     -- --ignored --nocapture

use sidb_lib::adapters::{create_adapter, DbAdapter};
use sidb_lib::models::*;
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlSslMode};
use sqlx::{Executor, MySqlPool};

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

const FN_NAME: &str = "sidb_verify_add_one";

fn host() -> String {
    env_or("MYSQL_TEST_HOST", "127.0.0.1")
}
fn port() -> u16 {
    env_or("MYSQL_TEST_PORT", "3306").parse().unwrap()
}
fn user() -> String {
    env_or("MYSQL_TEST_USER", "root")
}
fn pwd() -> String {
    env_or("MYSQL_TEST_PWD", "")
}
fn db() -> String {
    env_or("MYSQL_TEST_DB", "sidb_test")
}

async fn adapter() -> Box<dyn DbAdapter> {
    let pw = pwd();
    let mut a = create_adapter(DbKind::Mysql);
    let target = ConnTarget {
        kind: DbKind::Mysql,
        host: host(),
        port: port(),
        user: user(),
        password: if pw.is_empty() { None } else { Some(pw) },
        database: Some(db()),
        schema: None,
        ssl_mode: SslMode::Prefer,
        connect_timeout_secs: 10,
        sqlite_path: None,
    };
    a.connect(&target).await.expect("connect mysql adapter");
    a
}

/// 原生连接，仅用于 setup/teardown 的 routine DDL（简单查询协议，可 CREATE/DROP FUNCTION）。
async fn raw_pool() -> MySqlPool {
    let pw = pwd();
    let mut opts = MySqlConnectOptions::new()
        .host(&host())
        .port(port())
        .username(&user())
        .database(&db())
        .ssl_mode(MySqlSslMode::Preferred);
    if !pw.is_empty() {
        opts = opts.password(&pw);
    }
    MySqlPoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .expect("raw mysql pool")
}

#[tokio::test]
#[ignore = "需要本地 MySQL，手动运行"]
async fn mysql_function_edit_roundtrip() {
    let raw = raw_pool().await;

    // 预清理：去掉历史遗留（简单查询协议，DROP FUNCTION 可用）。
    raw.execute(format!("DROP FUNCTION IF EXISTS {FN_NAME}").as_str())
        .await
        .expect("pre-clean drop");

    // 建一个函数体含 BEGIN…END（内部多条分号语句）的函数 —— 正是 sqlsplit 会切错的形态。
    raw.execute(
        format!(
            "CREATE FUNCTION {FN_NAME}(x INT) RETURNS INT DETERMINISTIC \
             BEGIN DECLARE r INT; SET r = x + 1; RETURN r; END"
        )
        .as_str(),
    )
    .await
    .expect("create function");

    let a = adapter().await;
    let routine = RoutineRef {
        database: Some(db()),
        schema: None,
        name: FN_NAME.to_string(),
        kind: RoutineKind::Function,
        id: None,
    };

    // 1) 读取定义（SHOW CREATE FUNCTION）——被测路径。
    let def = a.function_ddl(&routine).await.expect("function_ddl");
    println!("---- function_ddl ----\n{def}\n----------------------");
    assert!(
        def.to_uppercase().contains("FUNCTION"),
        "应是 CREATE …FUNCTION：{def}"
    );
    assert!(def.contains(FN_NAME), "定义应含函数名");
    assert!(def.contains("x + 1"), "定义应含原函数体");

    // 初始行为：add_one(5) = 6。
    let v: i64 = sqlx::query_scalar(&format!("SELECT {FN_NAME}(5)"))
        .fetch_one(&raw)
        .await
        .unwrap();
    assert_eq!(v, 6, "初始 add_one(5) 应为 6");

    // 2) 模拟在编辑器里把 +1 改成 +100，保存 → replace_function（MySQL: DROP+CREATE，被测路径）。
    let edited = def.replace("x + 1", "x + 100");
    assert_ne!(edited, def, "编辑后定义应有变化");
    a.replace_function(&routine, &edited)
        .await
        .expect("replace_function");

    // 3) 更新已生效：add_one(5) = 105，定义含新体、无旧体残留。
    let v: i64 = sqlx::query_scalar(&format!("SELECT {FN_NAME}(5)"))
        .fetch_one(&raw)
        .await
        .unwrap();
    assert_eq!(v, 105, "更新后 add_one(5) 应为 105");

    let def2 = a.function_ddl(&routine).await.expect("function_ddl after");
    assert!(def2.contains("x + 100"), "更新后定义应含新函数体：{def2}");
    assert!(!def2.contains("x + 1 "), "不应残留旧函数体");

    // teardown：删掉测试函数并断言已清干净。
    raw.execute(format!("DROP FUNCTION IF EXISTS {FN_NAME}").as_str())
        .await
        .expect("teardown drop");
    assert!(
        a.function_ddl(&routine).await.is_err(),
        "清理后该函数应已不存在"
    );

    println!("✅ MySQL 函数编辑保存验证通过：6 → 105，测试函数已清理");
}

/// 验证「新增 MySQL 函数」路径：adapter.create_function 整体执行含 BEGIN…END 的定义
/// （此前走 runSql → sqlsplit 切分 + 预处理 execute 会失败）。
#[tokio::test]
#[ignore = "需要本地 MySQL，手动运行"]
async fn mysql_function_create() {
    const NAME: &str = "sidb_verify_create";
    let raw = raw_pool().await;
    raw.execute(format!("DROP FUNCTION IF EXISTS {NAME}").as_str())
        .await
        .expect("pre-clean");

    let a = adapter().await;
    let routine = RoutineRef {
        database: Some(db()),
        schema: None,
        name: NAME.to_string(),
        kind: RoutineKind::Function,
        id: None,
    };

    // 函数体含 BEGIN…END（内部分号）—— 新增函数编辑器里的典型形态。
    let definition = format!(
        "CREATE FUNCTION {NAME}(x INT) RETURNS INT DETERMINISTIC \
         BEGIN DECLARE r INT; SET r = x * 2; RETURN r; END"
    );
    a.create_function(&definition)
        .await
        .expect("create_function");

    // 创建成功且可读、可调用：create(21) -> 42。
    let def = a.function_ddl(&routine).await.expect("function_ddl");
    assert!(def.contains(NAME), "定义应含函数名：{def}");
    let v: i64 = sqlx::query_scalar(&format!("SELECT {NAME}(21)"))
        .fetch_one(&raw)
        .await
        .unwrap();
    assert_eq!(v, 42, "create(21) 应为 42");

    raw.execute(format!("DROP FUNCTION IF EXISTS {NAME}").as_str())
        .await
        .expect("teardown");

    println!("✅ MySQL 新增函数验证通过：create(21) → 42，已清理");
}
