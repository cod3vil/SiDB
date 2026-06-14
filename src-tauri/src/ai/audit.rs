//! AI 审计日志（TDD §7）。所有工具调用写 `~/.sidb/logs/ai_audit.log`。

use crate::services::settings::data_dir;
use std::io::Write;

/// 追加一条审计记录（时间、conn、SQL、结果摘要）。失败仅告警，不阻断主流程。
pub fn record(conn_id: &str, action: &str, sql: &str, summary: &str) {
    let dir = data_dir().join("logs");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let line = format!(
        "{}\t{}\t{}\t{}\t{}\n",
        chrono::Utc::now().to_rfc3339(),
        conn_id,
        action,
        sql.replace('\n', " "),
        summary
    );
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("ai_audit.log"))
    {
        let _ = f.write_all(line.as_bytes());
    }
}
