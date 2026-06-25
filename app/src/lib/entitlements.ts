/**
 * Entitlement resolver — STANBASE.md §12.2/§12.3.
 *  - Tiers accumulate: a tier inherits the perks of all lower tiers (by position).
 *  - Grandfathering of perks = members lose perks removed from their tier by
 *    default (Q52) — so the resolver always reads the *current* tier set.
 *  - Manual (courtesy) entitlements are added on top.
 */
import type { Entitlement, Perk, Tier } from "@/types/domain";

/** Perk ids a member is entitled to from their tier (with accumulation). */
export function perkIdsForTier(tierId: string | null, tiers: Tier[]): string[] {
  if (!tierId) return [];
  const tier = tiers.find((t) => t.id === tierId);
  if (!tier) return [];
  const ids = new Set<string>();
  for (const t of tiers) {
    if (t.status === "active" && t.position <= tier.position) {
      t.perkIds.forEach((p) => ids.add(p));
    }
  }
  return [...ids];
}

/** Resolve the concrete, active perks for a member's current tier + manual grants. */
export function resolvePerks(
  tierId: string | null,
  tiers: Tier[],
  perks: Perk[],
  manualEntitlements: Entitlement[] = []
): Perk[] {
  const ids = new Set(perkIdsForTier(tierId, tiers));
  for (const e of manualEntitlements) {
    if (e.status === "active") ids.add(e.perkId);
  }
  return perks.filter((p) => ids.has(p.id) && p.status === "active");
}

/** Does a content/feature gated at `minTierId` open for a member on `memberTierId`? */
export function meetsMinTier(memberTierId: string | null, minTierId: string | null, tiers: Tier[]): boolean {
  if (!minTierId) return true;
  if (!memberTierId) return false;
  const a = tiers.find((t) => t.id === memberTierId)?.position ?? -1;
  const b = tiers.find((t) => t.id === minTierId)?.position ?? Infinity;
  return a >= b;
}
