# 更新日志 / Changelog

本项目遵循语义化版本。日期为发布日。
This project follows semantic versioning. Dates are release dates.

---

## v1.2.7

**中文**
- 「新建查询」始终打开一个新标签页（不再复用当前标签）。
- SQL 编辑器右键新增「运行已选择的」：只执行选中的那段 SQL，不改动编辑器其它内容；`⌘/Ctrl+Enter` 也改为有选区跑选区、无选区跑整段。

**English**
- "New query" now always opens a fresh tab (no longer reuses the current one).
- SQL editor context menu adds "Run selection": runs only the highlighted SQL without changing the rest of the editor; `⌘/Ctrl+Enter` runs the selection when present, otherwise the whole statement.

## v1.2.6

**中文**
- Redis：修复连接无超时——连不上时不再无限「连接中」，约 10 秒内明确报超时。
- 修复保存的查询未归属当前 PostgreSQL 库，导致保存后在「查询」节点看不到。
- 设置窗口加高，让 AI 的「测试连接」按钮可见。
- 新增配置备份：设置 →「备份」，可把全部连接 / 查询 / 设置（含凭证）导出到 `sidb.json`，也支持导入（按 id 合并）。
- 补齐全部 16 种语言的界面本地化。

**English**
- Redis: fixed missing connect timeout — unreachable servers no longer spin forever; times out in ~10s.
- Fixed saved queries not being attached to the current PostgreSQL database (so they were missing under "Queries").
- Taller settings dialog so the AI "Test connection" button is visible.
- Config backup: Settings → "Backup" exports all connections / queries / settings (with credentials) to `sidb.json`, with import (merge by id).
- Completed UI localization for all 16 languages.

## v1.2.5

**中文**
- PostgreSQL：`search_path` 跟随工具栏所选 schema——手写未限定表名的查询（如 `SELECT * FROM client`）能正确解析。
- 单表 SQL 查询结果标记主键列（显示钥匙图标）并支持直接编辑。
- 工具栏移除「表」筛选器（简化为 连接 / 库 / schema）。

**English**
- PostgreSQL: `search_path` follows the selected schema — unqualified queries (e.g. `SELECT * FROM client`) resolve correctly.
- Single-table SQL results mark primary-key columns (key icon) and are editable.
- Removed the table picker from the toolbar (now connection / database / schema).

## v1.2.4

**中文**
- PostgreSQL 数据库右键新增「新建 Schema」。
- 修复 PostgreSQL 的 timestamp / date / time 列不显示（二进制协议解码）。

**English**
- Added "New schema" to the PostgreSQL database context menu.
- Fixed PostgreSQL timestamp / date / time columns not displaying (binary-protocol decoding).

## v1.2.3

**中文**
- 编辑已有连接时密码留空，「测试连接」改用钥匙串里已存的凭证（不再用空密码失败）。
- 经 SSH 隧道连接失败时显示隧道层的真实原因。

**English**
- When editing a connection with a blank password, "Test connection" now uses the stored keychain credentials.
- Surfaced the real tunnel-level error when connecting through an SSH tunnel fails.

## v1.2.2

**中文**
- 修复 64 位整数（如 Snowflake bigint ID）超出 JS 安全整数范围时不显示 / 丢精度（改为字符串精确传输）。

**English**
- Fixed 64-bit integers (e.g. Snowflake bigint IDs) not displaying / losing precision beyond JS safe-integer range (now sent as strings).

## v1.2.1

**中文**
- 编辑表改为多标签：字段 / 索引 / 外键 / 选项 / 注释，列 / 引用表 / 引擎 / 字符集等改为下拉选择，索引支持方法选择。
- 表右键新增：重命名 / 复制 / 清空 / 截断 / 删除。
- 结果集主键图标 + 列头快捷排序（表浏览，服务端排序）。
- PostgreSQL 多库浏览（切库重连）。
- AI 请求可中止；「问 AI」改为附带当前结果、可删除。
- 修复 MySQL BIT 列读取、连接竞态（两次 not connected）。

**English**
- Edit-table dialog is now tabbed: Columns / Indexes / Foreign keys / Options / Comment, with dropdowns for columns / ref table / engine / charset, and index method selection.
- Table context menu: Rename / Duplicate / Empty / Truncate / Drop.
- Result-set primary-key icon + quick column sorting (table browse, server-side).
- PostgreSQL multi-database browsing (reconnect on switch).
- AI requests can be cancelled; "Ask AI" now attaches the current result (removable).
- Fixed MySQL BIT decoding and a connect race ("not connected" twice).

## v1.1.1

**中文**
- 修复 MySQL BIT 列读取报错。

**English**
- Fixed a MySQL BIT column read error.

## v1.1.0

**中文**
- 新增 Redis 支持：键浏览（SCAN + 模式 + 类型过滤）、各类型查看 / 编辑、TTL、命令台、AI 助手、JSON 导出。
- AI 可针对当前查询结果集讨论。

**English**
- Added Redis support: key browsing (SCAN + pattern + type filter), per-type view / edit, TTL, command console, AI assistant, JSON export.
- AI can discuss the current query result set.

## v1.0.0

**中文**
- 首个正式版本。轻量、快速、跨平台的数据库客户端，内置 AI 助手，支持 MySQL / PostgreSQL / SQLite。

**English**
- First stable release. A lightweight, fast, cross-platform database client with a built-in AI assistant, supporting MySQL / PostgreSQL / SQLite.
