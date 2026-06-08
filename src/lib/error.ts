// 统一错误展示（TDD §9）：按 AppError.code 映射文案。

import i18n from "@/i18n";
import type { AppError } from "@/ipc/types";

export function isAppError(e: unknown): e is AppError {
  return typeof e === "object" && e !== null && "code" in e;
}

export function errorMessage(e: unknown): string {
  if (isAppError(e)) {
    const base = i18n.t(`errors.${e.code}`);
    const detail = typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail);
    return detail ? `${base}: ${detail}` : base;
  }
  return String(e);
}
