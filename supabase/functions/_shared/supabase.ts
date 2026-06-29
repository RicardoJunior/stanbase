import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/** Service-role client (bypasses RLS — always filter org_id explicitly in queries). */
export function serviceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, { auth: { persistSession: false } });
}
