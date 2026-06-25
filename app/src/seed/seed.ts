/**
 * Demo seed — "Aurora Esports" (vertical: esports). Builds a full DBSnapshot:
 * 4 tiers, 12 pluggable perks, ~40 members with real transactions (using the
 * billing engine), lifecycle variety, an event with tickets, passes and a
 * timeline. Deterministic structure; Member IDs are CSPRNG (random each reset,
 * as the spec intends).
 */
import {
  Account,
  Achievement,
  Checkin,
  DBSnapshot,
  EventItem,
  Interaction,
  Member,
  MemberMetrics,
  MemberProfile,
  Organization,
  OrgUser,
  Pass,
  Payout,
  Perk,
  Subscription,
  Tag,
  Ticket,
  Tier,
  Transaction,
  Period,
  PaymentMethod,
  MembershipStatus,
} from "@/types/domain";
import { generateUniqueMemberId } from "@/lib/ids";
import { computeTransaction, monthlyEquivalent, DEFAULT_BILLING, round2 } from "@/lib/billing";
import { signMemberToken } from "@/lib/verify-token";

const NOW = new Date("2026-06-25T12:00:00Z").getTime();
const DAY = 86400000;
const iso = (epoch: number) => new Date(epoch).toISOString();
const daysAgo = (d: number) => iso(NOW - d * DAY);
const daysAhead = (d: number) => iso(NOW + d * DAY);

// small seeded PRNG so the structure (who/what) is reproducible across resets
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260625);
const pick = <T,>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];
const chance = (p: number) => rng() < p;

const FIRST = [
  "Lucas", "Ana", "Pedro", "Mariana", "Gabriel", "Júlia", "Rafael", "Beatriz", "Felipe", "Larissa",
  "Bruno", "Camila", "Diego", "Fernanda", "Thiago", "Letícia", "Matheus", "Carolina", "Vinícius", "Amanda",
  "Gustavo", "Isabela", "Rodrigo", "Natália", "Leonardo", "Sofia", "André", "Helena", "Caio", "Manuela",
  "Henrique", "Yasmin", "Murilo", "Bianca", "Otávio", "Lívia", "Davi", "Clara", "Enzo", "Valentina",
];
const LAST = ["Silva", "Souza", "Oliveira", "Santos", "Costa", "Pereira", "Almeida", "Ferreira", "Rocha", "Lima", "Carvalho", "Gomes"];
const GAMERTAGS = ["zr0", "kpz", "fallen1", "nyx", "vortex", "drk", "luckz", "shadow", "blink", "phantom", "rzr", "exe"];

let seq = 0;
const sid = (p: string) => `${p}_${(++seq).toString().padStart(3, "0")}`;

export function buildSeed(): DBSnapshot {
  seq = 0;
  const orgId = "org_aurora";
  const mode = "live" as const;

  const account: Account = {
    id: "acc_aurora",
    name: "Aurora Holding",
    ownerUserId: "user_owner",
    createdAt: daysAgo(540),
  };

  const org: Organization = {
    id: orgId,
    accountId: account.id,
    slug: "aurora",
    name: "Aurora Esports",
    vertical: "esports",
    logoText: "aurora",
    tagline: "A nação Aurora, mais perto do que nunca.",
    status: "active",
    theme: {
      primary: "#6d28d9",
      accent: "#b8965a",
      defaultMode: "dark",
      darkEnabled: true,
      memberCardArt: "radial-gradient(130% 150% at 80% 0%, #2a1d52 0%, #15140f 58%)",
    },
    createdAt: daysAgo(540),
  };

  const orgUsers: OrgUser[] = [
    { id: "ou_1", orgId, userId: "user_owner", name: "Ricardo Júnior", email: "ricardo@aurora.gg", role: "owner", permissions: ["*"] },
    { id: "ou_2", orgId, userId: "user_admin", name: "Marina Alves", email: "marina@aurora.gg", role: "admin", permissions: ["crm.read", "crm.write", "tiers.write", "revenue.read"] },
    { id: "ou_3", orgId, userId: "user_op", name: "Equipe Portaria", email: "porta@aurora.gg", role: "operator", permissions: ["checkin"] },
  ];

  // ── perks (12, pluggable) ──────────────────────────────────────
  const perk = (type: Perk["type"], name: string, config: Perk["config"]): Perk => ({
    id: sid("perk"), orgId, mode, type, name, config, status: "active",
  });
  const pVod = perk("exclusive_content", "VOD dos campeonatos", { title: "VOD dos campeonatos", provider: "YouTube", url: "https://youtube.com/aurora" });
  const pBackstage = perk("exclusive_content", "Bastidores da line", { title: "Bastidores", provider: "Twitch", url: "https://twitch.tv/aurora" });
  const pRoleMember = perk("discord_role", "Cargo Membro", { role: "Membro" });
  const pRoleVip = perk("discord_role", "Cargo VIP", { role: "VIP" });
  const pTelegram = perk("telegram_group", "Grupo fechado", { group: "Aurora Insiders" });
  const pWhats = perk("whatsapp_group", "Comunidade VIP", { group: "Aurora VIP" });
  const pDiscShop = perk("discount", "20% na loja oficial", { label: "Loja oficial", percent: 20 });
  const pDiscTicket = perk("discount", "Desconto em ingressos", { label: "Ingressos", percent: 15 });
  const pDrop = perk("drop", "Camiseta oficial", { item: "Jersey Aurora 2026" });
  const pBadge = perk("recognition", "Badge Founder", { badge: "Founder" });
  const pLote = perk("event_access", "Lote de membro", { kind: "Lote de membro" });
  const pMeet = perk("custom", "Meet & greet com a line", { label: "Meet & greet" });
  const perks = [pVod, pBackstage, pRoleMember, pRoleVip, pTelegram, pWhats, pDiscShop, pDiscTicket, pDrop, pBadge, pLote, pMeet];

  // ── tiers (4; perks accumulate by position) ────────────────────
  const tiers: Tier[] = [
    {
      id: "tier_fa", orgId, mode, name: "Fã", description: "Entrada na nação Aurora, de graça.",
      price: 0, currency: "BRL", period: "monthly", position: 0, color: "#5d584c", capacity: null,
      installmentsEnabled: false, perkIds: [pRoleMember.id], status: "active",
    },
    {
      id: "tier_membro", orgId, mode, name: "Membro", description: "VODs, comunidade e descontos.",
      price: 19, currency: "BRL", period: "monthly", position: 1, color: "#6d28d9", capacity: null,
      installmentsEnabled: false, perkIds: [pVod.id, pTelegram.id, pDiscShop.id], status: "active",
    },
    {
      id: "tier_vip", orgId, mode, name: "VIP", description: "Bastidores, cargo VIP e prioridade em ingressos.",
      price: 49, currency: "BRL", period: "monthly", position: 2, color: "#b8965a", capacity: null,
      installmentsEnabled: false, perkIds: [pBackstage.id, pRoleVip.id, pWhats.id, pDiscTicket.id], status: "active",
    },
    {
      id: "tier_founder", orgId, mode, name: "Founder", description: "Lote fundador: drop, badge e meet & greet. 100 vagas.",
      price: 600, currency: "BRL", period: "annual", position: 3, color: "#e7d3a6", capacity: 100,
      installmentsEnabled: true, perkIds: [pDrop.id, pBadge.id, pLote.id, pMeet.id], status: "active",
    },
  ];

  const tags: Tag[] = [
    { id: "tag_super", orgId, label: "Superfã", color: "#b8965a" },
    { id: "tag_novo", orgId, label: "Recém-chegado", color: "#6d28d9" },
    { id: "tag_risco", orgId, label: "Em risco", color: "#b4453a" },
    { id: "tag_camarote", orgId, label: "Presença VIP", color: "#3f7d4e" },
  ];

  // ── members ────────────────────────────────────────────────────
  const taken = new Set<string>();
  const members: Member[] = [];
  const profiles: MemberProfile[] = [];
  const metrics: MemberMetrics[] = [];
  const subscriptions: Subscription[] = [];
  const transactions: Transaction[] = [];
  const interactions: Interaction[] = [];
  const memberTags: { memberId: string; tagId: string }[] = [];
  const passes: Pass[] = [];
  const achievements: Achievement[] = [];

  const tierWeights: { tier: Tier; w: number }[] = [
    { tier: tiers[0], w: 0.30 },
    { tier: tiers[1], w: 0.34 },
    { tier: tiers[2], w: 0.22 },
    { tier: tiers[3], w: 0.14 },
  ];
  function weightedTier(): Tier {
    const r = rng();
    let acc = 0;
    for (const tw of tierWeights) {
      acc += tw.w;
      if (r <= acc) return tw.tier;
    }
    return tiers[1];
  }

  const COUNT = 40;
  for (let i = 0; i < COUNT; i++) {
    const memId = generateUniqueMemberId(taken);
    taken.add(memId);
    const id = sid("mem");
    const first = FIRST[i % FIRST.length];
    const last = pick(LAST);
    const name = `${first} ${last}`;
    let tier = weightedTier();

    // lifecycle distribution
    const roll = rng();
    let status: MembershipStatus = "active";
    if (tier.price === 0) status = chance(0.2) ? "lead" : "active";
    else if (roll < 0.1) status = "past_due";
    else if (roll < 0.2) status = "canceled";
    else if (roll < 0.27) status = "reactivated";

    const tenureDays = 5 + Math.floor(rng() * 530);
    const joinedAt = daysAgo(tenureDays);
    const reactivatedAt = status === "reactivated" ? daysAgo(Math.floor(tenureDays * 0.3)) : null;
    const method: PaymentMethod = chance(0.62) ? "pix" : "credit_card";
    const gracePeriodEndsAt = status === "past_due" ? daysAhead(1 + Math.floor(rng() * 2)) : null;

    members.push({
      id, memberId: memId, orgId, mode, userId: i === 0 ? "user_member_demo" : null,
      tierId: tier.id, status, joinedAt, reactivatedAt, source: pick(["checkout", "event", "import", "manual"]),
      gracePeriodEndsAt,
    });

    const gamertag = pick(GAMERTAGS) + Math.floor(rng() * 90 + 10);
    profiles.push({
      memberId: id,
      name,
      photoUrl: null,
      email: chance(0.85) ? `${first.toLowerCase()}.${last.toLowerCase()}@email.com` : null,
      phone: chance(0.7) ? `+55 11 9${Math.floor(rng() * 9000 + 1000)}-${Math.floor(rng() * 9000 + 1000)}` : null,
      social: { discord: `${first.toLowerCase()}#${Math.floor(rng() * 9000 + 1000)}` },
      attributes: { gamertag, jogo_principal: pick(["CS2", "Valorant", "LoL", "Rocket League"]) },
      consents: { email: chance(0.8), whatsapp: chance(0.6), push: chance(0.7), photoPublic: chance(0.25) },
    });

    // transactions + subscription
    let ltv = 0, totalPaid = 0, netOrg = 0;
    const isPaid = tier.price > 0 && status !== "lead";
    if (isPaid) {
      const tenureMonths = Math.max(1, Math.floor(tenureDays / 30));
      const period: Period = tier.period;
      const installments = tier.installmentsEnabled && chance(0.5) ? pick([3, 6, 10, 12]) : 1;
      const autoRenew = !(tier.installmentsEnabled && installments > 1);

      // number of past charges: monthly tiers renew; annual once (per year of tenure)
      const charges = period === "annual" ? Math.max(1, Math.floor(tenureMonths / 12)) : Math.min(tenureMonths, 18);
      const lastCanceledEarly = status === "canceled";
      const stepDays = period === "annual" ? 365 : 30;
      // anchor the most recent paid charge near "now" so it lands in the current month
      const recentOffset = lastCanceledEarly ? 45 + Math.floor(rng() * 30) : Math.floor(rng() * 14);
      for (let c = 0; c < charges; c++) {
        const b = computeTransaction(tier.price, method, installments, period, DEFAULT_BILLING);
        ltv += b.planValue;
        totalPaid += b.chargedTotal;
        netOrg += b.netOrg;
        const when = daysAgo((charges - 1 - c) * stepDays + recentOffset);
        transactions.push({
          id: sid("tx"), orgId, mode, memberId: id, subscriptionId: null,
          description: `Assinatura ${tier.name} (${period === "annual" ? "anual" : "mensal"})`,
          method, installments, planValue: b.planValue, customerInterest: b.customerInterest,
          chargedTotal: b.chargedTotal, baseCommission: b.baseCommission, pspFee: b.pspFee,
          pspAnticipationFee: b.pspAnticipationFee, financingSpread: b.financingSpread, netOrg: b.netOrg,
          status: c === charges - 1 && status === "past_due" ? "failed" : "paid",
          createdAt: when,
        });
      }

      const sub: Subscription = {
        id: sid("sub"), orgId, mode, memberId: id, tierId: tier.id, period,
        status: status === "canceled" ? "canceled" : status === "past_due" ? "past_due" : "active",
        currentPeriodEnd: lastCanceledEarly ? daysAgo(10) : daysAhead(period === "annual" ? 200 : 12),
        installments, autoRenew, method, createdAt: joinedAt,
      };
      subscriptions.push(sub);
      transactions.filter((t) => t.memberId === id).forEach((t) => (t.subscriptionId = sub.id));

      interactions.push({
        id: sid("int"), orgId, memberId: id, type: "subscription_started",
        title: `Assinou ${tier.name}`, detail: `via ${method === "pix" ? "Pix" : "cartão"}${installments > 1 ? ` em ${installments}×` : ""}`,
        occurredAt: joinedAt,
      });

      // membership pass for active/past_due paid members
      if (status === "active" || status === "past_due" || status === "reactivated") {
        passes.push({
          id: sid("pass"), orgId, memberId: id, type: "membership", platform: chance(0.5) ? "apple" : "google",
          serial: memId, authToken: signMemberToken(memId), status: "active", createdAt: joinedAt,
        });
        interactions.push({
          id: sid("int"), orgId, memberId: id, type: "passport_issued",
          title: "Passport emitido", detail: "Carteirinha adicionada à Wallet", occurredAt: daysAgo(tenureDays - 1),
        });
      }
    } else {
      tier = tiers[0];
      interactions.push({
        id: sid("int"), orgId, memberId: id, type: "joined", title: "Entrou na base",
        detail: status === "lead" ? "Lead — sem assinatura" : "Tier gratuito", occurredAt: joinedAt,
      });
    }

    // metrics
    const recencyDays = Math.floor(rng() * (status === "canceled" ? 120 : 30));
    const engagementScore = Math.max(5, Math.min(98, Math.round((tier.position + 1) * 22 + rng() * 20 - recencyDays)));
    let churnScore = Math.round(20 + rng() * 30);
    if (status === "past_due") churnScore = Math.round(70 + rng() * 25);
    if (status === "canceled") churnScore = 100;
    if (status === "reactivated") churnScore = Math.round(35 + rng() * 20);

    metrics.push({
      memberId: id,
      ltv: round2(ltv),
      totalPaid: round2(totalPaid),
      netOrg: round2(netOrg),
      mrr: status === "canceled" || status === "lead" ? 0 : monthlyEquivalent(tier.price, tier.period),
      engagementScore,
      churnScore,
      rfm: { r: Math.ceil((5 - Math.min(4, recencyDays / 7))), f: Math.min(5, 1 + Math.floor(ltv / 200)), m: Math.min(5, 1 + Math.floor(ltv / 250)) },
      lastActiveAt: daysAgo(recencyDays),
    });

    // tags
    if (engagementScore > 80 && ltv > 300) memberTags.push({ memberId: id, tagId: "tag_super" });
    if (tenureDays < 45) memberTags.push({ memberId: id, tagId: "tag_novo" });
    if (churnScore > 70) memberTags.push({ memberId: id, tagId: "tag_risco" });
    if (tier.position >= 2) memberTags.push({ memberId: id, tagId: "tag_camarote" });

    // achievements (hall of fame, light)
    if (tier.id === "tier_founder") achievements.push({ id: sid("ach"), orgId, memberId: id, label: "Fundador", earnedAt: joinedAt });
    if (tenureDays > 365) achievements.push({ id: sid("ach"), orgId, memberId: id, label: "1 ano de casa", earnedAt: daysAgo(tenureDays - 365) });
  }

  // ── event + tickets + checkins ────────────────────────────────
  const events: EventItem[] = [
    { id: "evt_major", orgId, mode, name: "Aurora Major — Finais", startsAt: daysAhead(21), venue: "Allianz Parque, São Paulo", capacity: 500, minTierId: null, price: 80 },
  ];
  const tickets: Ticket[] = [];
  const checkins: Checkin[] = [];
  const paidActive = members.filter((m) => m.status === "active" || m.status === "reactivated").slice(0, 14);
  for (const m of paidActive) {
    if (!chance(0.55)) continue;
    const tk: Ticket = { id: sid("tk"), orgId, eventId: events[0].id, memberId: m.id, status: "valid", passId: null, createdAt: daysAgo(5) };
    const pass: Pass = { id: sid("pass"), orgId, memberId: m.id, type: "ticket", platform: chance(0.5) ? "apple" : "google", serial: m.memberId + "-T", authToken: signMemberToken(m.memberId), status: "active", createdAt: daysAgo(5) };
    tk.passId = pass.id;
    tickets.push(tk);
    passes.push(pass);
  }

  // ── payouts ───────────────────────────────────────────────────
  const payouts: Payout[] = [
    { id: sid("po"), orgId, amount: round2(transactions.filter((t) => t.status === "paid").reduce((s, t) => s + t.netOrg, 0) * 0.12), period: "Jun/2026 (parcial)", status: "scheduled", createdAt: daysAgo(1) },
    { id: sid("po"), orgId, amount: round2(transactions.filter((t) => t.status === "paid").reduce((s, t) => s + t.netOrg, 0) * 0.18), period: "Mai/2026", status: "paid", createdAt: daysAgo(25) },
  ];

  return {
    version: 2,
    platformBilling: DEFAULT_BILLING,
    accounts: [account],
    organizations: [org],
    orgUsers,
    tiers,
    perks,
    members,
    profiles,
    metrics,
    tags,
    memberTags,
    notes: [
      { id: sid("note"), orgId, memberId: members[0].id, author: "Marina Alves", body: "Super engajado no Discord, indicou 3 amigos.", createdAt: daysAgo(8) },
    ],
    interactions,
    entitlements: [],
    subscriptions,
    transactions,
    payouts,
    passes,
    events,
    tickets,
    checkins,
    achievements,
  };
}
