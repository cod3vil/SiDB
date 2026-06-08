/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Neutral surface palette tuned for both light/dark DB UIs.
        surface: {
          DEFAULT: "var(--surface)",
          muted: "var(--surface-muted)",
        },
        // 介于 Tailwind neutral 700/800/900 之间的过渡色，提供更细腻的暗色层次。
        neutral: {
          750: "#333333",
          850: "#1f1f1f",
        },
      },
      fontFamily: {
        mono: ["'JetBrains Mono'", "'SF Mono'", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
