/**
 * Member ID — 8 chars, alternating letter/digit, ambiguity-free alphabet (§7).
 * No check digit (decided §7.4). CSPRNG via crypto.getRandomValues (§7.5).
 * Capacity 24^4 × 8^4 ≈ 1.36 billion.
 */

export const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // 24, no I/O
export const DIGITS = "23456789"; // 8, no 0/1

/** Short blocklist for unfortunate/offensive combos (§7.5; global-only in v0, Q28). */
const BLOCKLIST = new Set<string>(["A55H0LE2", "F4G2K7T3"]); // illustrative only

function randomChar(set: string): string {
  const idx = crypto.getRandomValues(new Uint32Array(1))[0] % set.length;
  return set[idx];
}

/** Generate one candidate Member ID (pattern L N L N L N L N). */
export function generateMemberId(): string {
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += i % 2 === 0 ? randomChar(LETTERS) : randomChar(DIGITS);
  }
  return id;
}

/**
 * Generate a globally-unique Member ID, retrying on collision / blocklist.
 * `taken` is the set of already-used IDs (the UNIQUE constraint, mocked).
 */
export function generateUniqueMemberId(taken: Set<string>, maxTries = 20): string {
  for (let i = 0; i < maxTries; i++) {
    const id = generateMemberId();
    if (!taken.has(id) && !BLOCKLIST.has(id)) return id;
  }
  throw new Error("Could not generate a unique Member ID after retries");
}

/** Normalize for storage/lookup: upper, strip separators, map nothing (case-insensitive). */
export function normalizeMemberId(raw: string): string {
  return raw.toUpperCase().replace(/[\s·.-]/g, "");
}

const ALLOWED = new Set([...LETTERS, ...DIGITS]);

/** Validate the canonical format (8 chars, alternating L/N, allowed alphabet). */
export function isValidMemberId(raw: string): boolean {
  const id = normalizeMemberId(raw);
  if (id.length !== 8) return false;
  for (let i = 0; i < 8; i++) {
    const c = id[i];
    if (!ALLOWED.has(c)) return false;
    const isLetter = LETTERS.includes(c);
    if (i % 2 === 0 && !isLetter) return false;
    if (i % 2 === 1 && !DIGITS.includes(c)) return false;
  }
  return true;
}

/** Find ambiguous chars a user might have typed (I/O/0/1) — suggest, don't auto-fix (Q27). */
export function ambiguousChars(raw: string): string[] {
  return [...raw.toUpperCase()].filter((c) => "IO01".includes(c));
}

/** Display format: B7K2-M9X4 (stored without separator). */
export function formatMemberId(id: string): string {
  const n = normalizeMemberId(id);
  return n.length === 8 ? `${n.slice(0, 4)}-${n.slice(4)}` : n;
}
