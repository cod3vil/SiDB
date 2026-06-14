<div align="center">

**English** · [简体中文](./README.md)

# Author's Note
This is a fully AI-generated product. Apart from this note, I did not write a single line of code or documentation — not even the logo icon. It is a demonstration of AI's ability to build a complete product end to end.
Thanks to the following AIs:
- Claude Code
- ChatGPT
- DeepSeek


# SiDB

**A lightweight, fast, cross-platform database client with a built-in AI assistant**

Tauri 2 · Rust · React — installer is only ~7MB

Supports **MySQL · PostgreSQL · SQLite**

</div>

---

## ✨ Features

### Connection management
- Three data sources: MySQL / PostgreSQL / SQLite
- **SSH tunneling** (password / private-key auth; local port forwarding is transparent to the user)
- Credentials (passwords, key passphrases, AI API keys) are stored **only in the OS keychain** (macOS Keychain / Windows Credential Manager); never written in plaintext to config files or logs
- Test connection, grouping, edit, delete (keychain entries are cleaned up on delete)

### Object browser
- Capability-driven lazy-loaded tree: connection → database → (schema for PG) → tables / views / functions
- Filter by name; context menus (open data, view structure / DDL, edit table structure, copy name, etc.)

### SQL editor
- Monaco-based, multi-tab, syntax highlighting
- Run all / run selection / `⌘/Ctrl + Enter`; running queries can be **cancelled** (MySQL `KILL QUERY` / PG `pg_cancel_backend`)
- Save frequently used queries, shown under the tree

### Result grid & data editing
- Virtual scrolling + **server-side pagination** (configurable page size); NULL / BLOB / JSON rendered distinctly
- Double-click to edit cells, add / delete rows, visual change-set markers
- **Preview SQL** → **single-transaction commit**; an UPDATE/DELETE affecting ≠ 1 row triggers an optimistic-concurrency conflict and rolls back everything

### Schema / function management
- Visual dialogs to create database / table / view; edit table structure (generates `ALTER`); view table DDL
- Functions / stored procedures: view definition, create, and **edit in place** (PG via `CREATE OR REPLACE`, MySQL via `DROP` + `CREATE`)

### AI assistant
- Natural-language chat side panel with multiple conversations + a **history drawer**
- Tool-loop agent: can browse the schema and run read-only queries (forced `LIMIT` and timeout)
- **Write operations are only produced as proposals and require explicit user confirmation before execution**; every AI-issued SQL is written to an audit log
- Provider: Anthropic / OpenAI-compatible / custom endpoint; the API key goes into the keychain

### Misc
- Settings: theme (light / dark / follow system), language (中文 / English), default page size
- Cross-platform: macOS (Apple Silicon + Intel), Windows

---

## 🧱 Tech stack

| Layer | Technology |
|---|---|
| Backend | Rust · Tauri 2 · sqlx · russh (SSH) · keyring · tokio |
| Frontend | React 18 · TypeScript · Vite · Monaco · TanStack Table/Virtual · zustand · Tailwind · i18next |

All database-dialect differences are confined to `src-tauri/src/adapters/`; adding a new database = implementing one adapter.

---

## 🚀 Development

```bash
pnpm install            # frontend deps
pnpm tauri dev          # run in dev (first run compiles the whole Rust dependency tree)
pnpm tauri build        # package locally (macOS → .app/.dmg, Windows → .msi/.exe)
```

### Lint / test

```bash
# Rust
cargo fmt    --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test   --manifest-path src-tauri/Cargo.toml                 # unit + SQLite contract tests
cargo test   --manifest-path src-tauri/Cargo.toml -- --ignored    # container integration tests (needs Docker)

# Frontend
pnpm tsc --noEmit && pnpm vitest run
```

Integration tests use testcontainers (MySQL 8 / PG 16 / openssh-server), are marked `#[ignore]`, and run only when Docker is available locally.

---

## 📦 CI / CD

- **CI** (`.github/workflows/ci.yml`): on push / PR, runs `fmt` + `clippy` + `test` across three platforms, plus frontend `tsc` + `vitest`
- **Release** (`.github/workflows/release.yml`): on a `v*` tag, builds installers on macOS (arm/intel) + Windows and publishes a draft GitHub Release

```bash
git tag v0.1.0 && git push origin v0.1.0   # triggers per-platform packaging and creates a Release
```

> Installers are currently unsigned: on macOS, allow it the first time under "System Settings → Privacy & Security"; on Windows you may see a SmartScreen prompt.

---

## 🔒 Security

- Credentials are passed only through memory and discarded after being written to the keychain; never persisted in plaintext to logs / config
- Data editing is fully parameterized; identifiers are quoted and sourced from metadata, rejecting string-concatenation injection
- AI writes are double-gated: a proposal is produced first, then executed through a backend-validated confirmation endpoint

---

## 📁 Project structure

```
src-tauri/          # Rust backend
  src/
    commands.rs     # IPC boundary (arg validation + DTO conversion only)
    models.rs       # unified types / errors
    adapters/       # per-database adapters (dialect differences live only here)
    services/       # connection / query / edit / export / credential / settings
    tunnel/         # SSH tunnel (russh)
    ai/             # AI provider / tools / audit
src/                # React frontend
  components/{tree,editor,grid,ai,table,conn,settings}/
  stores/  ipc/  i18n/
```
