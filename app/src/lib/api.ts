/**
 * API facade — mirrors the public /v1 surface over the mock store.
 * Selectors take `db` so they compose inside useStore(); commands call mutate().
 *
 * ── THIS MODULE IS THE BACKEND SWAP POINT ───────────────────────────────────
 * The whole app reads/writes data only through this facade, so switching to the
 * real backend is a change here (not in the screens). Modes are decided by env
 * (see lib/supabase.ts → hasBackend()):
 *   • No VITE_SUPABASE_URL  → prototype mode (default): everything below runs
 *     against the localStorage store (lib/store.ts). UNCHANGED — do not break it.
 *   • hasBackend()          → real mode:
 *       - READS  go through supabase-js with RLS (scoped to app.current_org()).
 *       - WRITES that touch money or secrets go to the Edge functions at
 *         `${VITE_FUNCTIONS_URL}/v1-...` (service role, org_id filtered server-
 *         side). The checkout/PSP write already routes there via lib/payments.ts
 *         (processCharge → `/checkout`); the platform fee (7,99%) is computed
 *         server-side and NEVER surfaced to a member.
 *
 * Migration is incremental: typed reference implementations of the main reads
 * (listMembers, listTiers, getMember, computeDashboard) and writes (checkout)
 * live in lib/api.remote.ts with the SAME signatures (async; the `db` arg is
 * dropped since data comes from the wire). Migrate a screen by calling the
 * remote twin behind hasBackend() instead of rewriting every selector here.
 */
import type {
  DBSnapshot,
  EventItem,
  Member,
  MemberMetrics,
  MemberProfile,
  Organization,
  PaymentMethod,
  Perk,
  Subscription,
  Tier,
  Transaction,
  Note,
  Interaction,
  Pass,
  Tag,
  PlatformBillingSettings,
  OrgTheme,
  Connection,
  PerkTypeKey,
  LandingBlock,
  Role,
  OrgUser,
  CustomDomain,
} from "@/types/domain";
import { buildDefaultLanding } from "@/lib/blocks";
import { mutate } from "@/lib/store";
import { generateUniqueMemberId, normalizeMemberId } from "@/lib/ids";
import { computeTransaction, monthlyEquivalent, round2 } from "@/lib/billing";
import { signMemberToken } from "@/lib/verify-token";
import { resolvePerks } from "@/lib/entitlements";
import { adminOrg, ownerSession } from "@/lib/session";
import { CONNECTORS, connectorForPerkType, type Connector } from "@/lib/connectors";
import type { VerticalTemplate } from "@/lib/templates";

const NOW = () => new Date().toISOString();
const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 9)}`;

// ── selectors ─────────────────────────────────────────────────────
export const listOrgs = (db: DBSnapshot): Organization[] => db.organizations;
export const getOrg = (db: DBSnapshot, orgId: string) => db.organizations.find((o) => o.id === orgId);
export const getOrgBySlug = (db: DBSnapshot, slug: string) =>
  db.organizations.find((o) => o.slug === slug);

export const listTiers = (db: DBSnapshot, orgId: string): Tier[] =>
  db.tiers.filter((t) => t.orgId === orgId && t.status === "active").sort((a, b) => a.position - b.position);
export const getTier = (db: DBSnapshot, tierId: string | null) =>
  tierId ? db.tiers.find((t) => t.id === tierId) : undefined;

export const listPerks = (db: DBSnapshot, orgId: string): Perk[] =>
  db.perks.filter((p) => p.orgId === orgId);

export const listMembers = (db: DBSnapshot, orgId: string): Member[] =>
  db.members.filter((m) => m.orgId === orgId);
export const getMember = (db: DBSnapshot, id: string) => db.members.find((m) => m.id === id);
export const getMemberByCode = (db: DBSnapshot, code: string) => {
  const norm = normalizeMemberId(code);
  return db.members.find((m) => m.memberId.toUpperCase() === norm);
};
export const getProfile = (db: DBSnapshot, memberId: string): MemberProfile | undefined =>
  db.profiles.find((p) => p.memberId === memberId);
export const getMetrics = (db: DBSnapshot, memberId: string): MemberMetrics | undefined =>
  db.metrics.find((m) => m.memberId === memberId);

export const listTransactions = (db: DBSnapshot, orgId: string): Transaction[] =>
  db.transactions.filter((t) => t.orgId === orgId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
export const listMemberTransactions = (db: DBSnapshot, memberId: string): Transaction[] =>
  db.transactions.filter((t) => t.memberId === memberId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
export const listSubscriptions = (db: DBSnapshot, orgId: string): Subscription[] =>
  db.subscriptions.filter((s) => s.orgId === orgId);
export const getMemberSubscription = (db: DBSnapshot, memberId: string) =>
  db.subscriptions.find((s) => s.memberId === memberId && s.status !== "canceled");

export const listEvents = (db: DBSnapshot, orgId: string): EventItem[] =>
  db.events.filter((e) => e.orgId === orgId);
export const listTickets = (db: DBSnapshot, orgId: string) => db.tickets.filter((t) => t.orgId === orgId);
export const listMemberPasses = (db: DBSnapshot, memberId: string): Pass[] =>
  db.passes.filter((p) => p.memberId === memberId && p.status === "active");
export const listInteractions = (db: DBSnapshot, memberId: string): Interaction[] =>
  db.interactions.filter((i) => i.memberId === memberId).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
export const listNotes = (db: DBSnapshot, memberId: string): Note[] =>
  db.notes.filter((n) => n.memberId === memberId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
export const listTags = (db: DBSnapshot, orgId: string): Tag[] => db.tags.filter((t) => t.orgId === orgId);
export const getMemberTags = (db: DBSnapshot, orgId: string, memberId: string): Tag[] => {
  const ids = db.memberTags.filter((mt) => mt.memberId === memberId).map((mt) => mt.tagId);
  return db.tags.filter((t) => t.orgId === orgId && ids.includes(t.id));
};
export const memberPerks = (db: DBSnapshot, orgId: string, member: Member) =>
  resolvePerks(member.tierId, listTiers(db, orgId), listPerks(db, orgId),
    db.entitlements.filter((e) => e.memberId === member.id));

// ── dashboard aggregation (§10.2) ────────────────────────────────
export interface Dashboard {
  mrr: number;
  monthRevenue: number;
  netOrg: number;
  stanbaseFees: number;
  activeMembers: number;
  newThisMonth: number;
  canceled: number;
  atRisk: number;
  churnRate: number;
  avgTicket: number;
  tierDistribution: { tier: Tier; count: number; mrr: number }[];
}

export function computeDashboard(db: DBSnapshot, orgId: string): Dashboard {
  const members = listMembers(db, orgId);
  const tiers = listTiers(db, orgId);
  const metrics = db.metrics;
  const active = members.filter((m) => m.status === "active" || m.status === "reactivated" || m.status === "past_due");
  const canceled = members.filter((m) => m.status === "canceled").length;
  const atRisk = members.filter((m) => {
    const mm = metrics.find((x) => x.memberId === m.id);
    return (mm?.churnScore ?? 0) >= 70 && m.status !== "canceled";
  }).length;

  const mrr = round2(
    active.reduce((s, m) => s + (metrics.find((x) => x.memberId === m.id)?.mrr ?? 0), 0)
  );

  const now = new Date();
  const monthTx = listTransactions(db, orgId).filter((t) => {
    const d = new Date(t.createdAt);
    return t.status === "paid" && d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
  });
  const monthRevenue = round2(monthTx.reduce((s, t) => s + t.chargedTotal, 0));
  const netOrg = round2(monthTx.reduce((s, t) => s + t.netOrg, 0));
  const stanbaseFees = round2(monthTx.reduce((s, t) => s + t.baseCommission + t.financingSpread, 0));

  const newThisMonth = members.filter((m) => {
    const d = new Date(m.joinedAt);
    return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
  }).length;

  const totalEver = members.length;
  const churnRate = totalEver ? round2(canceled / totalEver) : 0;
  const paidTx = listTransactions(db, orgId).filter((t) => t.status === "paid");
  const avgTicket = paidTx.length ? round2(paidTx.reduce((s, t) => s + t.chargedTotal, 0) / paidTx.length) : 0;

  const tierDistribution = tiers.map((tier) => {
    const inTier = active.filter((m) => m.tierId === tier.id);
    return {
      tier,
      count: members.filter((m) => m.tierId === tier.id).length,
      mrr: round2(inTier.length * monthlyEquivalent(tier.price, tier.period)),
    };
  });

  return {
    mrr, monthRevenue, netOrg, stanbaseFees,
    activeMembers: active.length, newThisMonth, canceled, atRisk,
    churnRate, avgTicket, tierDistribution,
  };
}

// ── commands ──────────────────────────────────────────────────────
function recomputeMemberMetrics(db: DBSnapshot, memberId: string) {
  const txs = db.transactions.filter((t) => t.memberId === memberId && t.status === "paid");
  const member = db.members.find((m) => m.id === memberId);
  const tier = member ? db.tiers.find((t) => t.id === member.tierId) : undefined;
  const mm = db.metrics.find((m) => m.memberId === memberId);
  const ltv = round2(txs.reduce((s, t) => s + t.planValue, 0));
  const totalPaid = round2(txs.reduce((s, t) => s + t.chargedTotal, 0));
  const netOrg = round2(txs.reduce((s, t) => s + t.netOrg, 0));
  const mrr = tier && member && member.status !== "canceled" && member.status !== "lead"
    ? monthlyEquivalent(tier.price, tier.period) : 0;
  if (mm) {
    Object.assign(mm, { ltv, totalPaid, netOrg, mrr, lastActiveAt: NOW() });
  } else {
    db.metrics.push({
      memberId, ltv, totalPaid, netOrg, mrr, engagementScore: 60, churnScore: 25,
      rfm: { r: 5, f: 1, m: 1 }, lastActiveAt: NOW(),
    });
  }
}

export interface CheckoutInput {
  orgId: string;
  tierId: string;
  method: PaymentMethod;
  installments: number;
  name: string;
  email?: string;
  /** if upgrading an existing member, pass their id */
  memberId?: string;
}

export interface CheckoutResult {
  member: Member;
  transaction: Transaction | null;
}

/** Subscribe a member to a tier — the demo's money path (§13 / §12.3). */
export function checkout(input: CheckoutInput): CheckoutResult {
  return mutate((db) => {
    const tier = db.tiers.find((t) => t.id === input.tierId)!;
    let member = input.memberId ? db.members.find((m) => m.id === input.memberId) : undefined;

    if (!member) {
      const taken = new Set(db.members.map((m) => m.memberId));
      const code = generateUniqueMemberId(taken);
      member = {
        id: uid("mem"), memberId: code, orgId: input.orgId, mode: "live", userId: "user_member_demo",
        tierId: tier.id, status: tier.price > 0 ? "active" : "active", joinedAt: NOW(),
        reactivatedAt: null, source: "checkout", gracePeriodEndsAt: null,
      };
      db.members.push(member);
      db.profiles.push({
        memberId: member.id, name: input.name, photoUrl: null, email: input.email ?? null, phone: null, address: null,
        social: {}, attributes: {}, consents: { email: true, whatsapp: false, push: true, photoPublic: false },
      });
      db.interactions.push({
        id: uid("int"), orgId: input.orgId, memberId: member.id, type: "joined",
        title: "Entrou na base", detail: `via checkout — ${tier.name}`, occurredAt: NOW(),
      });
    } else {
      const from = db.tiers.find((t) => t.id === member!.tierId);
      member.tierId = tier.id;
      member.status = "active";
      db.interactions.push({
        id: uid("int"), orgId: input.orgId, memberId: member.id, type: "tier_changed",
        title: `Mudou para ${tier.name}`, detail: from ? `de ${from.name}` : "novo tier", occurredAt: NOW(),
      });
    }

    let transaction: Transaction | null = null;
    if (tier.price > 0) {
      const b = computeTransaction(tier.price, input.method, input.installments, tier.period, db.platformBilling);
      const sub: Subscription = {
        id: uid("sub"), orgId: input.orgId, mode: "live", memberId: member.id, tierId: tier.id,
        period: tier.period, status: "active",
        currentPeriodEnd: new Date(Date.now() + (tier.period === "annual" ? 365 : tier.period === "semiannual" ? 182 : tier.period === "quarterly" ? 91 : 30) * 86400000).toISOString(),
        installments: input.installments, autoRenew: !(tier.installmentsEnabled && input.installments > 1),
        method: input.method, createdAt: NOW(),
      };
      db.subscriptions.push(sub);
      transaction = {
        id: uid("tx"), orgId: input.orgId, mode: "live", memberId: member.id, subscriptionId: sub.id,
        description: `Assinatura ${tier.name}`, method: input.method, installments: input.installments,
        planValue: b.planValue, customerInterest: b.customerInterest, chargedTotal: b.chargedTotal,
        baseCommission: b.baseCommission, pspFee: b.pspFee, pspAnticipationFee: b.pspAnticipationFee,
        financingSpread: b.financingSpread, netOrg: b.netOrg, status: "paid", createdAt: NOW(),
      };
      db.transactions.push(transaction);
      db.interactions.push({
        id: uid("int"), orgId: input.orgId, memberId: member.id, type: "payment_succeeded",
        title: "Pagamento confirmado", detail: `${input.method === "pix" ? "Pix" : "Cartão"}${input.installments > 1 ? ` em ${input.installments}×` : ""}`,
        occurredAt: NOW(),
      });
    }

    // issue membership pass
    if (!db.passes.some((p) => p.memberId === member!.id && p.type === "membership")) {
      db.passes.push({
        id: uid("pass"), orgId: input.orgId, memberId: member.id, type: "membership",
        platform: "apple", serial: member.memberId, authToken: signMemberToken(member.memberId),
        status: "active", createdAt: NOW(),
      });
      db.interactions.push({
        id: uid("int"), orgId: input.orgId, memberId: member.id, type: "passport_issued",
        title: "Passport emitido", detail: "Carteirinha pronta para a Wallet", occurredAt: NOW(),
      });
    }

    recomputeMemberMetrics(db, member.id);
    return { member, transaction };
  });
}

export function cancelMembership(memberId: string): void {
  mutate((db) => {
    const m = db.members.find((x) => x.id === memberId);
    if (m) m.status = "canceled";
    db.subscriptions.filter((s) => s.memberId === memberId).forEach((s) => (s.status = "canceled"));
    db.passes.filter((p) => p.memberId === memberId).forEach((p) => (p.status = "inactive"));
    db.interactions.push({
      id: uid("int"), orgId: m?.orgId ?? "", memberId, type: "subscription_canceled",
      title: "Membership cancelado", detail: "Acesso até o fim do período pago", occurredAt: NOW(),
    });
    recomputeMemberMetrics(db, memberId);
  });
}

// member self-service profile edits (Q36: member edits contacts/consents)
export interface ProfilePatch {
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
  consents?: Partial<MemberProfile["consents"]>;
  attributes?: Record<string, string>;
}
export function updateMemberProfile(memberId: string, patch: ProfilePatch): void {
  mutate((db) => {
    const p = db.profiles.find((x) => x.memberId === memberId);
    if (!p) return;
    if (patch.name !== undefined) p.name = patch.name;
    if (patch.email !== undefined) p.email = patch.email || null;
    if (patch.phone !== undefined) p.phone = patch.phone || null;
    if (patch.address !== undefined) p.address = patch.address || null;
    if (patch.consents) p.consents = { ...p.consents, ...patch.consents };
    if (patch.attributes) p.attributes = { ...p.attributes, ...patch.attributes };
  });
}

// tiers & perks
export function saveTier(orgId: string, tier: Partial<Tier> & { id?: string }): Tier {
  return mutate((db) => {
    if (tier.id) {
      const t = db.tiers.find((x) => x.id === tier.id)!;
      Object.assign(t, tier);
      return t;
    }
    const position = db.tiers.filter((t) => t.orgId === orgId).length;
    const created: Tier = {
      id: uid("tier"), orgId, mode: "live", name: tier.name ?? "Novo tier", description: tier.description ?? "",
      price: tier.price ?? 0, currency: "BRL", period: tier.period ?? "monthly", position,
      color: tier.color ?? "#6d28d9", capacity: tier.capacity ?? null,
      installmentsEnabled: tier.period ? tier.period !== "monthly" : false, perkIds: tier.perkIds ?? [], status: "active",
    };
    db.tiers.push(created);
    return created;
  });
}

export function reorderTiers(orgId: string, orderedIds: string[]): void {
  mutate((db) => {
    orderedIds.forEach((id, i) => {
      const t = db.tiers.find((x) => x.id === id && x.orgId === orgId);
      if (t) t.position = i;
    });
  });
}

export function archiveTier(tierId: string): void {
  mutate((db) => {
    const t = db.tiers.find((x) => x.id === tierId);
    if (t) t.status = "archived";
  });
}

export function togglePerkOnTier(tierId: string, perkId: string): void {
  mutate((db) => {
    const t = db.tiers.find((x) => x.id === tierId);
    if (!t) return;
    t.perkIds = t.perkIds.includes(perkId) ? t.perkIds.filter((p) => p !== perkId) : [...t.perkIds, perkId];
  });
}

export function createPerk(orgId: string, perk: Omit<Perk, "id" | "orgId" | "mode" | "status">): Perk {
  return mutate((db) => {
    const created: Perk = { ...perk, id: uid("perk"), orgId, mode: "live", status: "active" };
    db.perks.push(created);
    return created;
  });
}

// CRM
export function addNote(orgId: string, memberId: string, author: string, body: string): void {
  mutate((db) => {
    db.notes.push({ id: uid("note"), orgId, memberId, author, body, createdAt: NOW() });
    db.interactions.push({
      id: uid("int"), orgId, memberId, type: "note_added", title: "Nota adicionada", detail: body.slice(0, 60), occurredAt: NOW(),
    });
  });
}

export function toggleTag(_orgId: string, memberId: string, tagId: string): void {
  mutate((db) => {
    const exists = db.memberTags.find((mt) => mt.memberId === memberId && mt.tagId === tagId);
    if (exists) db.memberTags = db.memberTags.filter((mt) => !(mt.memberId === memberId && mt.tagId === tagId));
    else db.memberTags.push({ memberId, tagId });
  });
}

// checkin (§9 / §14)
export interface CheckinOutcome {
  result: "ok" | "grace" | "denied" | "already_used";
  member?: Member;
  message: string;
}

export function performCheckin(orgId: string, memberCode: string, operator: string, eventId?: string): CheckinOutcome {
  return mutate((db) => {
    const norm = normalizeMemberId(memberCode);
    const member = db.members.find((m) => m.orgId === orgId && m.memberId.toUpperCase() === norm);
    if (!member) return { result: "denied", message: "Member ID não encontrado." };
    if (member.status === "canceled") return { result: "denied", member, message: "Membership cancelado." };

    // already used ticket for this event?
    if (eventId) {
      // the event must belong to this org — never validate against another org's event
      const event = db.events.find((e) => e.id === eventId && e.orgId === orgId);
      if (!event) return { result: "denied", member, message: "Evento não encontrado nesta organização." };
      const tk = db.tickets.find((t) => t.memberId === member.id && t.eventId === eventId);
      if (tk?.status === "used") return { result: "already_used", member, message: "Ingresso já utilizado (anti-reuso)." };
      if (tk) tk.status = "used";
    }

    const inGrace = member.status === "past_due"; // grace mantém acesso (Q69)
    const result: CheckinOutcome["result"] = inGrace ? "grace" : "ok";
    db.checkins.push({
      id: uid("ck"), orgId, eventId: eventId ?? null, memberId: member.id, ticketId: null,
      operator, at: NOW(), result: inGrace ? "grace" : "ok",
    });
    db.interactions.push({
      id: uid("int"), orgId, memberId: member.id, type: "checkin",
      title: "Check-in realizado", detail: inGrace ? "Em grace (liberado)" : "Presença confirmada", occurredAt: NOW(),
    });
    return {
      result, member,
      message: inGrace ? "Pagamento pendente (grace) — liberado." : "Check-in confirmado.",
    };
  });
}

// theme + platform
export function updateOrgTheme(orgId: string, theme: Partial<OrgTheme>): void {
  mutate((db) => {
    const o = db.organizations.find((x) => x.id === orgId);
    if (o) o.theme = { ...o.theme, ...theme };
  });
}

/** General org config (name, vertical label, tagline, logo wordmark). */
export function updateOrg(orgId: string, patch: Partial<Pick<Organization, "name" | "vertical" | "tagline" | "logoText">>): void {
  mutate((db) => {
    const o = db.organizations.find((x) => x.id === orgId);
    if (o) Object.assign(o, patch);
  });
}

// ── landing page builder (§24) ───────────────────────────────────
export function getLanding(_db: DBSnapshot, org: Organization): LandingBlock[] {
  return org.landing && org.landing.length > 0 ? org.landing : buildDefaultLanding(org);
}

export function updateOrgLanding(orgId: string, blocks: LandingBlock[]): void {
  mutate((db) => {
    const o = db.organizations.find((x) => x.id === orgId);
    if (o) o.landing = blocks;
  });
}

export function resetOrgLanding(orgId: string): void {
  mutate((db) => {
    const o = db.organizations.find((x) => x.id === orgId);
    if (o) o.landing = buildDefaultLanding(o);
  });
}

// ── domínio próprio (Cloudflare for SaaS, §23.1.8) ───────────────
/** O alvo de CNAME que o membership aponta (fallback origin da plataforma). */
export const DOMAIN_CNAME_TARGET = "cname.stanbase.app";

export const listCustomDomains = (db: DBSnapshot, orgId: string): CustomDomain[] =>
  db.customDomains.filter((d) => d.orgId === orgId);

/** Roteamento host → org (domínio próprio ativo). */
export const getOrgByHost = (db: DBSnapshot, host: string): Organization | undefined => {
  const d = db.customDomains.find((x) => x.host === host.toLowerCase() && x.status === "active");
  return d ? db.organizations.find((o) => o.id === d.orgId) : undefined;
};

export function addCustomDomain(orgId: string, host: string): CustomDomain {
  return mutate((db) => {
    const created: CustomDomain = {
      id: uid("dom"), orgId, host: host.toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
      target: "member", status: "pending_dns", cfHostnameId: null, createdAt: NOW(),
    };
    db.customDomains.push(created);
    return created;
  });
}

/** Avança a máquina de estados (mock do ciclo DNS → SSL → ativo). */
export function verifyCustomDomain(id: string): void {
  mutate((db) => {
    const d = db.customDomains.find((x) => x.id === id);
    if (!d) return;
    const next: Record<CustomDomain["status"], CustomDomain["status"]> = {
      pending_dns: "dns_ok",
      dns_ok: "ssl_issued",
      ssl_issued: "active",
      active: "active",
      error: "pending_dns",
      disabled: "pending_dns",
    };
    if (d.status === "dns_ok") d.cfHostnameId = "cf_" + Math.random().toString(36).slice(2, 10);
    d.status = next[d.status];
  });
}

export function removeCustomDomain(id: string): void {
  mutate((db) => {
    db.customDomains = db.customDomains.filter((x) => x.id !== id);
  });
}

export function updateBillingSettings(patch: Partial<PlatformBillingSettings>): void {
  mutate((db) => {
    db.platformBilling = { ...db.platformBilling, ...patch };
  });
}

// ── equipe & permissões (RBAC, Q16) ──────────────────────────────
/** Permission presets per role (granular module perms). */
export const ROLE_PRESETS: Record<Role, string[]> = {
  owner: ["*"],
  admin: ["dashboard", "crm.read", "crm.write", "tiers.write", "page.write", "revenue.read", "events.write", "integrations.write", "communication.write", "theme.write"],
  operator: ["checkin", "validation"],
};

export const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", operator: "Operador (porta)" };
export const ROLE_DESC: Record<Role, string> = {
  owner: "Acesso total, inclusive faturamento, equipe e exclusão.",
  admin: "Gerencia membros, tiers, página, receita e integrações.",
  operator: "Só validação e check-in na portaria — não vê dados financeiros nem a base de membros.",
};

export const listOrgUsers = (db: DBSnapshot, orgId: string): OrgUser[] =>
  db.orgUsers.filter((u) => u.orgId === orgId);

export function inviteOrgUser(orgId: string, name: string, email: string, role: Role): OrgUser {
  return mutate((db) => {
    const created: OrgUser = {
      id: uid("ou"), orgId, userId: uid("user"), name: name || email.split("@")[0],
      email, role, permissions: [...ROLE_PRESETS[role]], status: "invited",
    };
    db.orgUsers.push(created);
    return created;
  });
}

export function updateOrgUserRole(orgUserId: string, role: Role): void {
  mutate((db) => {
    const u = db.orgUsers.find((x) => x.id === orgUserId);
    if (u) {
      u.role = role;
      u.permissions = [...ROLE_PRESETS[role]];
    }
  });
}

export function activateOrgUser(orgUserId: string): void {
  mutate((db) => {
    const u = db.orgUsers.find((x) => x.id === orgUserId);
    if (u) u.status = "active";
  });
}

/** Remove a team member; refuses to remove the last owner. */
export function removeOrgUser(orgUserId: string): { ok: boolean; reason?: string } {
  return mutate((db) => {
    const u = db.orgUsers.find((x) => x.id === orgUserId);
    if (!u) return { ok: false, reason: "Não encontrado." };
    if (u.role === "owner" && db.orgUsers.filter((x) => x.orgId === u.orgId && x.role === "owner").length <= 1) {
      return { ok: false, reason: "Não dá para remover o único owner. Transfira a posse antes." };
    }
    db.orgUsers = db.orgUsers.filter((x) => x.id !== orgUserId);
    return { ok: true };
  });
}

// ── self-service signup: criar conta + org (§5 onboarding) ───────
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return s || "minha-base";
}

function uniqueSlug(db: DBSnapshot, base: string): string {
  let slug = slugify(base);
  let n = 2;
  while (db.organizations.some((o) => o.slug === slug)) slug = `${slugify(base)}-${n++}`;
  return slug;
}

export interface CreateOrgInput {
  ownerName: string;
  ownerEmail: string;
  orgName: string;
  slug?: string;
  vertical: string;
  logoText: string;
  tagline: string;
  theme: OrgTheme;
  tiers: { name: string; price: number; period: Tier["period"]; color: string; capacity: number | null; perkNames: string[] }[];
  perks: { type: PerkTypeKey; name: string; config: Record<string, string | number> }[];
  connectProviders: string[];
}

/** Build a CreateOrgInput pre-filled from a vertical template (the onboarding seed). */
export function inputFromTemplate(t: VerticalTemplate): Omit<CreateOrgInput, "ownerName" | "ownerEmail" | "orgName"> {
  return {
    vertical: t.vertical,
    logoText: t.logoText,
    tagline: t.tagline,
    theme: { ...t.theme },
    tiers: t.tiers.map((ti) => ({ name: ti.name, price: ti.price, period: ti.period, color: ti.color, capacity: ti.capacity, perkNames: [...ti.perks] })),
    perks: t.perks.map((p) => ({ type: p.type, name: p.name, config: { ...p.config } })),
    connectProviders: [...t.suggestedConnections],
  };
}

export interface CreateOrgResult {
  orgId: string;
  slug: string;
}

/** Create a brand-new account + org with tiers/perks/connections, log the owner in. */
export function createAccountAndOrg(input: CreateOrgInput): CreateOrgResult {
  const result = mutate((db) => {
    const userId = uid("user");
    const accountId = uid("acc");
    const orgId = uid("org");
    const slug = uniqueSlug(db, input.slug || input.orgName);
    const now = NOW();

    db.accounts.push({ id: accountId, name: input.ownerName, ownerUserId: userId, createdAt: now });
    db.organizations.push({
      id: orgId, accountId, slug, name: input.orgName, vertical: input.vertical,
      logoText: input.logoText || input.orgName.toLowerCase(), tagline: input.tagline,
      status: "active", theme: input.theme,
      landing: buildDefaultLanding({ name: input.orgName, tagline: input.tagline }),
      createdAt: now,
    });
    db.orgUsers.push({
      id: uid("ou"), orgId, userId, name: input.ownerName, email: input.ownerEmail,
      role: "owner", permissions: ["*"],
    });

    // perks (name → id)
    const perkIdByName = new Map<string, string>();
    for (const p of input.perks) {
      const id = uid("perk");
      perkIdByName.set(p.name, id);
      db.perks.push({ id, orgId, mode: "live", type: p.type, name: p.name, config: p.config, status: "active" });
    }
    // tiers (resolve perk names → ids)
    input.tiers.forEach((ti, i) => {
      db.tiers.push({
        id: uid("tier"), orgId, mode: "live", name: ti.name, description: "",
        price: ti.price, currency: "BRL", period: ti.period, position: i, color: ti.color,
        capacity: ti.capacity, installmentsEnabled: ti.period !== "monthly",
        perkIds: ti.perkNames.map((n) => perkIdByName.get(n)).filter((x): x is string => !!x),
        status: "active",
      });
    });
    // connections (mock-connected)
    for (const provider of input.connectProviders) {
      db.connections.push({
        id: uid("conn"), orgId, provider, status: "connected",
        accountLabel: `${input.orgName} (${provider})`, connectedAt: now, mappings: [],
      });
    }

    return { orgId, slug, userId, accountId };
  });

  ownerSession.set({ userId: result.userId, accountId: result.accountId, name: input.ownerName, email: input.ownerEmail });
  adminOrg.set(result.orgId);
  return { orgId: result.orgId, slug: result.slug };
}

// ── integrações (framework §20.1) ────────────────────────────────
export const listConnectors = (): Connector[] => CONNECTORS;
export const listConnections = (db: DBSnapshot, orgId: string): Connection[] =>
  db.connections.filter((c) => c.orgId === orgId);
export const getConnection = (db: DBSnapshot, orgId: string, provider: string): Connection | undefined =>
  db.connections.find((c) => c.orgId === orgId && c.provider === provider);

export function connectIntegration(
  orgId: string,
  provider: string,
  accountLabel: string,
  credentials: Record<string, string> = {}
): void {
  mutate((db) => {
    const existing = db.connections.find((c) => c.orgId === orgId && c.provider === provider);
    if (existing) {
      existing.status = "connected";
      existing.accountLabel = accountLabel;
      existing.connectedAt = NOW();
      existing.credentials = { ...existing.credentials, ...credentials };
    } else {
      db.connections.push({ id: uid("conn"), orgId, provider, status: "connected", accountLabel, connectedAt: NOW(), mappings: [], credentials });
    }
  });
}

export function disconnectIntegration(orgId: string, provider: string): void {
  mutate((db) => {
    db.connections = db.connections.filter((c) => !(c.orgId === orgId && c.provider === provider));
  });
}

export function setTierMapping(orgId: string, provider: string, tierId: string, resource: string): void {
  mutate((db) => {
    const conn = db.connections.find((c) => c.orgId === orgId && c.provider === provider);
    if (!conn) return;
    const m = conn.mappings.find((x) => x.tierId === tierId);
    if (!resource.trim()) {
      conn.mappings = conn.mappings.filter((x) => x.tierId !== tierId);
    } else if (m) {
      m.resource = resource;
    } else {
      conn.mappings.push({ tierId, resource });
    }
  });
}

/** Provisioning state of a perk: which connector it needs and whether it's connected. */
export interface PerkProvision {
  connector?: Connector;
  requiresConnection: boolean;
  connected: boolean;
}
export function perkProvision(db: DBSnapshot, orgId: string, perkType: PerkTypeKey): PerkProvision {
  const connector = connectorForPerkType(perkType);
  if (!connector) return { connector: undefined, requiresConnection: false, connected: true };
  const conn = getConnection(db, orgId, connector.provider);
  return { connector, requiresConnection: true, connected: conn?.status === "connected" };
}
