<div align="center">

[English](./README.en.md) · **简体中文**

# 作者声明
这是一个纯AI生成的产品，除了这个声明，我并没有编写任何一行代码、文档，甚至Logo图标，这验证了AI创建完整产品的能力。
感谢以下AI的帮助：
- Claude Code
- ChatGPT
- Deepseek


# SiDB

**轻量、快速、跨平台的数据库客户端，内置 AI 助手**

Tauri 2 · Rust · React — 安装包仅约 7MB

支持 **MySQL · PostgreSQL · SQLite**

</div>

---

## ✨ 功能

### 连接管理
- MySQL / PostgreSQL / SQLite 三种数据源
- **SSH 隧道**（密码 / 私钥认证，本地端口转发对用户透明）
- 凭证（密码、私钥口令、AI API Key）**只存系统钥匙串**（macOS Keychain / Windows 凭据管理器），配置文件与日志中绝不含明文
- 连接测试、分组、编辑、删除（删除时同步清理钥匙串）

### 对象浏览器
- 能力驱动的懒加载树：连接 → 库 →（PG 含 schema）→ 表 / 视图 / 函数
- 按名称过滤；右键菜单（打开数据、查看结构 / DDL、编辑表结构、复制名称等）

### SQL 编辑器
- 基于 Monaco，多标签页、语法高亮
- 执行全部 / 执行选中 / `⌘/Ctrl + Enter`，运行中可**取消**（MySQL `KILL QUERY` / PG `pg_cancel_backend`）
- 保存常用查询，随树展示

### 结果集与数据编辑
- 虚拟滚动 + **服务端分页**（页大小可调），NULL / BLOB / JSON 区分渲染
- 双击编辑单元格、增 / 删行、变更集可视标记
- **预览 SQL** → **单事务提交**；UPDATE/DELETE 影响行数 ≠ 1 触发乐观并发冲突并整体回滚

### 结构 / 函数管理
- 可视化新建数据库 / 表 / 视图；编辑表结构（生成 `ALTER`）；查看建表 DDL
- 函数 / 存储过程：查看定义、新建、**就地编辑保存**（PG 走 `CREATE OR REPLACE`，MySQL 走 `DROP`+`CREATE`）

### AI 助手
- 自然语言对话侧栏，多会话 + **历史抽屉**
- 工具循环 Agent：可浏览库结构、跑只读查询（强制 `LIMIT` 与超时）
- **写操作只产出提案，必须用户确认后才执行**；所有 AI 触发的 SQL 写审计日志
- Provider 可选 Anthropic / OpenAI 兼容 / 自定义端点，API Key 入钥匙串

### 其他
- 设置：主题（亮 / 暗 / 跟随系统）、语言（中文 / English）、默认分页大小
- 跨平台：macOS（Apple Silicon + Intel）、Windows

---

## 🧱 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Rust · Tauri 2 · sqlx · russh（SSH）· keyring · tokio |
| 前端 | React 18 · TypeScript · Vite · Monaco · TanStack Table/Virtual · zustand · Tailwind · i18next |

数据库方言差异全部收敛在 `src-tauri/src/adapters/` 内，新增一种数据库 = 实现一个适配器。

---

## 🚀 开发

```bash
pnpm install            # 前端依赖
pnpm tauri dev          # 开发运行（首次会编译整个 Rust 依赖树）
pnpm tauri build        # 本机打包（macOS 出 .app/.dmg，Windows 出 .msi/.exe）
```

### 检查 / 测试

```bash
# Rust
cargo fmt    --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test   --manifest-path src-tauri/Cargo.toml                 # 单元 + SQLite 契约测试
cargo test   --manifest-path src-tauri/Cargo.toml -- --ignored    # 容器集成测试（需 Docker）

# 前端
pnpm tsc --noEmit && pnpm vitest run
```

集成测试使用 testcontainers（MySQL 8 / PG 16 / openssh-server），标记 `#[ignore]`，仅在本地有 Docker 时运行。

---

## 📦 CI / CD

- **CI**（`.github/workflows/ci.yml`）：push / PR 时跑三平台 `fmt` + `clippy` + `test`，及前端 `tsc` + `vitest`
- **Release**（`.github/workflows/release.yml`）：推送 `v*` tag 时在 macOS（arm/intel）+ Windows 上构建安装包并发布到草稿 Release

```bash
git tag v0.1.0 && git push origin v0.1.0   # 触发各平台打包并生成 Release
```

> 当前安装包未做代码签名：首次打开 macOS 需在「系统设置 → 隐私与安全性」放行，Windows 可能出现 SmartScreen 提示。

---

## 🔒 安全

- 凭证仅经内存传递、写入系统钥匙串后即弃；日志 / 配置不落明文
- 数据编辑全程参数化；标识符引号化且来源于元数据，拒绝字符串拼接注入
- AI 写操作双重门控：先产出提案，再经后端校验的确认接口执行

---

## 📁 项目结构

```
src-tauri/          # Rust 后端
  src/
    commands.rs     # IPC 边界（仅参数校验 + DTO 转换）
    models.rs       # 统一类型 / 错误
    adapters/       # 各库适配器（方言差异只在此）
    services/       # 连接 / 查询 / 编辑 / 导出 / 凭证 / 设置
    tunnel/         # SSH 隧道（russh）
    ai/             # AI provider / 工具 / 审计
src/                # React 前端
  components/{tree,editor,grid,ai,table,conn,settings}/
  stores/  ipc/  i18n/
```
