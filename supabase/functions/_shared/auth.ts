import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { AppError } from "./response.ts";

export interface AuthContext {
  orgId: string;
  scopes: string[];
}

/** sha-256 hex digest of a raw API key (we never store the raw value). */
export async function hashKey(raw: string): Promise<string> {
  const bytes = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Reads the raw key from `x-api-key` or `Authorization: Bearer …`. */
function readRawKey(req: Request): string | null {
  const header = req.headers.get("x-api-key");
  if (header) return header.trim();

  const auth = req.headers.get("authorization");
  if (auth) {
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }
  return null;
}

/**
 * Authenticates a /v1 request by API key. Looks the sha-256 hash up in
 * api_keys (service role — filter org_id downstream) and returns the org/scopes.
 * Throws AppError('unauthorized', …, 401) when the key is missing or invalid.
 */
export async function resolveAuth(req: Request, db: SupabaseClient): Promise<AuthContext> {
  const raw = readRawKey(req);
  if (!raw) throw new AppError("unauthorized", "API key ausente", 401);

  const hash = await hashKey(raw);
  const { data, error } = await db
    .from("api_keys")
    .select("org_id, scopes")
    .eq("hash", hash)
    .maybeSingle();

  if (error || !data) throw new AppError("unauthorized", "API key inválida", 401);

  // Best-effort last-used touch; never blocks the request.
  db.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("hash", hash).then();

  return { orgId: data.org_id as string, scopes: (data.scopes ?? []) as string[] };
}
