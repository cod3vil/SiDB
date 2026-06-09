// SQL 编辑器（TDD §9 / PRD §3.3）：Monaco。执行/停止/库选择已上移到顶部工具栏。

import { useCallback, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onRun: (selectedOnly: boolean) => void;
  fontSize?: number;
}

export function SqlEditor({ value, onChange, onRun, fontSize = 13 }: Props) {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      // Cmd/Ctrl + Enter 执行
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        const sel = editor.getSelection();
        const hasSel = sel && !sel.isEmpty();
        onRun(Boolean(hasSel));
      });
    },
    [onRun],
  );

  return (
    <Editor
      language="sql"
      theme="vs-dark"
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
