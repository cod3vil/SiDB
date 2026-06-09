// 主题（亮/暗）：切换 <html> 的 .dark 类并持久化到 localStorage。默认暗色。

export type Theme = "light" | "dark";

const STORAGE_KEY = "dblite.theme";

export function getTheme(): Theme {
  const saved = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
  return saved === "light" ? "light" : "dark";
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
}

/** 启动时按持久化值套用主题（在 React 渲染前调用）。 */
export function initTheme() {
  applyTheme(getTheme());
}
