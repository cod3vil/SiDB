//! MySQL DECIMAL 解码回归测试（testcontainers，需要本地 Docker）。
//!
//! 复现并锁定的 bug：DECIMAL/NEWDECIMAL 列在 sqlx 二进制协议下既不被
//! 当作 String 也不被当作 Vec<u8>（类型兼容检查两路都拒绝），旧代码因此把整列
//! 显示为空串。修复：`string_via_bytes` 增加 `try_get_unchecked::<Vec<u8>>` 兜底，
//! 直接取原始字节（DECIMAL 的原始字节即 ASCII 数字串）。
//!
//! 运行：
//!   cargo test --manifest-path src-tauri/Cargo.toml --test mysql_decimal \
//!     -- --ignored --nocapture

use sidb_lib::adapters::create_adapter;
use sidb_lib::models::*;
use testcontainers_modules::{mysql::Mysql, testcontainers::runners::AsyncRunner};

#[tokio::test]
#[ignore = "需要本地 Docker（testcontainers），手动运行"]
async fn mysql_decimal_decodes_to_string() {
    let node = Mysql::default().start().await.expect("start mysql container");
    let host = node.get_host().await.unwrap().to_string();
    let port = node.get_host_port_ipv4(3306).await.unwrap();

    let mut a = create_adapter(DbKind::Mysql);
    let target = ConnTarget {
        kind: DbKind::Mysql,
        host,
        port,
        user: "root".into(),
        password: None,
        database: Some("test".into()),
        schema: None,
        ssl_mode: SslMode::Disable,
        connect_timeout_secs: 30,
        sqlite_path: None,
    };
    a.connect(&target).await.expect("connect mysql adapter");

    a.execute(
        "q",
        "CREATE TABLE dec_t (id INT PRIMARY KEY, v DECIMAL(10,2))",
        &[],
    )
    .await
    .expect("create table");
    a.execute(
        "q",
        "INSERT INTO dec_t (id, v) VALUES (1, 123.45), (2, 0.00), (3, -7.10)",
        &[],
    )
    .await
    .expect("insert");

    // 列值：修复前这里全是 Value::Decimal("")（空串）。
    let rows = a
        .query("q", "SELECT v FROM dec_t ORDER BY id", &[])
        .await
        .expect("query decimal column");
    assert_eq!(
        rows.rows[0][0],
        Value::Decimal("123.45".into()),
        "DECIMAL 列应解码为数字串，而非空"
    );
    assert_eq!(rows.rows[1][0], Value::Decimal("0.00".into()));
    assert_eq!(rows.rows[2][0], Value::Decimal("-7.10".into()));

    // 字面量 / 表达式 DECIMAL 同样应显示（复现时 `SELECT 1.50` 也为空）。
    let lit = a
        .query(
            "q",
            "SELECT CAST(1.5 AS DECIMAL(10,2)) d1, 3.14 + 0.0 d2",
            &[],
        )
        .await
        .expect("query decimal literal");
    assert_eq!(lit.rows[0][0], Value::Decimal("1.50".into()));
    assert_eq!(lit.rows[0][1], Value::Decimal("3.14".into()));

    println!("✅ MySQL DECIMAL 解码验证通过：123.45 / 0.00 / -7.10 / 1.50 / 3.14");
}
