/**
 * API facade — mirrors the public /v1 surface (§21) over the mock store.
 * Selectors take `db` so they compose inside useStore(); commands call mutate().
 * REPLAN: reimplement against supabase-js + Edge `/v1` with identical signatures.
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
} from "@/types/domain";
import { mutate } from "@/lib/store";
import { generateUniqueMemberId, normalizeMemberId } from "@/lib/ids";
import { computeTransaction, monthlyEquivalent, round2 } from "@/lib/billing";
import { signMemberToken } from "@/lib/verify-token";
import { resolvePerks } from "@/lib/entitlements";

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
        memberId: member.id, name: input.name, photoUrl: null, email: input.email ?? null, phone: null,
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
      id: uid("int"), orgId: m?.orgId ?? "", memberId, type: "tier_changed",
      title: "Membership cancelado", detail: "Acesso até o fim do período pago", occurredAt: NOW(),
    });
    recomputeMemberMetrics(db, memberId);
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

export function updateBillingSettings(patch: Partial<PlatformBillingSettings>): void {
  mutate((db) => {
    db.platformBilling = { ...db.platformBilling, ...patch };
  });
}
