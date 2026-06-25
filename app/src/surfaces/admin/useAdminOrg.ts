import { useStore } from "@/lib/store";
import { listOrgs } from "@/lib/api";
import { adminOrg } from "@/lib/session";

/** Resolve the admin's active org (org selector — 1 Conta ↔ N orgs, §2). */
export function useAdminOrg() {
  const orgs = useStore(listOrgs);
  const session = adminOrg.use();
  const orgId = session && orgs.some((o) => o.id === session) ? session : orgs[0]?.id ?? null;
  const org = orgs.find((o) => o.id === orgId) ?? null;
  return { org, orgId, orgs, setOrg: adminOrg.set };
}
