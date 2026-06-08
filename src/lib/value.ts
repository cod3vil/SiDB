// Value 渲染辅助：把后端 Value 转成展示文本，并标记特殊类型（TDD §9）。

import type { Value } from "@/ipc/types";

export interface RenderedCell {
  text: string;
  isNull: boolean;
  isBytes: boolean;
  isJson: boolean;
}

export function renderValue(v: Value): RenderedCell {
  switch (v.t) {
    case "Null":
      return { text: "NULL", isNull: true, isBytes: false, isJson: false };
    case "Bool":
      return cell(v.v ? "true" : "false");
    case "Int":
    case "UInt":
    case "Float":
      return cell(String(v.v));
    case "Decimal":
    case "Text":
    case "Unknown":
    case "Date":
    case "Time":
    case "DateTime":
      return cell(v.v);
    case "Bytes":
      return { text: `(BLOB ${v.v.len} bytes)`, isNull: false, isBytes: true, isJson: false };
    case "Json":
      return { text: JSON.stringify(v.v), isNull: false, isBytes: false, isJson: true };
    case "Array":
      return cell(JSON.stringify(v.v.map((x) => renderValue(x).text)));
  }
}

function cell(text: string): RenderedCell {
  return { text, isNull: false, isBytes: false, isJson: false };
}

// 文本输入 → Value（编辑提交用，按列 value_kind 推断）。
export function parseValue(input: string, valueKind: string): Value {
  switch (valueKind) {
    case "Int":
      return { t: "Int", v: Number.parseInt(input, 10) };
    case "UInt":
      return { t: "UInt", v: Number.parseInt(input, 10) };
    case "Float":
      return { t: "Float", v: Number.parseFloat(input) };
    case "Bool":
      return { t: "Bool", v: input === "true" || input === "1" };
    case "Decimal":
      return { t: "Decimal", v: input };
    default:
      return { t: "Text", v: input };
  }
}
