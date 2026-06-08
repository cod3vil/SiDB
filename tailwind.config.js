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
      },
      fontFamily: {
        mono: ["'JetBrains Mono'", "'SF Mono'", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
