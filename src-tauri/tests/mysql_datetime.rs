//! MySQL 时间类型解码回归测试（testcontainers，需要本地 Docker）。
//!
//! 复现并锁定的 bug：DATE/TIME/DATETIME/TIMESTAMP 在 sqlx 二进制协议下是「打包
//! 结构」（首字节为长度，年份为小端 u16 等），旧代码走 `string_via_bytes` 的
//! `try_get_unchecked::<Vec<u8>>` 兜底直接把原始字节按 UTF-8 读，导致整列显示为
//! 乱码（如 `\u{7}\u{fffd}\u{7}...`）。修复：新增 `decode_temporal`/`format_mysql_temporal`
//! 按打包格式解码。
//!
//! 运行：
//!   cargo test --manifest-path src-tauri/Cargo.toml --test mysql_datetime \
//!     -- --ignored --nocapture

use sidb_lib::adapters::create_adapter;
use sidb_lib::models::*;
use testcontainers_modules::{mysql::Mysql, testcontainers::runners::AsyncRunner};

#[tokio::test]
#[ignore = "需要本地 Docker（testcontainers），手动运行"]
async fn mysql_temporal_types_decode() {
    let node = Mysql::default()
        .start()
        .await
        .expect("start mysql container");
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
        "CREATE TABLE dt_t (id INT PRIMARY KEY, d DATE, t TIME, dt DATETIME, ts TIMESTAMP NULL, dt6 DATETIME(6))",
        &[],
    )
    .await
    .expect("create table");
    a.execute(
        "q",
        "INSERT INTO dt_t (id, d, t, dt, ts, dt6) VALUES \
         (1, '2024-06-15', '21:51:16', '2024-06-15 21:51:16', '2024-06-15 21:51:16', '2024-06-15 21:51:16.123456')",
        &[],
    )
    .await
    .expect("insert");

    // 列值：修复前这些全是乱码（原始打包字节按 UTF-8 读）。
    let rows = a
        .query("q", "SELECT d, t, dt, ts, dt6 FROM dt_t WHERE id = 1", &[])
        .await
        .expect("query temporal columns");
    assert_eq!(
        rows.rows[0][0],
        Value::Date("2024-06-15".into()),
        "DATE 应正确解码"
    );
    assert_eq!(
        rows.rows[0][1],
        Value::Time("21:51:16".into()),
        "TIME 应正确解码"
    );
    assert_eq!(
        rows.rows[0][2],
        Value::DateTime("2024-06-15 21:51:16".into()),
        "DATETIME 应正确解码，而非乱码"
    );
    assert_eq!(
        rows.rows[0][3],
        Value::DateTime("2024-06-15 21:51:16".into()),
        "TIMESTAMP 应正确解码"
    );
    assert_eq!(
        rows.rows[0][4],
        Value::DateTime("2024-06-15 21:51:16.123456".into()),
        "DATETIME(6) 应带微秒"
    );

    // 字面量 NOW()/CURDATE()/CURTIME() 同样应显示（复现时也乱码）。
    let lit = a
        .query(
            "q",
            "SELECT CAST('2026-08-06 08:18:23' AS DATETIME) x, CAST('838:59:59' AS TIME) big",
            &[],
        )
        .await
        .expect("query temporal literal");
    assert_eq!(
        lit.rows[0][0],
        Value::DateTime("2026-08-06 08:18:23".into())
    );
    // 超过 24h 的 TIME（MySQL 合法，chrono NaiveTime 无法表达）也应正确。
    assert_eq!(lit.rows[0][1], Value::Time("838:59:59".into()));

    println!("✅ MySQL 时间类型解码验证通过：DATE/TIME/DATETIME/TIMESTAMP/DATETIME(6)/838:59:59");
}
