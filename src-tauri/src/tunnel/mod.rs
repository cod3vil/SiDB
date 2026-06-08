//! SSH 隧道（TDD §5）。基于 russh 纯 Rust 实现本地端口转发。
//!
//! - `open(spec)` 建立 SSH 会话，监听 `127.0.0.1:<random>`，每个本地连接经
//!   `channel_open_direct_tcpip` 转发到远端数据库地址。
//! - 凭证只存钥匙串引用，真实密码 / 口令在 open 时取出，用后即弃。
//! - 主机指纹：一期 TOFU（首次信任）。

use crate::models::AppError;
use dashmap::DashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpListener;

pub type TunnelId = String;

/// SSH 认证方式（已解出明文 / 私钥内容）。
#[derive(Clone)]
pub enum SshAuth {
    Password(String),
    Key { pem: String, passphrase: Option<String> },
}

#[derive(Clone)]
pub struct TunnelSpec {
    pub ssh_host: String,
    pub ssh_port: u16,
    pub ssh_user: String,
    pub auth: SshAuth,
    pub remote_host: String,
    pub remote_port: u16,
}

struct TunnelHandle {
    /// 通知后台任务退出。
    shutdown: tokio::sync::watch::Sender<bool>,
    local_addr: SocketAddr,
}

#[derive(Default)]
pub struct TunnelManager {
    tunnels: DashMap<TunnelId, TunnelHandle>,
}

/// russh 客户端 handler：一期 TOFU，接受服务器公钥。
///
/// russh 0.45 的 `Handler` 仍是 `#[async_trait]`，故实现块需同样标注。
struct ClientHandler;

#[async_trait::async_trait]
impl russh::client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        // TODO(M2 T2.2): 记录到 ~/.dblite/known_hosts，变更时弹窗警告。
        Ok(true)
    }
}

impl TunnelManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// 建立隧道，返回本地监听地址。
    pub async fn open(&self, spec: TunnelSpec) -> Result<(TunnelId, SocketAddr), AppError> {
        let config = Arc::new(russh::client::Config::default());
        let mut session = russh::client::connect(
            config,
            (spec.ssh_host.as_str(), spec.ssh_port),
            ClientHandler,
        )
        .await
        .map_err(|e| AppError::Ssh(format!("connect: {e}")))?;

        // 认证
        let authed = match &spec.auth {
            SshAuth::Password(pw) => session
                .authenticate_password(&spec.ssh_user, pw)
                .await
                .map_err(|e| AppError::Ssh(format!("auth: {e}")))?,
            SshAuth::Key { pem, passphrase } => {
                let key = russh::keys::decode_secret_key(pem, passphrase.as_deref())
                    .map_err(|e| AppError::Ssh(format!("key decode: {e}")))?;
                session
                    .authenticate_publickey(&spec.ssh_user, Arc::new(key))
                    .await
                    .map_err(|e| AppError::Ssh(format!("auth: {e}")))?
            }
        };
        if !authed {
            return Err(AppError::AuthFailed("ssh authentication failed".into()));
        }

        // 本地监听随机端口
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| AppError::Ssh(format!("bind: {e}")))?;
        let local_addr = listener
            .local_addr()
            .map_err(|e| AppError::Ssh(format!("local_addr: {e}")))?;

        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let session = Arc::new(session);
        let remote_host = spec.remote_host.clone();
        let remote_port = spec.remote_port;

        // 后台转发任务
        tokio::spawn(async move {
            let mut shutdown_rx = shutdown_rx;
            loop {
                tokio::select! {
                    _ = shutdown_rx.changed() => {
                        if *shutdown_rx.borrow() { break; }
                    }
                    accept = listener.accept() => {
                        let Ok((mut socket, _peer)) = accept else { continue };
                        let session = session.clone();
                        let rhost = remote_host.clone();
                        tokio::spawn(async move {
                            let channel = match session
                                .channel_open_direct_tcpip(rhost, remote_port as u32, "127.0.0.1", 0)
                                .await
                            {
                                Ok(c) => c,
                                Err(e) => {
                                    tracing::warn!("direct-tcpip open failed: {e}");
                                    return;
                                }
                            };
                            forward(&mut socket, channel).await;
                        });
                    }
                }
            }
        });

        let id = uuid::Uuid::new_v4().to_string();
        self.tunnels.insert(
            id.clone(),
            TunnelHandle { shutdown: shutdown_tx, local_addr },
        );
        Ok((id, local_addr))
    }

    pub fn close(&self, id: &str) {
        if let Some((_, handle)) = self.tunnels.remove(id) {
            let _ = handle.shutdown.send(true);
        }
    }

    pub fn local_addr(&self, id: &str) -> Option<SocketAddr> {
        self.tunnels.get(id).map(|h| h.local_addr)
    }
}

/// 在本地 TCP 套接字与 SSH channel 间双向拷贝。
///
/// russh 的 `Channel` 提供 `into_stream()`（实现 AsyncRead + AsyncWrite），
/// 直接用 `copy_bidirectional` 即可，避免手工 select 造成的并发借用问题。
async fn forward(
    socket: &mut tokio::net::TcpStream,
    channel: russh::Channel<russh::client::Msg>,
) {
    let mut stream = channel.into_stream();
    if let Err(e) = tokio::io::copy_bidirectional(socket, &mut stream).await {
        tracing::debug!("tunnel forward closed: {e}");
    }
}
