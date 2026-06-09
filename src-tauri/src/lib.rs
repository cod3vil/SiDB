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

/// macOS：运行期把 Dock / 「关于」面板图标设为打包图标（dev 下也生效）。
#[cfg(target_os = "macos")]
fn set_macos_app_icon() {
    use objc2::AnyThread;
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::{MainThreadMarker, NSData};

    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    static ICON: &[u8] = include_bytes!("../icons/icon.png");
    let data = NSData::with_bytes(ICON);
    let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else {
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    unsafe { app.setApplicationIconImage(Some(&image)) };
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            set_macos_app_icon();
            Ok(())
        })
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
            commands::list_functions,
            commands::list_columns,
            commands::get_table_schema,
            commands::get_table_ddl,
            commands::open_table_data,
            commands::run_sql,
            commands::cancel_query,
            commands::preview_changes,
            commands::commit_changes,
            commands::list_queries,
            commands::save_query,
            commands::delete_query,
            commands::get_settings,
            commands::set_settings,
            commands::ai_test_provider,
        ])
        .run(tauri::generate_context!())
        .expect("error while running SiDB");
}
