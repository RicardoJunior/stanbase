/**
 * Google Fonts — the theme editor accepts ANY Google Fonts family (free-text
 * with suggestions). Chosen families are loaded on demand so the preview and the
 * member front render them. REPLAN: self-host woff2 at build (LGPD §23.1.9).
 */

/** A broad suggestion list (the input accepts any family name, not only these). */
export const GOOGLE_FONTS: string[] = [
  // identity
  "Jost", "Hanken Grotesk", "Space Mono",
  // sans
  "Inter", "Roboto", "Open Sans", "Lato", "Montserrat", "Poppins", "Raleway", "Nunito", "Nunito Sans",
  "Work Sans", "Manrope", "Sora", "DM Sans", "Mulish", "Rubik", "Karla", "Source Sans 3", "Outfit",
  "Plus Jakarta Sans", "Albert Sans", "Figtree", "Onest", "Geist", "Be Vietnam Pro", "Epilogue",
  "Lexend", "Urbanist", "Cabin", "Quicksand", "Josefin Sans", "Oxygen", "Archivo", "Archivo Black",
  "Barlow", "Barlow Condensed", "Titillium Web", "PT Sans", "Fira Sans", "Hind", "Heebo", "Assistant",
  "Red Hat Display", "Red Hat Text", "Schibsted Grotesk", "Bricolage Grotesque", "Instrument Sans",
  "Anek Latin", "Kanit", "Saira", "Saira Condensed", "Chivo", "Public Sans", "IBM Plex Sans",
  "Libre Franklin", "Maven Pro", "Signika", "Exo 2", "Encode Sans", "Spline Sans", "Gabarito",
  "Wix Madefor Display", "Wix Madefor Text", "Familjen Grotesk", "Hanken Grotesk", "Darker Grotesque",
  "Syne", "Space Grotesk", "Unbounded", "Clash", "Bricolage Grotesque",
  // serif / display
  "Playfair Display", "Merriweather", "Lora", "PT Serif", "Source Serif 4", "Libre Baskerville",
  "Cormorant", "Cormorant Garamond", "EB Garamond", "Bitter", "Crimson Text", "Crimson Pro",
  "Spectral", "Frank Ruhl Libre", "DM Serif Display", "DM Serif Text", "Fraunces", "Newsreader",
  "Bodoni Moda", "Marcellus", "Cardo", "Zilla Slab", "Roboto Slab", "Arvo", "Domine", "Vollkorn",
  "Instrument Serif", "Petrona", "Gloock", "Bricolage Grotesque", "Young Serif", "Abril Fatface",
  "Yeseva One", "Prata", "Italiana", "Cormorant Upright", "Forum", "Philosopher",
  // mono
  "Space Mono", "JetBrains Mono", "Roboto Mono", "IBM Plex Mono", "Fira Code", "Source Code Pro",
  "Inconsolata", "DM Mono", "Overpass Mono", "Martian Mono", "Geist Mono",
  // character / display
  "Bebas Neue", "Oswald", "Anton", "Righteous", "Pacifico", "Lobster", "Comfortaa", "Caveat",
  "Dancing Script", "Sacramento", "Satisfy", "Permanent Marker", "Bungee", "Audiowide", "Orbitron",
  "Russo One", "Teko", "Fjalla One", "Alfa Slab One", "Staatliches", "Passion One", "Monoton",
].filter((v, i, a) => a.indexOf(v) === i);

const loaded = new Set<string>();

/** Inject a Google Fonts stylesheet for `family` (idempotent). */
export function loadGoogleFont(family?: string): void {
  if (!family) return;
  const fam = family.trim();
  if (!fam || loaded.has(fam)) return;
  loaded.add(fam);
  const id = "gf-" + fam.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${fam.replace(/\s+/g, "+")}:wght@300;400;500;600;700&display=swap`;
  document.head.appendChild(link);
}
