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

function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Lighten (amt>0, toward white) or darken (amt<0, toward black) a hex color. amt ∈ [-1,1]. */
export function shade(hex: string, amt: number): string {
  const [r, g, b] = hexToRgb(hex);
  const t = amt < 0 ? 0 : 255;
  const p = Math.abs(amt);
  const mix = (c: number) => (t - c) * p + c;
  return rgbToHex(mix(r), mix(g), mix(b));
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

  if (theme.primary) {
    vars["--color-primary"] = theme.primary;
    vars["--color-primary-contrast"] = contrastColor(theme.primary);
    vars["--color-focus-ring"] = theme.primary;
  }
  if (theme.accent) vars["--color-accent"] = theme.accent;
  if (theme.fontDisplay) vars["--font-display"] = `"${theme.fontDisplay}", system-ui, sans-serif`;
  if (theme.fontBody) vars["--font-body"] = `"${theme.fontBody}", system-ui, sans-serif`;

  // configurable page background per mode (surface/text derived)
  const bg = dark ? theme.bgDark : theme.bgLight;
  if (bg) {
    const text = contrastColor(bg);
    const onDark = text !== INK; // light text → dark bg
    vars["--color-bg"] = bg;
    vars["--color-surface"] = shade(bg, dark ? 0.06 : 0.5);
    vars["--color-surface-2"] = shade(bg, dark ? 0.12 : 0.0);
    vars["--color-text"] = text;
    vars["--color-text-muted"] = onDark ? "rgba(239,233,218,.6)" : "rgba(22,21,15,.58)";
    vars["--color-border"] = onDark ? "rgba(239,233,218,.16)" : "rgba(22,21,15,.12)";
  }
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
  const bg = mode === "dark" ? (theme.bgDark ?? "#15140f") : (theme.bgLight ?? "#fffefb");
  const text = contrastColor(bg);
  const primary = theme.primary ?? "#16150f";
  const accent = theme.accent ?? "#8a6a32";
  return [
    { pair: "texto / fundo", label: "Texto no fundo", desc: "leitura geral da página", gating: true, ...contrastVerdict(text, bg) },
    { pair: "texto sobre primária", label: "Texto nos botões", desc: "rótulo dentro dos botões da cor primária", gating: true, ...contrastVerdict(contrastColor(primary), primary) },
    { pair: "texto sobre acento", label: "Texto no realce", desc: "texto sobre a cor de realce", gating: true, ...contrastVerdict(contrastColor(accent), accent) },
    { pair: "primária / fundo", label: "Primária como detalhe", desc: "a cor primária usada como ícone/borda no fundo", gating: false, ...contrastVerdict(primary, bg) },
  ];
}
