/**
 * Theming engine — STANBASE.md §23.
 *  - Member surface overrides a controlled subset of the SEMANTIC token layer
 *    per org (deep-merge over identity defaults). Admin stays on the identity.
 *  - `*-contrast` is DERIVED, never chosen (§23.1.5): pick ink or paper by WCAG.
 *  - Contrast is conceptually a publish gate; here we expose the score for the editor.
 */
import type { OrgTheme } from "@/types/domain";

const INK = "#16150f";
const PAPER = "#fffefb";

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const int = parseInt(h, 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function channelLuminance(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** WCAG contrast ratio between two colors (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Derive the readable text color (ink vs paper) over a given background (§23.1.5). */
export function contrastColor(bg: string): string {
  return contrastRatio(bg, INK) >= contrastRatio(bg, PAPER) ? INK : PAPER;
}

export type ContrastVerdict = "pass" | "aa-large" | "fail";

export function contrastVerdict(fg: string, bg: string): { ratio: number; verdict: ContrastVerdict } {
  const ratio = contrastRatio(fg, bg);
  const verdict: ContrastVerdict = ratio >= 4.5 ? "pass" : ratio >= 3 ? "aa-large" : "fail";
  return { ratio: Math.round(ratio * 100) / 100, verdict };
}

/**
 * Resolve an org theme into the CSS custom properties the member surface injects.
 * Only the semantic layer is touched; unset tokens inherit identity defaults.
 */
export function resolveThemeVars(theme: OrgTheme, mode: "light" | "dark"): Record<string, string> {
  const vars: Record<string, string> = {};
  const dark = mode === "dark";
  const bg = dark ? "#15140f" : "#fffefb";

  if (theme.primary) {
    vars["--color-primary"] = theme.primary;
    vars["--color-primary-contrast"] = contrastColor(theme.primary);
    vars["--color-focus-ring"] = theme.primary;
  }
  if (theme.accent) vars["--color-accent"] = theme.accent;
  if (theme.fontDisplay) vars["--font-display"] = `"${theme.fontDisplay}", system-ui, sans-serif`;
  if (theme.fontBody) vars["--font-body"] = `"${theme.fontBody}", system-ui, sans-serif`;
  // bg/text already provided by tokens.css [data-theme]; we only override accents.
  void bg;
  return vars;
}

/** Apply resolved theme vars to an element (member shell root). */
export function applyThemeVars(el: HTMLElement, vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
}

/**
 * Pairs the theme editor reports on (§23.1.5). `gating` marks the real TEXT
 * pairs that block publication ("par de texto"); brand colors used as element
 * backgrounds are advisory (their readable text pair is checked separately).
 */
export function themeContrastReport(theme: OrgTheme, mode: "light" | "dark") {
  const bg = mode === "dark" ? "#15140f" : "#fffefb";
  const text = mode === "dark" ? "#efe9da" : "#16150f";
  const primary = theme.primary ?? "#16150f";
  const accent = theme.accent ?? "#8a6a32";
  return [
    { pair: "texto / fundo", gating: true, ...contrastVerdict(text, bg) },
    { pair: "texto sobre primária", gating: true, ...contrastVerdict(contrastColor(primary), primary) },
    { pair: "texto sobre acento", gating: true, ...contrastVerdict(contrastColor(accent), accent) },
    { pair: "primária / fundo (acento)", gating: false, ...contrastVerdict(primary, bg) },
  ];
}
