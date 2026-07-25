# 更新日志 / Changelog

本项目遵循语义化版本。日期为发布日。
This project follows semantic versioning. Dates are release dates.

---

## v1.3.2

**中文**
- 有新版本时更醒目：顶部标题栏版本号旁新增一个呼吸动效的「有新版本」小标签，点击即开始下载安装并自动重启（下载中显示进度百分比）。此前发现新版本仅弹一次提示，容易被忽略。

**English**
- New versions are now more noticeable: a breathing "New version" tag appears next to the version number in the title bar; click it to download, install, and auto-restart (progress percentage shown while downloading). Previously an update only surfaced as a one-time toast that was easy to miss.

## v1.3.1

**中文**
- SSH 隧道认证新增「密码 + 公钥」方式：服务器要求同时通过公钥与密码认证时可用（先做 publickey，未完成再补密码）。认证方式下拉现为 密码 / 公钥 / 密码 + 公钥；选公钥时仍通过「浏览」选取私钥文件。
- 修复：编辑既有连接时，SSH 密码 / 私钥口令留空不再覆盖钥匙串中已存的凭证。

**English**
- SSH tunneling adds a "Password + public key" auth method for servers that require both publickey and password (publickey first, then password if the server asks for more). The auth dropdown is now Password / Public key / Password + public key; picking a key still selects the private-key file via "Browse".
- Fixed: leaving the SSH password / key passphrase blank when editing a connection no longer overwrites the credential stored in the keychain.

## v1.3.0

**中文**
- 新增本地 MCP 服务（设置 → AI → MCP）：本地 AI 工具（Claude Code、Codex 等）可通过 MCP over HTTP 直连并操作数据库。服务仅监听 `127.0.0.1`，Bearer Token 鉴权，Token 存于系统钥匙串，可一键复制 / 重置及查看接入配置片段。
- MCP 能力为「读 + 批准写」：暴露 `list_connections / list_databases / list_schemas / list_tables / get_schema / run_read_query / propose_write` 七个工具。只读查询强制单语句、只读、`LIMIT 1000`、30s 超时；任何写操作只生成提案，需在 SiDB 界面人工确认后才执行。已保存连接按需自动连接。Redis 暂不经 MCP 暴露。
- 结果集编辑：布尔类型字段改为双击弹出 `true` / `false`（可空列含 `NULL`）下拉选择，不再手填文本。

**English**
- Added a local MCP service (Settings → AI → MCP): local AI tools (Claude Code, Codex, …) can connect over MCP-on-HTTP to operate your databases. The service binds `127.0.0.1` only, uses Bearer-token auth with the token stored in the system keychain, and offers one-click copy / rotate plus ready-to-paste client config snippets.
- MCP is "read + approve writes": it exposes seven tools — `list_connections / list_databases / list_schemas / list_tables / get_schema / run_read_query / propose_write`. Read queries are forced single-statement, read-only, `LIMIT 1000`, 30s timeout; any write becomes a proposal that must be approved in the SiDB UI before it runs. Saved connections auto-connect on demand. Redis is not exposed over MCP yet.
- Result-grid editing: boolean cells now edit via a double-click `true` / `false` dropdown (plus `NULL` for nullable columns) instead of typing text.

## v1.2.12

**中文**
- SQL Server：补齐查询取消（运行中可「停止」，另开连接 `KILL` 当前会话后自动重连）。
- SQL Server：支持函数 / 存储过程的可视化新建与编辑（此前仅可查看定义）。
- 修复 PostgreSQL：在结果集里编辑 `timestamp` / `date` / `time` 列并提交时报「is of type … but expression is of type text」——现按列类型正确绑定参数（含带时区的 timestamptz），无法解析时回退文本。

**English**
- SQL Server: added query cancellation (a running query can be stopped — a side connection issues `KILL`, then the adapter reconnects automatically).
- SQL Server: create/edit functions & stored procedures from the visual editor (previously view-only).
- Fixed PostgreSQL: editing a `timestamp` / `date` / `time` cell in the result grid failed with "is of type … but expression is of type text" — values are now bound as their proper types (including timestamptz), falling back to text when unparseable.

## v1.2.11

**中文**
- AI 助手：新增「最大工具往返轮数」与「每轮 max_tokens」两项设置（设置 → AI），默认 20 / 4096。此前工具轮数硬编码为 8，复杂问题易触发「已达到工具调用上限」；现可自行调高。
- 两项设置纳入配置备份 / 恢复，旧备份自动回落默认值。

**English**
- AI assistant: added "max tool rounds" and "max tokens per round" settings (Settings → AI), defaulting to 20 / 4096. The tool-round count was previously hardcoded at 8, which could hit "tool-call limit reached" on complex questions; it's now adjustable.
- Both settings are included in config backup / restore; older backups fall back to defaults.

## v1.2.10

**中文**
- 新增 SQL Server（T-SQL）支持：连接（SQL 身份验证 / SSH 隧道）、库 → schema → 表/视图/函数 浏览、数据浏览与编辑、建表 / 改表结构（列、索引、外键）、查看表与函数定义。采用纯 Rust 的 tiberius 驱动，跨库三段式限定，`OFFSET…FETCH` 分页。
- 说明：本版 SQL Server 暂不支持查询取消与函数的可视化创建 / 编辑（可查看定义）。

**English**
- Added SQL Server (T-SQL) support: connect (SQL auth / SSH tunnel), browse database → schema → tables/views/functions, view & edit data, create/alter table structure (columns, indexes, foreign keys), view table & routine definitions. Built on the pure-Rust tiberius driver, with three-part cross-database names and `OFFSET…FETCH` pagination.
- Note: query cancellation and visual create/edit of routines are not yet available for SQL Server in this release (definitions are viewable).

## v1.2.9

**中文**
- 新增 TDengine 支持：连接、库/表浏览、超级表与子表识别、标签可视化，以及「最近 1h / 24h / 7d」时间范围快捷查询。
- 新增 MariaDB 支持（与 MySQL 线协议兼容，建表 / 改表结构 / 索引 / 外键 / 表选项全部可用）。
- 新建连接的数据库类型改为下拉菜单（接入种类增多后更清爽）。
- 无主键或唯一非空索引的结果集显示为「只读」短标签，鼠标悬停显示具体原因。
- 子表标签不再挤占表名，改为悬停 tooltip 显示。
- 新建连接弹窗高度略微加高。

**English**
- Added TDengine support: connect, database/table browsing, super-table & child-table detection, tag visualization, and "last 1h / 24h / 7d" quick time-range queries.
- Added MariaDB support (MySQL wire-compatible; create/alter table, indexes, foreign keys and table options all work).
- Connection type is now a dropdown in the New Connection dialog (cleaner as more engines are added).
- Result sets without a primary key or unique-not-null index show a short "Read-only" label; hover reveals the reason.
- Child-table tags no longer crowd out the table name — shown in a hover tooltip instead.
- Slightly taller New Connection dialog.

## v1.2.8

**中文**
- 修复工具栏「运行」按钮误把点击事件当作 SQL 传入的问题；运行选中/整段 SQL 均恢复正常。

**English**
- Fixed the toolbar "Run" button passing the click event as SQL; running the selection or the whole statement works correctly again.

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
