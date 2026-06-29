// Public API skeleton (§21). Mounted at /functions/v1/*.
//   GET /v1/health
//   GET /v1/public/verify/{memberId}   → minimal public validation (no PII), §9
// Resource endpoints (members, tiers, subscriptions…) follow the same pattern,
// authenticated by API key (api_keys table) — added incrementally.
import { handlePreflight } from "../_shared/cors.ts";
import { ok, error } from "../_shared/response.ts";
import { serviceClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  const pre = handlePreflight(req);
  if (pre) return pre;

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/v1/, "").replace(/\/+$/, "") || "/";

  if (path === "/health") {
    return ok({ status: "ok", service: "stanbase-v1", time: new Date().toISOString() });
  }

  // GET /public/verify/{memberId}
  const verify = path.match(/^\/public\/verify\/([A-Za-z0-9]+)$/);
  if (verify) {
    const code = verify[1].toUpperCase();
    const db = serviceClient();
    const { data: member } = await db.from("members").select("id, member_id, org_id, tier_id, status, joined_at").eq("member_id", code).maybeSingle();
    if (!member) return error("not_found", "Member ID não encontrado", 404);
    const { data: org } = await db.from("organizations").select("name, logo_text, theme").eq("id", member.org_id).single();
    const { data: tier } = member.tier_id ? await db.from("tiers").select("name, color").eq("id", member.tier_id).single() : { data: null };
    return ok({
      valid: member.status !== "canceled",
      status: member.status,
      memberId: member.member_id,
      memberSince: member.joined_at,
      org: { name: org?.name, logoText: org?.logo_text, theme: org?.theme },
      tier: tier ? { name: tier.name, color: tier.color } : null,
      // PII (name/photo) only with a signed token — omitted here.
    });
  }

  return error("not_found", `Rota ${path} não encontrada`, 404);
});
