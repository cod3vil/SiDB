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

/** 取单元格可编辑的原始文本（编辑框预填用）。 */
export function editText(v: Value): string {
  switch (v.t) {
    case "Null":
    case "Bytes":
      return "";
    case "Bool":
      return v.v ? "1" : "0";
    case "Int":
    case "UInt":
    case "Float":
      return String(v.v);
    case "Json":
      return JSON.stringify(v.v);
    case "Array":
      return JSON.stringify(v.v);
    default:
      return v.v;
  }
}

// 整数输入：在 JS 安全范围内用 number，否则保留字符串（避免 Snowflake 等 64 位 ID 丢精度）。
function intValue(input: string): number | string {
  const trimmed = input.trim();
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : trimmed;
}

// 文本输入 → Value（编辑提交用，按列 value_kind 推断）。
export function parseValue(input: string, valueKind: string): Value {
  switch (valueKind) {
    case "Int":
      return { t: "Int", v: intValue(input) };
    case "UInt":
      return { t: "UInt", v: intValue(input) };
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
