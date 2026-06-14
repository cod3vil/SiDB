#!/usr/bin/env bash
# 一次性引导：初始化 git 仓库、生成占位图标、安装依赖。
# 用法：bash scripts/bootstrap.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# 1) git 仓库
if [ ! -d .git ]; then
  git init -q
  git add -A
  git commit -q -m "chore: M0 scaffold + M1 adapters skeleton (SiDB)"
  echo "✓ git 仓库已初始化并完成首个提交"
else
  echo "• git 仓库已存在，跳过"
fi

# 2) 占位图标（Tauri 构建需要）
bash scripts/gen-icons.sh

# 3) 前端依赖
if command -v pnpm >/dev/null 2>&1; then
  pnpm install
else
  echo "• 未检测到 pnpm，请先 'npm i -g pnpm' 后运行 'pnpm install'"
fi

echo "完成。开发运行：pnpm tauri dev"
