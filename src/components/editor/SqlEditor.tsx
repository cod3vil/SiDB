// SQL 编辑器（TDD §9 / PRD §3.3）：Monaco + 执行 / 取消。

import { useCallback, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { useTranslation } from "react-i18next";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onRun: (selectedOnly: boolean) => void;
  onCancel?: () => void;
  running?: boolean;
  fontSize?: number;
}

export function SqlEditor({ value, onChange, onRun, onCancel, running, fontSize = 13 }: Props) {
  const { t } = useTranslation();
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
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-2 py-1 bg-neutral-900 border-b border-neutral-800">
        <button
          className="px-3 py-1 text-xs bg-emerald-700 hover:bg-emerald-600 rounded disabled:opacity-40"
          onClick={() => onRun(false)}
          disabled={running}
        >
          {t("editor.runAll")}
        </button>
        {running && onCancel && (
          <button
            className="px-3 py-1 text-xs bg-red-700 hover:bg-red-600 rounded"
            onClick={onCancel}
          >
            {t("editor.cancel")}
          </button>
        )}
        <span className="text-xs text-neutral-500 ml-auto">⌘/Ctrl + Enter</span>
      </div>
      <div className="flex-1 min-h-0">
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
      </div>
    </div>
  );
}
