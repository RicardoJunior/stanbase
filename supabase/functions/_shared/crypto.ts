// Symmetric encryption for integration secrets (production).
// Secrets are encrypted at the application layer (AES-256-GCM) before they ever
// touch the DB; the DB only stores opaque ciphertext. The key lives in the
// `INTEGRATIONS_ENC_KEY` secret (32 bytes, base64). Rotate by re-encrypting.
//
//   supabase secrets set INTEGRATIONS_ENC_KEY="$(openssl rand -base64 32)"
//
// Ciphertext format (base64 of): [12-byte IV][GCM ciphertext+tag]. Self-contained
// so decrypt needs only the key.

let cachedKey: CryptoKey | null = null;

async function getKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  const raw = Deno.env.get("INTEGRATIONS_ENC_KEY");
  if (!raw) throw new Error("INTEGRATIONS_ENC_KEY ausente — configure o secret de cifragem.");
  const bytes = Uint8Array.from(atob(raw.trim()), (c) => c.charCodeAt(0));
  if (bytes.length !== 32) throw new Error("INTEGRATIONS_ENC_KEY deve ter 32 bytes (base64 de 32 bytes).");
  cachedKey = await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  return cachedKey;
}

const toB64 = (buf: ArrayBuffer | Uint8Array): string => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const byte of b) s += String.fromCharCode(byte);
  return btoa(s);
};
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Encrypts a UTF-8 string → base64(iv|ciphertext). */
export async function encryptString(plaintext: string): Promise<string> {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  return toB64(out);
}

/** Decrypts base64(iv|ciphertext) → UTF-8 string. */
export async function decryptString(payload: string): Promise<string> {
  const key = await getKey();
  const bytes = fromB64(payload);
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}

/** Encrypts a credentials map field-by-field → { field: ciphertext }. */
export async function encryptCredentials(creds: Record<string, string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(creds)) out[k] = await encryptString(String(v ?? ""));
  return out;
}

/** Decrypts a credentials map produced by encryptCredentials. */
export async function decryptCredentials(enc: Record<string, string> | null | undefined): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(enc ?? {})) {
    try {
      out[k] = await decryptString(String(v));
    } catch {
      // Legacy/plaintext value (pre-encryption) — pass through so reconnect can heal it.
      out[k] = String(v);
    }
  }
  return out;
}
