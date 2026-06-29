/**
 * Stanbase domain model — TypeScript port of STANBASE.md §25 (modelo de dados).
 * Simplified for the v0 prototype but faithful to the real schema so the mock
 * store can later be swapped for Supabase without reshaping the UI.
 *
 * Decisions baked in (from §30 / PERGUNTAS-ABERTAS):
 *  - `mode` ('live'|'test') on every domain record (Q2).
 *  - Member ID reused on reactivation, history preserved (Q19).
 *  - LTV = plan value w/o financing interest; total_paid & net_org separate (Q29).
 */

export type Mode = "live" | "test";
export type Locale = "pt-BR" | "en-US" | "es";

export type Period = "monthly" | "quarterly" | "semiannual" | "annual" | "one_time" | "lifetime";
export type PaymentMethod = "pix" | "credit_card" | "boleto";

export type MembershipStatus =
  | "lead"
  | "active"
  | "past_due" // inadimplente dentro do grace (mantém acesso — Q27/Q69)
  | "canceled"
  | "reactivated"; // active + flag (Q20); reusa o mesmo Member ID

export type Role = "owner" | "admin" | "operator";

// ── núcleo ────────────────────────────────────────────────────────
export interface Account {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: string;
}

export interface OrgTheme {
  /** semantic-layer overrides (deep-merged over identity defaults). */
  primary?: string;
  accent?: string;
  /** page background per mode (surface/text are derived). */
  bgLight?: string;
  bgDark?: string;
  fontDisplay?: string;
  fontBody?: string;
  defaultMode?: "light" | "dark" | "system";
  darkEnabled?: boolean;
  memberCardArt?: string; // css background for the member card
}

/** A composable block on the member landing page (page builder, §24). */
export interface LandingBlock {
  id: string;
  type: string; // BlockType key (see lib/blocks.ts)
  content: Record<string, any>;
}

export interface Organization {
  id: string;
  accountId: string;
  slug: string;
  name: string;
  vertical: string; // "esports", "car-club", ...
  logoText: string; // brand wordmark (e.g. "aurora")
  tagline: string;
  status: "active" | "suspended" | "deleted";
  theme: OrgTheme;
  /** ordered blocks of the member landing page (undefined = render default). */
  landing?: LandingBlock[];
  createdAt: string;
}

export interface OrgUser {
  id: string;
  orgId: string;
  userId: string;
  name: string;
  email: string;
  role: Role;
  permissions: string[]; // granular module perms; presets per role
  status?: "active" | "invited"; // invited = convite pendente
}

// ── tiers & perks ─────────────────────────────────────────────────
export type PerkTypeKey =
  | "exclusive_content"
  | "event_access"
  | "discord_role"
  | "telegram_group"
  | "whatsapp_group"
  | "discount"
  | "drop"
  | "recognition"
  | "custom";

export interface PerkType {
  key: PerkTypeKey;
  label: string;
  /** which integration this perk needs (null = none). Powers the plug-in catalog (§12.2). */
  integration: string | null;
  description: string;
  /** short config schema → renders a small admin form. */
  configSchema: { key: string; label: string; type: "text" | "number" | "url" | "select"; options?: string[] }[];
  isRevocable: boolean; // Q57
}

export interface Perk {
  id: string;
  orgId: string;
  mode: Mode;
  type: PerkTypeKey;
  name: string;
  config: Record<string, string | number>;
  status: "active" | "archived";
}

export interface Tier {
  id: string;
  orgId: string;
  mode: Mode;
  name: string;
  description: string;
  price: number; // BRL, the plan value (period price)
  currency: "BRL";
  period: Period;
  position: number; // drag-and-drop order
  color: string;
  capacity: number | null; // null = unlimited; e.g. 100 founding seats
  installmentsEnabled: boolean; // false for monthly (§13.3.2)
  perkIds: string[];
  status: "active" | "archived";
}

// ── membros / CRM ─────────────────────────────────────────────────
export interface Member {
  id: string;
  memberId: string; // 8-char public ID (§7)
  orgId: string;
  mode: Mode;
  userId: string | null;
  tierId: string | null;
  status: MembershipStatus;
  joinedAt: string; // "membro desde" — preserved across reactivation
  reactivatedAt: string | null;
  source: string; // checkout / event / import / manual
  gracePeriodEndsAt: string | null; // while in past_due
}

export interface MemberProfile {
  memberId: string; // FK Member.id
  name: string;
  photoUrl: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  social: Record<string, string>;
  attributes: Record<string, string>; // custom per-vertical fields
  consents: { email: boolean; whatsapp: boolean; push: boolean; photoPublic: boolean };
}

export interface MemberMetrics {
  memberId: string;
  ltv: number; // plan value sum, no interest (Q29)
  totalPaid: number; // with interest
  netOrg: number; // net received by org
  mrr: number;
  engagementScore: number; // 0-100
  churnScore: number; // 0-100 (risk)
  rfm: { r: number; f: number; m: number };
  lastActiveAt: string;
}

export interface Tag {
  id: string;
  orgId: string;
  label: string;
  color: string;
}

export interface Note {
  id: string;
  orgId: string;
  memberId: string;
  author: string;
  body: string;
  createdAt: string;
}

export type InteractionType =
  | "subscription_started"
  | "subscription_canceled"
  | "tier_changed"
  | "payment_succeeded"
  | "payment_failed"
  | "checkin"
  | "passport_issued"
  | "note_added"
  | "message_sent"
  | "joined"
  | "gift_sent";

export interface Interaction {
  id: string;
  orgId: string;
  memberId: string;
  type: InteractionType;
  title: string;
  detail: string;
  occurredAt: string;
}

export interface Entitlement {
  id: string;
  orgId: string;
  memberId: string;
  perkId: string;
  source: "tier" | "manual";
  status: "active" | "revoked" | "pending";
  expiresAt: string | null;
}

// ── billing ───────────────────────────────────────────────────────
export interface PlatformBillingSettings {
  baseCommissionRate: number; // 0.0799
  installmentInterestRateAm: number; // 0.0349 a.m.
  maxInstallments: number; // 12
  pspAnticipationRateAm: number; // ~0.0125 a.m.
}

export interface Subscription {
  id: string;
  orgId: string;
  mode: Mode;
  memberId: string;
  tierId: string;
  period: Period;
  status: "active" | "canceled" | "past_due" | "pending";
  currentPeriodEnd: string;
  installments: number; // 1 = à vista
  autoRenew: boolean; // false if installments (§13.3.2)
  method: PaymentMethod;
  createdAt: string;
}

export interface Transaction {
  id: string;
  orgId: string;
  mode: Mode;
  memberId: string;
  subscriptionId: string | null;
  description: string;
  method: PaymentMethod;
  installments: number;
  planValue: number; // discounted plan value — commission base
  customerInterest: number; // financing surcharge (pass-through)
  chargedTotal: number; // planValue + customerInterest (what the member pays)
  baseCommission: number; // 7.99% × planValue
  pspFee: number;
  pspAnticipationFee: number;
  financingSpread: number; // customerInterest − pspAnticipationFee
  netOrg: number; // planValue − baseCommission − pspFee
  status: "paid" | "pending" | "failed" | "refunded";
  createdAt: string;
}

export interface Payout {
  id: string;
  orgId: string;
  amount: number;
  period: string;
  status: "scheduled" | "paid";
  createdAt: string;
}

// ── passport / eventos ────────────────────────────────────────────
export interface Pass {
  id: string;
  orgId: string;
  memberId: string;
  type: "membership" | "ticket";
  platform: "apple" | "google";
  serial: string;
  authToken: string; // signed token embedded in the QR
  status: "active" | "inactive";
  createdAt: string;
}

export interface EventItem {
  id: string;
  orgId: string;
  mode: Mode;
  name: string;
  startsAt: string;
  venue: string;
  capacity: number;
  minTierId: string | null;
  price: number;
}

export interface Ticket {
  id: string;
  orgId: string;
  eventId: string;
  memberId: string;
  status: "valid" | "used";
  passId: string | null;
  createdAt: string;
}

export interface Checkin {
  id: string;
  orgId: string;
  eventId: string | null;
  memberId: string;
  ticketId: string | null;
  operator: string;
  at: string;
  result: "ok" | "grace" | "denied" | "override";
}

// ── integrações (framework de plugins §20.1) ──────────────────────
export type ConnectionStatus = "connected" | "disconnected" | "error";

export interface TierMapping {
  tierId: string;
  resource: string; // ex.: nome do cargo Discord, grupo Telegram
}

export interface Connection {
  id: string;
  orgId: string;
  provider: string; // chave do connector (discord, youtube, ...)
  status: ConnectionStatus;
  accountLabel: string; // "Servidor Aurora", "@aurora", conta conectada
  connectedAt: string | null;
  mappings: TierMapping[]; // tier → recurso externo
  /** credenciais por campo (segredos mascarados; cifradas no servidor em produção). */
  credentials?: Record<string, string>;
}

/** Domínio próprio do membership via Cloudflare for SaaS (§23.1.8). */
export interface CustomDomain {
  id: string;
  orgId: string;
  host: string; // membros.suacomunidade.com (lowercase)
  target: "member" | "verify";
  status: "pending_dns" | "dns_ok" | "ssl_issued" | "active" | "error" | "disabled";
  cfHostnameId: string | null; // Cloudflare custom_hostname id
  createdAt: string;
}

// ── achievements (hall of fame, light) ────────────────────────────
export interface Achievement {
  id: string;
  orgId: string;
  memberId: string;
  label: string;
  earnedAt: string;
}

// ── snapshot do banco mock ────────────────────────────────────────
export interface DBSnapshot {
  version: number;
  platformBilling: PlatformBillingSettings;
  accounts: Account[];
  organizations: Organization[];
  orgUsers: OrgUser[];
  tiers: Tier[];
  perks: Perk[];
  members: Member[];
  profiles: MemberProfile[];
  metrics: MemberMetrics[];
  tags: Tag[];
  memberTags: { memberId: string; tagId: string }[];
  notes: Note[];
  interactions: Interaction[];
  entitlements: Entitlement[];
  subscriptions: Subscription[];
  transactions: Transaction[];
  payouts: Payout[];
  passes: Pass[];
  events: EventItem[];
  tickets: Ticket[];
  checkins: Checkin[];
  achievements: Achievement[];
  connections: Connection[];
  customDomains: CustomDomain[];
}
