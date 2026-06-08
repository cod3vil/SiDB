// 本地化 Monaco：Tauri 下 CSP 为 `script-src 'self'`，不能从 CDN 加载。
// 这里把 @monaco-editor/react 的 loader 指向本地 monaco-editor 包，并用
// Vite 的 `?worker` 机制把编辑器 worker 打成同源资源（worker-src 'self' blob:）。

import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

self.MonacoEnvironment = {
  // SQL 走基础语言贡献，仅需通用 editor worker。
  getWorker: () => new editorWorker(),
};

loader.config({ monaco });
