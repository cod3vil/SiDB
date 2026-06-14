// i18n（zh-CN / en，TDD §9）。文案全部走 key，禁止组件内硬编码文案。

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./zh-CN";
import en from "./en";

export const LANGUAGES = [
  { value: "zh-CN", label: "中文" },
  { value: "en", label: "English" },
] as const;

const STORAGE_KEY = "sidb.lang";
const saved = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;

i18n.use(initReactI18next).init({
  resources: {
    "zh-CN": { translation: zhCN },
    en: { translation: en },
  },
  lng: saved ?? "zh-CN",
  fallbackLng: "zh-CN",
  interpolation: { escapeValue: false },
});

/** 切换语言并持久化到 localStorage。 */
export function setLanguage(lng: string) {
  void i18n.changeLanguage(lng);
  try {
    localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    /* ignore */
  }
}

export default i18n;
