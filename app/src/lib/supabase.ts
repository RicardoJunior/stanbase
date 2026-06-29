/**
 * Supabase client — the single place that talks to the real backend.
 *
 * The app runs in two modes, decided purely by env at build time:
 *  - PROTOTYPE (default): no VITE_SUPABASE_URL set → `client` is null and
 *    `hasBackend()` is false. Everything keeps reading/writing the localStorage
 *    store (lib/store.ts) via lib/api.ts. Nothing here is exercised.
 *  - REAL: VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY set → `client` is a
 *    supabase-js instance used for RLS-scoped READS, and VITE_FUNCTIONS_URL
 *    points the financial/secret WRITES at the Edge `/v1-*` functions.
 *
 * Importing this module is side-effect-free when the envs are absent, so it is
 * safe to import anywhere without changing prototype behaviour.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const FUNCTIONS_URL = import.meta.env.VITE_FUNCTIONS_URL;

/**
 * True when the real backend is configured. Gate every remote call behind this
 * — when false, callers MUST fall back to the localStorage store so the
 * prototype mode is never broken.
 */
export const hasBackend = (): boolean => !!SUPABASE_URL;

/** True when the Edge `/v1-*` functions are configured (financial/secret writes). */
export const hasFunctions = (): boolean => !!FUNCTIONS_URL;

/**
 * The supabase-js client, or null in prototype mode. RLS scopes every read to
 * `app.current_org()` from the JWT, so the anon key is safe in the browser —
 * service-role work happens only in the Edge Functions.
 */
export const client: SupabaseClient | null =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true },
      })
    : null;

/** Narrowed accessor: throws if called in prototype mode (guard with hasBackend()). */
export function requireClient(): SupabaseClient {
  if (!client) {
    throw new Error(
      "Supabase não configurado: defina VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY.",
    );
  }
  return client;
}
