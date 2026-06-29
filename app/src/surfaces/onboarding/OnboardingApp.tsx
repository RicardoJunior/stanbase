import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowLeft, ArrowRight, Check, Plus, Trash2, Gift, Plug, Sparkles, ExternalLink, PartyPopper,
} from "lucide-react";
import { TEMPLATES, getTemplate, type PerkTemplate } from "@/lib/templates";
import { inputFromTemplate, createAccountAndOrg, slugify } from "@/lib/api";
import { getConnector, CONNECTORS } from "@/lib/connectors";
import { BRL, installmentsAllowed, installmentOptions } from "@/lib/billing";
import { Button, Input, Select, Field, Label, Switch, ColorField } from "@/components/ui";
import { MemberCard } from "@/components/MemberCard";
import { periodLabel } from "@/surfaces/admin/shared";
import type { OrgTheme, Period, PerkTypeKey } from "@/types/domain";

interface TierDraft {
  name: string; price: number; period: Period; color: string; capacity: number | null; perkNames: string[];
}
interface Draft {
  ownerName: string; ownerEmail: string; orgName: string; slug: string;
  templateKey: string | null;
  vertical: string; logoText: string; tagline: string; theme: OrgTheme;
  tiers: TierDraft[]; perks: PerkTemplate[]; connectProviders: string[];
}

const EMPTY: Draft = {
  ownerName: "", ownerEmail: "", orgName: "", slug: "",
  templateKey: null, vertical: "", logoText: "", tagline: "",
  theme: { primary: "#6d28d9", accent: "#b8965a", defaultMode: "dark", darkEnabled: true },
  tiers: [], perks: [], connectProviders: [],
};

const STEPS = ["Você", "Vertical", "Marca", "Tiers", "Perks", "Publicar"];
const PERIODS: Period[] = ["monthly", "quarterly", "semiannual", "annual"];

export default function OnboardingApp() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [published, setPublished] = useState<{ slug: string } | null>(null);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const pickTemplate = (key: string) => {
    const t = getTemplate(key)!;
    const base = inputFromTemplate(t);
    setDraft((d) => ({
      ...d,
      templateKey: key,
      vertical: base.vertical,
      logoText: d.orgName ? d.orgName.toLowerCase() : t.logoText,
      tagline: base.tagline,
      theme: base.theme,
      tiers: base.tiers,
      perks: base.perks,
      connectProviders: base.connectProviders,
    }));
  };

  const canNext = (): boolean => {
    if (step === 0) return !!draft.ownerName.trim() && !!draft.orgName.trim();
    if (step === 1) return !!draft.templateKey;
    if (step === 3) return draft.tiers.length > 0;
    return true;
  };

  const publish = () => {
    const res = createAccountAndOrg({
      ownerName: draft.ownerName.trim(),
      ownerEmail: draft.ownerEmail.trim(),
      orgName: draft.orgName.trim(),
      slug: draft.slug || slugify(draft.orgName),
      vertical: draft.vertical,
      logoText: draft.logoText || draft.orgName.toLowerCase(),
      tagline: draft.tagline,
      theme: draft.theme,
      tiers: draft.tiers,
      perks: draft.perks,
      connectProviders: draft.connectProviders,
    });
    setPublished({ slug: res.slug });
  };

  if (published) return <Success slug={published.slug} orgName={draft.orgName} navigate={navigate} />;

  return (
    <div className="min-h-screen bg-bg text-content" data-theme="light">
      <header className="h-16 border-b border-line flex items-center justify-between px-7">
        <Link to="/" className="brand-logo text-xl">stan<b>base</b></Link>
        <span className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-muted">monte seu membership</span>
      </header>

      <div className="max-w-3xl mx-auto px-6 py-8">
        {/* stepper */}
        <div className="flex items-center gap-2 mb-8">
          {STEPS.map((label, i) => (
            <div key={label} className="flex items-center gap-2 flex-1 last:flex-none">
              <button
                onClick={() => i < step && setStep(i)}
                className={`flex items-center gap-2 ${i <= step ? "" : "opacity-40"} ${i < step ? "cursor-pointer" : ""}`}
              >
                <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-mono ${i < step ? "bg-[var(--color-primary)] text-white" : i === step ? "border-2 border-[var(--color-primary)]" : "border border-line"}`}>
                  {i < step ? <Check size={12} /> : i + 1}
                </span>
                <span className="text-xs hidden sm:inline">{label}</span>
              </button>
              {i < STEPS.length - 1 && <span className="h-px bg-line flex-1" />}
            </div>
          ))}
        </div>

        {step === 0 && <StepYou draft={draft} set={set} />}
        {step === 1 && <StepVertical draft={draft} pick={pickTemplate} />}
        {step === 2 && <StepBrand draft={draft} set={set} />}
        {step === 3 && <StepTiers draft={draft} set={set} />}
        {step === 4 && <StepPerks draft={draft} set={set} />}
        {step === 5 && <StepReview draft={draft} />}

        {/* nav */}
        <div className="flex items-center justify-between mt-8 pt-5 border-t border-line">
          <Button variant="ghost" onClick={() => (step === 0 ? navigate("/") : setStep(step - 1))}>
            <ArrowLeft size={15} /> {step === 0 ? "Sair" : "Voltar"}
          </Button>
          {step < STEPS.length - 1 ? (
            <Button onClick={() => setStep(step + 1)} disabled={!canNext()}>
              Continuar <ArrowRight size={15} />
            </Button>
          ) : (
            <Button onClick={publish}>
              <Sparkles size={15} /> Publicar minha base
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── steps ───────────────────────────────────────────────────── */
function StepYou({ draft, set }: { draft: Draft; set: (p: Partial<Draft>) => void }) {
  return (
    <div>
      <Heading eyebrow="Passo 1" title="Vamos começar" desc="Quem é você e qual o nome da sua comunidade." />
      <div className="grid sm:grid-cols-2 gap-x-4">
        <Field label="Seu nome"><Input value={draft.ownerName} onChange={(e) => set({ ownerName: e.target.value })} placeholder="Ricardo Júnior" /></Field>
        <Field label="Seu e-mail"><Input value={draft.ownerEmail} onChange={(e) => set({ ownerEmail: e.target.value })} placeholder="voce@email.com" /></Field>
        <div className="sm:col-span-2">
          <Field label="Nome da comunidade" hint={draft.orgName ? `Endereço: /m/${slugify(draft.orgName)}` : "Vira o endereço público da sua base."}>
            <Input value={draft.orgName} onChange={(e) => set({ orgName: e.target.value, slug: slugify(e.target.value) })} placeholder="Aurora Esports" />
          </Field>
        </div>
      </div>
    </div>
  );
}

function StepVertical({ draft, pick }: { draft: Draft; pick: (key: string) => void }) {
  return (
    <div>
      <Heading eyebrow="Passo 2" title="Que tipo de comunidade?" desc="Escolha um modelo — já vem com tiers, perks e marca prontos pra editar." />
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {TEMPLATES.map((t) => {
          const on = draft.templateKey === t.key;
          return (
            <button
              key={t.key}
              onClick={() => pick(t.key)}
              className={`text-left rounded-2xl border p-4 transition-colors ${on ? "border-[var(--color-primary)] bg-[var(--color-primary)]/5" : "border-line hover:border-content/30"}`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className="w-3 h-3 rounded-full" style={{ background: t.theme.primary }} />
                <span className="font-display text-lg">{t.label}</span>
                {on && <Check size={15} className="ml-auto text-[var(--color-primary)]" />}
              </div>
              <p className="text-xs text-muted font-mono">{t.blurb}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function StepBrand({ draft, set }: { draft: Draft; set: (p: Partial<Draft>) => void }) {
  const mode = draft.theme.defaultMode === "light" ? "light" : "dark";
  const setTheme = (p: Partial<OrgTheme>) => set({ theme: { ...draft.theme, ...p } });
  const top = draft.tiers[draft.tiers.length - 1];
  return (
    <div>
      <Heading eyebrow="Passo 3" title="A cara da sua base" desc="Cores, modo e a carteirinha que o seu fã vai carregar." />
      <div className="grid md:grid-cols-2 gap-6">
        <div>
          <div className="grid grid-cols-2 gap-x-4">
            <Field label="Cor primária"><ColorField value={draft.theme.primary ?? "#6d28d9"} onChange={(v) => setTheme({ primary: v })} /></Field>
            <Field label="Cor de realce"><ColorField value={draft.theme.accent ?? "#b8965a"} onChange={(v) => setTheme({ accent: v })} /></Field>
            <Field label="Fundo (claro)"><ColorField value={draft.theme.bgLight ?? "#fffefb"} onChange={(v) => setTheme({ bgLight: v })} /></Field>
            <Field label="Fundo (escuro)"><ColorField value={draft.theme.bgDark ?? "#15140f"} onChange={(v) => setTheme({ bgDark: v })} /></Field>
          </div>
          <Field label="Logo (texto)"><Input value={draft.logoText} onChange={(e) => set({ logoText: e.target.value })} placeholder="aurora" /></Field>
          <Field label="Frase de efeito"><Input value={draft.tagline} onChange={(e) => set({ tagline: e.target.value })} /></Field>
          <div className="flex items-center gap-6">
            <div>
              <Label>Modo padrão</Label>
              <Select value={draft.theme.defaultMode ?? "dark"} onChange={(e) => setTheme({ defaultMode: e.target.value as OrgTheme["defaultMode"] })}>
                <option value="dark">Escuro</option>
                <option value="light">Claro</option>
                <option value="system">Sistema</option>
              </Select>
            </div>
            <div className="pt-5"><Switch checked={draft.theme.darkEnabled ?? true} onChange={(v) => setTheme({ darkEnabled: v })} label="Dark habilitado" /></div>
          </div>
        </div>
        <div className="rounded-2xl border border-line p-5" data-theme={mode} style={{ background: mode === "dark" ? "#15140f" : "#fffefb", ["--color-primary" as string]: draft.theme.primary, ["--color-accent" as string]: draft.theme.accent }}>
          <div className="eyebrow mb-3" style={{ color: draft.theme.accent }}>preview</div>
          <MemberCard
            orgLogoText={draft.logoText || draft.orgName.toLowerCase() || "sua marca"}
            memberName="seu maior fã"
            memberIdCode="B7K2M9X4"
            tierName={top?.name ?? "Founder"}
            tierColor={draft.theme.accent}
            joinedAt={new Date().toISOString()}
            art={draft.theme.memberCardArt}
            showQr
          />
        </div>
      </div>
    </div>
  );
}

function StepTiers({ draft, set }: { draft: Draft; set: (p: Partial<Draft>) => void }) {
  const update = (i: number, p: Partial<TierDraft>) => set({ tiers: draft.tiers.map((t, j) => (j === i ? { ...t, ...p } : t)) });
  const remove = (i: number) => set({ tiers: draft.tiers.filter((_, j) => j !== i) });
  const add = () => set({ tiers: [...draft.tiers, { name: "Novo tier", price: 0, period: "monthly", color: draft.theme.primary ?? "#6d28d9", capacity: null, perkNames: [] }] });

  return (
    <div>
      <Heading eyebrow="Passo 4" title="Seus tiers" desc="A escada de membros — já preenchida pelo modelo. Ajuste preços e nomes." />
      <div className="space-y-3">
        {draft.tiers.map((t, i) => {
          const inst = installmentsAllowed(t.period) && t.price > 0 ? installmentOptions(t.price, t.period).at(-1) : null;
          return (
            <div key={i} className="rounded-2xl border border-line p-4">
              <div className="flex items-center gap-3 flex-wrap">
                <input type="color" value={t.color} onChange={(e) => update(i, { color: e.target.value })} className="w-8 h-8 rounded-lg border border-line cursor-pointer shrink-0" />
                <input value={t.name} onChange={(e) => update(i, { name: e.target.value })} className="flex-1 min-w-[120px] bg-surface border border-line rounded-lg px-3 py-2 text-sm font-medium" />
                <div className="flex items-center gap-1">
                  <span className="text-muted text-sm">R$</span>
                  <input type="number" value={t.price} onChange={(e) => update(i, { price: Number(e.target.value) })} className="w-24 bg-surface border border-line rounded-lg px-2 py-2 text-sm font-mono" />
                </div>
                <Select value={t.period} onChange={(e) => update(i, { period: e.target.value as Period })} className="w-auto">
                  {PERIODS.map((p) => <option key={p} value={p}>{periodLabel[p]}</option>)}
                </Select>
                <button onClick={() => remove(i)} className="p-2 text-muted hover:text-danger ml-auto"><Trash2 size={15} /></button>
              </div>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                {t.perkNames.map((p) => <span key={p} className="text-[0.7rem] bg-surface-2 border border-line rounded-full px-2 py-0.5 inline-flex items-center gap-1"><Gift size={10} className="text-gold-deep" />{p}</span>)}
                {inst && <span className="text-xs text-muted ml-auto">até {inst.n}× de {BRL(inst.installmentValue)}</span>}
              </div>
            </div>
          );
        })}
      </div>
      <Button variant="ghost" size="sm" className="mt-3" onClick={add}><Plus size={14} /> Adicionar tier</Button>
    </div>
  );
}

function StepPerks({ draft, set }: { draft: Draft; set: (p: Partial<Draft>) => void }) {
  const integrationPerks = draft.perks.filter((p) => getConnectorForPerk(p.type));
  const providers = Array.from(new Set(integrationPerks.map((p) => getConnectorForPerk(p.type)!.provider)));
  const toggle = (provider: string) =>
    set({ connectProviders: draft.connectProviders.includes(provider) ? draft.connectProviders.filter((x) => x !== provider) : [...draft.connectProviders, provider] });

  return (
    <div>
      <Heading eyebrow="Passo 5" title="Perks & integrações" desc="Os benefícios já vêm do modelo. Conecte agora as ferramentas que entregam os perks (pode fazer depois)." />
      <div className="grid sm:grid-cols-2 gap-2 mb-6">
        {draft.perks.map((p, i) => {
          const c = getConnectorForPerk(p.type);
          return (
            <div key={i} className="flex items-center gap-2.5 rounded-xl border border-line px-3 py-2.5 text-sm">
              <Gift size={14} className="text-gold-deep shrink-0" />
              <span className="flex-1 truncate">{p.name}</span>
              {c && <span className="font-mono text-[0.55rem] uppercase tracking-wide text-muted border border-line rounded px-1">{c.label}</span>}
            </div>
          );
        })}
      </div>

      <Label>Conectar agora</Label>
      <div className="space-y-2 mt-1">
        {providers.map((provider) => {
          const c = getConnector(provider)!;
          const on = draft.connectProviders.includes(provider);
          return (
            <div key={provider} className="flex items-center gap-3 rounded-xl border border-line px-4 py-3" style={on ? { borderColor: "var(--color-primary)" } : undefined}>
              <Plug size={16} className={on ? "text-[var(--color-primary)]" : "text-muted"} />
              <div className="flex-1">
                <div className="text-sm font-medium">{c.label}</div>
                <div className="text-xs text-muted">{c.blurb}</div>
              </div>
              <Button variant={on ? "subtle" : "primary"} size="sm" onClick={() => toggle(provider)}>
                {on ? <><Check size={13} /> Conectado</> : "Conectar"}
              </Button>
            </div>
          );
        })}
        {providers.length === 0 && <p className="text-muted text-sm">Este modelo não exige integrações. Você pode adicionar depois.</p>}
      </div>
      <p className="text-xs text-muted mt-3">Você finaliza as credenciais depois, em Integrações.</p>
    </div>
  );
}

function StepReview({ draft }: { draft: Draft }) {
  return (
    <div>
      <Heading eyebrow="Passo 6" title="Tudo pronto?" desc="Revise e publique. Você pode editar tudo depois no admin." />
      <div className="grid sm:grid-cols-2 gap-4">
        <Box title="Comunidade">
          <Line k="Nome" v={draft.orgName} />
          <Line k="Endereço" v={`/m/${draft.slug || slugify(draft.orgName)}`} />
          <Line k="Dono" v={draft.ownerName} />
        </Box>
        <Box title="Membership">
          <Line k="Tiers" v={String(draft.tiers.length)} />
          <Line k="Perks" v={String(draft.perks.length)} />
          <Line k="Integrações" v={draft.connectProviders.map((p) => getConnector(p)?.label).join(", ") || "nenhuma"} />
        </Box>
      </div>
      <div className="mt-4 space-y-1.5">
        {draft.tiers.map((t, i) => (
          <div key={i} className="flex items-center justify-between rounded-xl border border-line px-4 py-2.5 text-sm">
            <span className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-full" style={{ background: t.color }} />{t.name}</span>
            <span className="font-mono">{t.price === 0 ? "Grátis" : `${BRL(t.price)} / ${periodLabel[t.period]}`}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Success({ slug, orgName, navigate }: { slug: string; orgName: string; navigate: (to: string) => void }) {
  return (
    <div className="min-h-screen bg-bg text-content flex items-center justify-center p-6" data-theme="light">
      <div className="max-w-md text-center">
        <div className="flex justify-center text-gold-deep mb-4"><PartyPopper size={44} strokeWidth={1.4} /></div>
        <h1 className="font-display text-3xl mb-2">Sua base está no ar!</h1>
        <p className="text-muted mb-6">{orgName} já tem página de membro, carteirinha e checkout. Compartilhe o link e comece a converter fãs em membros.</p>
        <div className="rounded-xl border border-line bg-surface-2 px-4 py-3 font-mono text-sm mb-6">
          {window.location.origin}/m/{slug}
        </div>
        <div className="flex flex-col gap-2.5">
          <Button onClick={() => navigate("/admin")}>Abrir meu admin <ArrowRight size={15} /></Button>
          <Button variant="ghost" onClick={() => navigate(`/m/${slug}`)}><ExternalLink size={15} /> Ver minha área de membro</Button>
        </div>
      </div>
    </div>
  );
}

/* ── helpers ─────────────────────────────────────────────────── */
function getConnectorForPerk(type: PerkTypeKey) {
  return CONNECTORS.find((c) => c.perkTypes.includes(type));
}
function Heading({ eyebrow, title, desc }: { eyebrow: string; title: string; desc: string }) {
  return (
    <div className="mb-6">
      <span className="eyebrow">{eyebrow}</span>
      <h1 className="font-display text-2xl mt-1.5 mb-1">{title}</h1>
      <p className="text-muted text-sm">{desc}</p>
    </div>
  );
}
function Box({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-line p-4">
      <div className="font-mono text-[0.6rem] uppercase tracking-wide text-muted mb-2">{title}</div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}
function Line({ k, v }: { k: string; v: string }) {
  return <div className="flex justify-between text-sm"><span className="text-muted">{k}</span><span className="font-medium text-right">{v}</span></div>;
}
