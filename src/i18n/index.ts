// i18n（一期仅 zh-CN，TDD §9）。文案全部走 key，禁止组件内硬编码中文。

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import zhCN from "./zh-CN";

i18n.use(initReactI18next).init({
  resources: { "zh-CN": { translation: zhCN } },
  lng: "zh-CN",
  fallbackLng: "zh-CN",
  interpolation: { escapeValue: false },
});

export default i18n;
