# SiDB

轻量级跨平台数据库客户端 —— Tauri 2 + Rust + React。

一期支持 **MySQL / PostgreSQL / SQLite**，含 SSH 隧道、数据编辑，预留 AI 模块。

> 需求见 [`PRD.md`](./PRD.md)，技术设计见 [`TDD.md`](./TDD.md)。开发约定见 [`CLAUDE.md`](./CLAUDE.md)。两者为唯一事实来源；冲突时以 TDD 为准。

## 技术栈

- 后端：Rust（`src-tauri/`）—— sqlx + russh + keyring + tokio
- 前端：React 18 + TypeScript + Vite（`src/`）—— Monaco + TanStack Table/Virtual + zustand + Tailwind

## 开发

```bash
pnpm install            # 前端依赖
pnpm tauri dev          # 开发运行
pnpm tauri build        # 打包

# Rust
cargo test   --manifest-path src-tauri/Cargo.toml
cargo test   --manifest-path src-tauri/Cargo.toml -- --ignored   # 容器集成测试（需 Docker）
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings

# 前端
pnpm vitest run && pnpm tsc --noEmit
```

集成测试使用 testcontainers（MySQL 8 / PG 16 / openssh-server），标记 `#[ignore]`，仅在本地有 Docker 时运行。

## 里程碑

- [x] M0 工程脚手架
- [ ] M1 适配层（SQLite → MySQL → PostgreSQL）
- [ ] M2 SSH 隧道与连接管理
- [ ] M3 查询主流程（含前端三大件）
- [ ] M4 数据编辑
- [ ] M5 导出 / AI 骨架 / 打包

## 架构铁律

1. 数据库方言差异只能出现在 `src-tauri/src/adapters/` 内部
2. `commands.rs` 只做参数校验与 DTO 转换
3. 含用户数据的 SQL 必须参数化；标识符引号化且来源于元数据
4. 凭证只经 `CredentialService` 进系统钥匙串
5. 结果集只走分页通道
6. AI 写操作只产出 proposal，执行经 `ai_confirm_write`
