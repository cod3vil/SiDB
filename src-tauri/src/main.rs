// 发布版禁止额外的控制台窗口（Windows）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    dblite_lib::run()
}
