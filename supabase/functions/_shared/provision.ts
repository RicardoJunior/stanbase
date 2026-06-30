// Provisioning queue helpers — enqueue grant/revoke work and drain it with
// idempotent, backed-off workers. The membership side (checkout / subscriptions)
// calls enqueueForMemberTier when a member enters/leaves a tier; the
// `integrations-provision` Edge Function drains the queue and calls the adapters.
import { type SupabaseClient } from "@supabase/supabase-js";

export interface ProvisionJobRow {
  id: string;
  org_id: string;
  provider: string;
  member_id: string | null;
  action: "grant" | "revoke";
  resource: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  max_attempts: number;
}

/** Reads a member's provider account ids (discord/google/…) from Supabase Auth identities. */
export async function memberExternalIds(db: SupabaseClient, memberId: string): Promise<Record<string, string>> {
  const { data, error } = await db.rpc("member_provider_ids", { p_member: memberId });
  if (error || !data) return {};
  return data as Record<string, string>;
}

/** Enqueue a single grant/revoke job (deduped on pending (org,provider,member,action,resource)). */
export async function enqueueProvision(
  db: SupabaseClient,
  job: { orgId: string; provider: string; memberId: string | null; action: "grant" | "revoke"; resource: string; payload?: Record<string, unknown> },
): Promise<void> {
  // Avoid piling duplicate pending jobs for the same intent.
  const { data: dupe } = await db
    .from("provision_jobs")
    .select("id")
    .eq("org_id", job.orgId)
    .eq("provider", job.provider)
    .eq("action", job.action)
    .eq("resource", job.resource)
    .eq("member_id", job.memberId)
    .eq("status", "pending")
    .maybeSingle();
  if (dupe) return;

  await db.from("provision_jobs").insert({
    org_id: job.orgId,
    provider: job.provider,
    member_id: job.memberId,
    action: job.action,
    resource: job.resource,
    payload: job.payload ?? {},
  });
}

/**
 * Enqueue grant/revoke for every connector mapping that applies to a member's tier.
 * For each connected provider with a mapping for `tierId`, enqueue one job with the
 * mapped resource. Used when a subscription activates (grant) or cancels (revoke).
 */
export async function enqueueForMemberTier(
  db: SupabaseClient,
  args: { orgId: string; memberId: string; tierId: string; action: "grant" | "revoke" },
): Promise<number> {
  const { data: conns } = await db
    .from("connections")
    .select("provider, status, mappings")
    .eq("org_id", args.orgId)
    .eq("status", "connected");
  if (!conns?.length) return 0;

  let n = 0;
  for (const c of conns) {
    const mapping = ((c.mappings ?? []) as { tierId: string; resource: string }[]).find((m) => m.tierId === args.tierId);
    if (!mapping?.resource) continue;
    await enqueueProvision(db, {
      orgId: args.orgId,
      provider: c.provider,
      memberId: args.memberId,
      action: args.action,
      resource: mapping.resource,
    });
    n++;
  }
  return n;
}

/** Claim up to `max` due jobs (status=pending, run_after<=now) and mark them processing. */
export async function claimDueJobs(db: SupabaseClient, max: number): Promise<ProvisionJobRow[]> {
  const { data: due } = await db
    .from("provision_jobs")
    .select("*")
    .eq("status", "pending")
    .lte("run_after", new Date().toISOString())
    .order("run_after", { ascending: true })
    .limit(max);
  if (!due?.length) return [];

  const claimed: ProvisionJobRow[] = [];
  for (const job of due as ProvisionJobRow[]) {
    // Optimistic claim: only take it if still pending (guards concurrent drains).
    const { data, error } = await db
      .from("provision_jobs")
      .update({ status: "processing", attempts: job.attempts + 1 })
      .eq("id", job.id)
      .eq("status", "pending")
      .select("*")
      .maybeSingle();
    if (!error && data) claimed.push(data as ProvisionJobRow);
  }
  return claimed;
}

export async function completeJob(db: SupabaseClient, id: string): Promise<void> {
  await db.from("provision_jobs").update({ status: "done", last_error: null }).eq("id", id);
}

/** Mark a job failed; reschedule with exponential backoff unless attempts exhausted. */
export async function failJob(db: SupabaseClient, job: ProvisionJobRow, error: string, retryable: boolean): Promise<void> {
  const exhausted = !retryable || job.attempts >= job.max_attempts;
  if (exhausted) {
    await db.from("provision_jobs").update({ status: "failed", last_error: error }).eq("id", job.id);
    return;
  }
  const backoffSec = Math.min(3600, 2 ** job.attempts * 30); // 30s,60s,120s… capped 1h
  const runAfter = new Date(Date.now() + backoffSec * 1000).toISOString();
  await db.from("provision_jobs").update({ status: "pending", last_error: error, run_after: runAfter }).eq("id", job.id);
}
