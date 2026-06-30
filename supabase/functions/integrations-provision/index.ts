// integrations-provision — the provisioning worker (§19/§20). Drains
// `provision_jobs`: for each due job it loads the org connection, decrypts its
// credentials, and calls the provider adapter's grant/revoke hook to (de)provision
// the perk for one member.
//
// NOT API-key authenticated (verify_jwt=false). It is an internal worker invoked
// by a scheduler (pg_cron / external cron) or by membership hooks, so it is
// protected by a shared secret: `Authorization: Bearer <CRON_SECRET>`. If
// CRON_SECRET is unset we refuse every request (fail closed).
//
// Runs with the service role → bypasses RLS, so EVERY query filters org_id
// explicitly (the org_id comes from the job/connection row, never the caller).
//
// Routes (path = pathname after the function name):
//   POST /  |  /drain      → claim & process up to {max:25} due jobs
//   POST /enqueue          → enqueue grant/revoke for a member's tier mappings
import { handlePreflight } from "../_shared/cors.ts";
import { ok, error, AppError } from "../_shared/response.ts";
import { serviceClient } from "../_shared/supabase.ts";
import { decryptCredentials } from "../_shared/crypto.ts";
import { getAdapter } from "../_shared/connectors/registry.ts";
import type { ProvisionContext, ProvisionResult } from "../_shared/connectors/types.ts";
import {
  claimDueJobs,
  completeJob,
  failJob,
  enqueueForMemberTier,
  memberExternalIds,
  type ProvisionJobRow,
} from "../_shared/provision.ts";
import { type SupabaseClient } from "@supabase/supabase-js";

// ── helpers ────────────────────────────────────────────────────────
const FUNCTION_PREFIX = /^\/(functions\/v1\/)?integrations-provision/;

/** Strips the function name and trailing slashes, leaving the logical route. */
function routePath(req: Request): string {
  return new URL(req.url).pathname.replace(FUNCTION_PREFIX, "").replace(/\/+$/, "") || "/";
}

async function readJson(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    // Allow an empty body (e.g. cron POSTs nothing) → caller-supplied defaults apply.
    return {};
  }
}

/** Fail-closed bearer-token guard. Requires CRON_SECRET to be set AND to match. */
function authorizeWorker(req: Request): void {
  const secret = Deno.env.get("CRON_SECRET");
  if (!secret) throw new AppError("unauthorized", "Worker não autorizado", 401);
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  // Constant-time-ish compare: length guard then per-char (avoids early-exit leak).
  if (header.length !== expected.length) throw new AppError("unauthorized", "Worker não autorizado", 401);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) throw new AppError("unauthorized", "Worker não autorizado", 401);
}

// ── drain ──────────────────────────────────────────────────────────

/** Resolves the email/phone/name for a member from member_profiles (best effort). */
async function loadMemberProfile(
  db: SupabaseClient,
  orgId: string,
  memberId: string,
): Promise<{ email: string | null; phone: string | null; name: string | null }> {
  const { data } = await db
    .from("member_profiles")
    .select("email, phone, name")
    .eq("org_id", orgId)
    .eq("member_id", memberId)
    .maybeSingle();
  return {
    email: data?.email ?? null,
    phone: data?.phone ?? null,
    name: data?.name ?? null,
  };
}

/** Process a single claimed job to completion (complete or fail). Never throws. */
async function processJob(db: SupabaseClient, job: ProvisionJobRow): Promise<"done" | "failed"> {
  try {
    // The connection carries the org's credentials + connection status for this provider.
    const { data: conn } = await db
      .from("connections")
      .select("status, provider, credentials")
      .eq("org_id", job.org_id)
      .eq("provider", job.provider)
      .maybeSingle();

    if (!conn) {
      await failJob(db, job, `Conexão ${job.provider} não encontrada`, false);
      return "failed";
    }
    // GRANT requires a live connection; REVOKE must still run after a disconnect
    // (we keep the row + credentials precisely so we can clean up access).
    if (job.action === "grant" && conn.status !== "connected") {
      await failJob(db, job, `Conexão ${job.provider} não está conectada (status=${conn.status})`, false);
      return "failed";
    }
    if (!conn.credentials || Object.keys(conn.credentials).length === 0) {
      await failJob(db, job, `Conexão ${job.provider} sem credenciais para ${job.action}`, false);
      return "failed";
    }

    const adapter = getAdapter(job.provider);
    if (!adapter) {
      await failJob(db, job, `Provider sem adapter: ${job.provider}`, false);
      return "failed";
    }

    const hook = job.action === "grant" ? adapter.grant : adapter.revoke;
    if (!hook) {
      // Provider has no provisioning for this action → nothing to do, succeed.
      await completeJob(db, job.id);
      return "done";
    }

    if (!job.member_id) {
      await failJob(db, job, "Job sem member_id", false);
      return "failed";
    }

    const credentials = await decryptCredentials(conn.credentials as Record<string, string> | null);
    const [externalIds, profile] = await Promise.all([
      memberExternalIds(db, job.member_id),
      loadMemberProfile(db, job.org_id, job.member_id),
    ]);

    const ctx: ProvisionContext = {
      orgId: job.org_id,
      resource: job.resource,
      credentials,
      member: {
        id: job.member_id,
        externalIds,
        email: profile.email,
        phone: profile.phone,
        name: profile.name,
      },
    };

    const result: ProvisionResult = await hook.call(adapter, ctx);
    if (result?.ok) {
      await completeJob(db, job.id);
      // Record the successful (de)provision for the org's audit/event trail.
      await db.from("integration_events").insert({
        org_id: job.org_id,
        provider: job.provider,
        event_type: `provision.${job.action}`,
        payload: { resource: job.resource, memberId: job.member_id },
      }).then(() => {}, () => {}); // best effort — never let logging fail the job
      return "done";
    }

    await failJob(db, job, result?.error ?? "Falha desconhecida no adapter", result?.retryable ?? true);
    return "failed";
  } catch (e) {
    // Unexpected throw (network, decrypt, provider 5xx via api()) → transient, retry.
    const msg = e instanceof Error ? e.message : String(e);
    await failJob(db, job, msg, true);
    return "failed";
  }
}

/** POST / | /drain — claim up to `max` due jobs and process each. */
async function drain(db: SupabaseClient, body: any): Promise<Response> {
  const rawMax = Number(body?.max);
  const max = Number.isFinite(rawMax) && rawMax > 0 ? Math.min(Math.floor(rawMax), 100) : 25;

  const jobs = await claimDueJobs(db, max);
  let done = 0;
  let failed = 0;
  for (const job of jobs) {
    const outcome = await processJob(db, job);
    if (outcome === "done") done++;
    else failed++;
  }
  return ok({ processed: jobs.length, done, failed });
}

// ── enqueue ─────────────────────────────────────────────────────────

/**
 * POST /enqueue — enqueue grant/revoke jobs for every connector mapping that
 * applies to a member's tier. Called by membership hooks (subscription activated/
 * canceled) or a manual "sync now". Body: { orgId, memberId, tierId, action }.
 */
async function enqueue(db: SupabaseClient, body: any): Promise<Response> {
  const orgId = String(body?.orgId ?? "").trim();
  const memberId = String(body?.memberId ?? "").trim();
  const tierId = String(body?.tierId ?? "").trim();
  const action = String(body?.action ?? "").trim();
  if (!orgId) throw new AppError("validation_failed", "orgId é obrigatório", 422);
  if (!memberId) throw new AppError("validation_failed", "memberId é obrigatório", 422);
  if (!tierId) throw new AppError("validation_failed", "tierId é obrigatório", 422);
  if (action !== "grant" && action !== "revoke") {
    throw new AppError("validation_failed", "action deve ser grant|revoke", 422);
  }

  const count = await enqueueForMemberTier(db, { orgId, memberId, tierId, action });
  return ok({ enqueued: count });
}

// ── entrypoint ──────────────────────────────────────────────────────
Deno.serve(async (req) => {
  const pre = handlePreflight(req);
  if (pre) return pre;

  const path = routePath(req);
  const method = req.method.toUpperCase();
  const db = serviceClient();

  try {
    authorizeWorker(req);

    if (path === "/" || path === "/drain") {
      if (method !== "POST") throw new AppError("method_not_allowed", "Use POST", 405);
      return await drain(db, await readJson(req));
    }

    if (path === "/enqueue") {
      if (method !== "POST") throw new AppError("method_not_allowed", "Use POST", 405);
      return await enqueue(db, await readJson(req));
    }

    throw new AppError("not_found", `Rota ${method} ${path} não encontrada`, 404);
  } catch (e) {
    if (e instanceof AppError) return error(e.code, e.message, e.status, e.details);
    return error("internal_error", "Erro interno", 500);
  }
});
