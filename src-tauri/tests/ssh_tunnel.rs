//! SSH 私钥隧道手动验证（需可达的真实 SSH 服务器，标 ignore）。
//!
//! 运行：
//!   SSH_KEY=/path/to/key SSH_HOST=1.92.11.47 SSH_PORT=60022 SSH_USER=root \
//!   cargo test --manifest-path src-tauri/Cargo.toml --test ssh_tunnel \
//!     -- --ignored --nocapture

use sidb_lib::tunnel::{SshAuth, TunnelManager, TunnelSpec};
use tokio::io::AsyncReadExt;
use tokio::net::TcpStream;

fn env_or(k: &str, d: &str) -> String {
    std::env::var(k).unwrap_or_else(|_| d.to_string())
}

#[tokio::test]
#[ignore = "需要可达的真实 SSH 服务器，手动运行"]
async fn ssh_key_tunnel() {
    let key_path = std::env::var("SSH_KEY").expect("需设置 SSH_KEY=/path/to/private_key");
    let pem = std::fs::read_to_string(&key_path).expect("读取私钥");

    let tm = TunnelManager::new();
    let spec = TunnelSpec {
        ssh_host: env_or("SSH_HOST", "1.92.11.47"),
        ssh_port: env_or("SSH_PORT", "60022").parse().unwrap(),
        ssh_user: env_or("SSH_USER", "root"),
        auth: SshAuth::Key {
            pem,
            passphrase: None,
        },
        // 转发到远端某个监听端口验证链路（默认指向 sshd 自身端口）。
        remote_host: env_or("REMOTE_HOST", "127.0.0.1"),
        remote_port: env_or("REMOTE_PORT", "60022").parse().unwrap(),
    };

    let (id, addr) = tm.open(spec).await.expect("开隧道（私钥认证）失败");
    println!("✅ 私钥认证 + 隧道建立成功，本地转发地址 = {addr}");

    // 经本地转发连远端 sshd，读 banner 证明转发链路通。
    let mut s = TcpStream::connect(addr).await.expect("连接本地转发口");
    let mut buf = [0u8; 128];
    let n = s.read(&mut buf).await.expect("读 banner");
    let banner = String::from_utf8_lossy(&buf[..n]);
    println!("远端 sshd banner: {}", banner.trim());
    assert!(
        banner.starts_with("SSH-"),
        "应收到 SSH banner，实际: {banner:?}"
    );

    tm.close(&id);
    println!("✅ 转发链路验证通过，隧道已关闭");
}
