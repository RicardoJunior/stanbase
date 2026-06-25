/**
 * QR validation token (§8.4 / §9). The QR carries a signed token, not the bare
 * Member ID, so a pass can't be forged by guessing IDs.
 *
 * v0 (REPLAN): a synchronous mock signature (FNV-style hash over secret+payload),
 * with the secret living in the browser — INSECURE, demo only. Production issues a
 * short-lived JWT signed in an Edge Function with key rotation (§9.3).
 */

const SECRET = "stanbase-v0-demo-secret"; // REPLAN: server-side secret + rotation
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // ~12h (Q60)

function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function b64urlEncode(obj: unknown): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode<T>(s: string): T | null {
  try {
    const p = s.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(p)) as T;
  } catch {
    return null;
  }
}

interface TokenPayload {
  mid: string; // member id
  exp: number; // expiry epoch ms
  jti: string; // unique token id
}

/** Issue a signed token for a Member ID (embedded in the pass QR). */
export function signMemberToken(memberId: string, now = Date.now()): string {
  const payload: TokenPayload = { mid: memberId, exp: now + TOKEN_TTL_MS, jti: fnv1a(memberId + now) };
  const body = b64urlEncode(payload);
  const sig = fnv1a(SECRET + "." + body);
  return `${body}.${sig}`;
}

export type TokenResult =
  | { valid: true; memberId: string }
  | { valid: false; reason: "malformed" | "bad_signature" | "expired" };

/** Verify a token from a scanned QR. */
export function verifyMemberToken(token: string, now = Date.now()): TokenResult {
  const [body, sig] = token.split(".");
  if (!body || !sig) return { valid: false, reason: "malformed" };
  if (fnv1a(SECRET + "." + body) !== sig) return { valid: false, reason: "bad_signature" };
  const payload = b64urlDecode<TokenPayload>(body);
  if (!payload) return { valid: false, reason: "malformed" };
  if (Date.now() > payload.exp && now > payload.exp) return { valid: false, reason: "expired" };
  return { valid: true, memberId: payload.mid };
}

/** Full verify URL embedded in the QR. */
export function verifyUrl(memberId: string, origin = window.location.origin): string {
  return `${origin}/verify/${memberId}?token=${encodeURIComponent(signMemberToken(memberId))}`;
}
