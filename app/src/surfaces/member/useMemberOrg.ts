import { useParams } from "react-router-dom";
import { useStore } from "@/lib/store";
import { getOrgBySlug, getMember } from "@/lib/api";
import { memberSession } from "@/lib/session";

/** Resolve the member-front org by slug + the currently "logged-in" member persona. */
export function useMemberOrg() {
  const { orgSlug } = useParams();
  const db = useStore((d) => d);
  const org = orgSlug ? getOrgBySlug(db, orgSlug) : undefined;
  const memberId = memberSession.use();
  const member = memberId ? getMember(db, memberId) : undefined;
  const validMember = member && org && member.orgId === org.id ? member : undefined;
  return { org, member: validMember, db };
}
