import type { Config } from "tailwindcss";

/**
 * Stanbase design tokens — sourced verbatim from the brand identity in
 * `stanbase.html` (§23 design-system, §24 white-label).
 *
 * Two token tiers:
 *  - PRIMITIVES (ivory/paper/ink/gold/obsidian) — the raw identity palette, fixed.
 *  - SEMANTIC (bg/surface/text/primary/accent/border/...) — exposed as CSS custom
 *    properties so the *member* surface can be re-themed per org at runtime
 *    (deep-merge over the identity defaults). The admin uses the fixed identity.
 */
const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        // primitives (identity)
        ivory: "#f5f3ed",
        paper: "#fffefb",
        ink: { DEFAULT: "#16150f", soft: "#5d584c" },
        gold: { DEFAULT: "#b8965a", deep: "#8a6a32", light: "#e7d3a6" },
        obsidian: { DEFAULT: "#15140f", 2: "#211f17" },

        // semantic (themable via CSS vars — read by both admin + member)
        bg: "var(--color-bg)",
        surface: "var(--color-surface)",
        "surface-2": "var(--color-surface-2)",
        content: "var(--color-text)",
        muted: "var(--color-text-muted)",
        primary: "var(--color-primary)",
        "primary-contrast": "var(--color-primary-contrast)",
        accent: "var(--color-accent)",
        line: "var(--color-border)",
        success: "var(--color-success)",
        warning: "var(--color-warning)",
        danger: "var(--color-danger)",
      },
      fontFamily: {
        display: "var(--font-display)",
        body: "var(--font-body)",
        mono: "var(--font-mono)",
      },
      borderColor: {
        DEFAULT: "var(--color-border)",
      },
      boxShadow: {
        card: "0 22px 44px -28px rgba(22,21,15,.4)",
        "card-hover": "0 24px 48px -28px rgba(22,21,15,.42)",
        pass: "0 40px 80px -36px rgba(22,21,15,.6), inset 0 1px 0 rgba(255,255,255,.05)",
      },
      letterSpacing: {
        eyebrow: ".22em",
      },
      borderRadius: {
        base: "var(--radius-base)",
      },
    },
  },
  plugins: [],
};

export default config;
