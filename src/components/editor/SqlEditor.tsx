// SQL 编辑器（TDD §9 / PRD §3.3）：Monaco。执行/停止/库选择已上移到顶部工具栏。
// 右键菜单含 AI 动作（解释 / 优化），作用于选区，无选区则整段。

import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import Editor, { type OnMount } from "@monaco-editor/react";

export type AiEditorAction = "explain" | "optimize";

interface Props {
  value: string;
  onChange: (v: string) => void;
  /** 执行：传入要跑的 SQL；null 表示执行整段。 */
  onRun: (sql: string | null) => void;
  onAiAction?: (kind: AiEditorAction, sql: string) => void;
  /** 实时写入当前选区文本（无选区为空串），供外部（工具栏运行按钮）读取。 */
  selectionRef?: React.MutableRefObject<string>;
  fontSize?: number;
  theme?: "light" | "dark";
}

type MonacoEditor = Parameters<OnMount>[0];

/** 选区文本；无选区返回整段。 */
function selectedOrAll(editor: MonacoEditor): string {
  const sel = editor.getSelection();
  const model = editor.getModel();
  if (sel && !sel.isEmpty() && model) return model.getValueInRange(sel);
  return editor.getValue();
}

/** 当前选区文本（无选区返回空串）。 */
function selectionText(editor: MonacoEditor): string {
  const sel = editor.getSelection();
  const model = editor.getModel();
  if (sel && !sel.isEmpty() && model) return model.getValueInRange(sel);
  return "";
}

export function SqlEditor({ value, onChange, onRun, onAiAction, selectionRef, fontSize = 13, theme = "dark" }: Props) {
  const { t } = useTranslation();
  const editorRef = useRef<MonacoEditor | null>(null);
  const selRef = useRef(selectionRef);
  selRef.current = selectionRef;
  // 用 ref 保证 Monaco 回调始终拿到最新的 onRun/onAiAction（编辑器只挂载一次，
  // 否则 addCommand 会捕获初次渲染的闭包，导致读到过期的 tab.connId 等状态）。
  const runRef = useRef(onRun);
  runRef.current = onRun;
  const aiRef = useRef(onAiAction);
  aiRef.current = onAiAction;

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      // 实时同步选区文本到外部 ref（工具栏运行按钮据此判断跑选区还是整段）。
      const syncSel = () => {
        if (selRef.current?.current !== undefined) selRef.current.current = selectionText(editor);
      };
      editor.onDidChangeCursorSelection(syncSel);
      syncSel();
      // Cmd/Ctrl + Enter：有选区跑选区，否则跑整段
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        const sel = selectionText(editor);
        runRef.current(sel ? sel : null);
      });
      // 执行（右键，置顶分组）
      editor.addAction({
        id: "run-all-sql",
        label: t("editor.runAll"),
        contextMenuGroupId: "0_run",
        contextMenuOrder: 1,
        run: () => runRef.current(null),
      });
      editor.addAction({
        id: "run-selected-sql",
        label: t("editor.runSelected"),
        contextMenuGroupId: "0_run",
        contextMenuOrder: 2,
        run: () => {
          const sel = selectionText(editor);
          if (sel) runRef.current(sel);
        },
      });
      // AI 右键动作
      editor.addAction({
        id: "ai-explain-sql",
        label: t("ai.explain"),
        contextMenuGroupId: "ai",
        contextMenuOrder: 1,
        run: () => {
          const sql = selectedOrAll(editor).trim();
          if (sql) aiRef.current?.("explain", sql);
        },
      });
      editor.addAction({
        id: "ai-optimize-sql",
        label: t("ai.optimize"),
        contextMenuGroupId: "ai",
        contextMenuOrder: 2,
        run: () => {
          const sql = selectedOrAll(editor).trim();
          if (sql) aiRef.current?.("optimize", sql);
        },
      });
    },
    // t 仅用于初次注册菜单标签；语言切换后重启或重挂生效。
    [t],
  );

  return (
    <Editor
      language="sql"
      theme={theme === "dark" ? "vs-dark" : "vs"}
      value={value}
      onChange={(v) => onChange(v ?? "")}
      onMount={handleMount}
      options={{
        fontSize,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
      }}
    />
  );
}
