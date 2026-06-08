//! DBLite 库入口：装配模块并启动 Tauri 应用。

pub mod adapters;
pub mod ai;
pub mod commands;
pub mod models;
pub mod services;
pub mod sqlsplit;
pub mod tunnel;

use commands::AppState;

/// 初始化日志：滚动文件 + 控制台。全局脱敏在 service 层保证（禁止记录密码 / 整行数据）。
fn init_tracing() {
    use tracing_subscriber::{fmt, EnvFilter};
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = fmt().with_env_filter(filter).try_init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::list_connections,
            commands::save_connection,
            commands::delete_connection,
            commands::test_connection,
            commands::connect,
            commands::disconnect,
            commands::list_databases,
            commands::list_schemas,
            commands::list_tables,
            commands::list_columns,
            commands::get_table_schema,
            commands::get_table_ddl,
            commands::open_table_data,
            commands::run_sql,
            commands::cancel_query,
            commands::preview_changes,
            commands::commit_changes,
            commands::get_settings,
            commands::set_settings,
            commands::ai_test_provider,
        ])
        .run(tauri::generate_context!())
        .expect("error while running DBLite");
}
