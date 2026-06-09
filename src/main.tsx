import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";
import "@/i18n";
import "@/lib/monaco";
import { initTheme } from "@/lib/theme";
import "remixicon/fonts/remixicon.css";
import "@/index.css";

initTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
