// i18n（多语言，TDD §9）。文案全部走 key，禁止组件内硬编码文案。

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./zh-CN";
import zhTW from "./zh-TW";
import en from "./en";
import ja from "./ja";
import ko from "./ko";
import es from "./es";
import fr from "./fr";
import de from "./de";
import ru from "./ru";
import ptBR from "./pt-BR";
import it from "./it";
import ar from "./ar";
import hi from "./hi";
import vi from "./vi";
import th from "./th";
import id from "./id";
import tr from "./tr";
import nl from "./nl";

/** 语言列表（value = i18n code，label = 该语言的本地名称）。 */
export const LANGUAGES = [
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "es", label: "Español" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "ru", label: "Русский" },
  { value: "pt-BR", label: "Português" },
  { value: "it", label: "Italiano" },
  { value: "ar", label: "العربية" },
  { value: "hi", label: "हिन्दी" },
  { value: "vi", label: "Tiếng Việt" },
  { value: "th", label: "ไทย" },
  { value: "id", label: "Bahasa Indonesia" },
  { value: "tr", label: "Türkçe" },
  { value: "nl", label: "Nederlands" },
] as const;

const resources = {
  "zh-CN": { translation: zhCN },
  "zh-TW": { translation: zhTW },
  en: { translation: en },
  ja: { translation: ja },
  ko: { translation: ko },
  es: { translation: es },
  fr: { translation: fr },
  de: { translation: de },
  ru: { translation: ru },
  "pt-BR": { translation: ptBR },
  it: { translation: it },
  ar: { translation: ar },
  hi: { translation: hi },
  vi: { translation: vi },
  th: { translation: th },
  id: { translation: id },
  tr: { translation: tr },
  nl: { translation: nl },
};

/** 从右到左的语言。 */
const RTL = new Set(["ar"]);

const STORAGE_KEY = "sidb.lang";
const saved = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;

function applyDir(lng: string) {
  if (typeof document !== "undefined") {
    document.documentElement.dir = RTL.has(lng) ? "rtl" : "ltr";
  }
}

const initial = saved && saved in resources ? saved : "zh-CN";
applyDir(initial);

i18n.use(initReactI18next).init({
  resources,
  lng: initial,
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

/** 切换语言并持久化到 localStorage。 */
export function setLanguage(lng: string) {
  void i18n.changeLanguage(lng);
  applyDir(lng);
  try {
    localStorage.setItem(STORAGE_KEY, lng);
  } catch {
    /* ignore */
  }
}

export default i18n;
