import { Link, useParams } from "react-router-dom";
import { Check, Gift } from "lucide-react";
import { listTiers, listPerks } from "@/lib/api";
import { BRL, installmentsAllowed, installmentOptions } from "@/lib/billing";
import { perkIdsForTier } from "@/lib/entitlements";
import { MemberCard } from "@/components/MemberCard";
import { useMemberOrg } from "../useMemberOrg";

export default function Home() {
  const { orgSlug } = useParams();
  const { org, db } = useMemberOrg();
  if (!org) return null;
  const tiers = listTiers(db, org.id);
  const perks = listPerks(db, org.id);
  const topTier = tiers[tiers.length - 1];

  return (
    <main>
      {/* hero */}
      <section className="max-w-6xl mx-auto px-6 pt-16 pb-12 grid md:grid-cols-2 gap-12 items-center">
        <div>
          <span className="eyebrow" style={{ color: "var(--color-accent)" }}>Membership oficial</span>
          <h1 className="font-display text-[clamp(2.4rem,5vw,3.8rem)] leading-[1.05] mt-3 mb-4">
            {org.tagline}
          </h1>
          <p className="text-muted text-lg max-w-md mb-7">
            Vire membro da {org.name}, ganhe sua carteirinha digital e acesse perks, conteúdo e eventos
            exclusivos — sob a marca que você ama.
          </p>
          <div className="flex gap-3">
            <a
              href="#planos"
              className="rounded-full px-6 py-3 font-medium"
              style={{ background: "var(--color-primary)", color: "var(--color-primary-contrast)" }}
            >
              Ver planos
            </a>
            <Link to={`/m/${orgSlug}/login`} className="rounded-full px-6 py-3 font-medium border border-line hover:border-content/40 transition-colors">
              Já sou membro
            </Link>
          </div>
        </div>
        <div>
          <MemberCard
            orgLogoText={org.logoText}
            memberName="seu maior fã"
            memberIdCode="B7K2M9X4"
            tierName={topTier?.name ?? "Founder"}
            tierColor={org.theme.accent}
            joinedAt={new Date().toISOString()}
            art={org.theme.memberCardArt}
            showQr={false}
          />
        </div>
      </section>

      {/* tiers */}
      <section id="planos" className="max-w-6xl mx-auto px-6 py-12">
        <div className="text-center mb-10">
          <span className="eyebrow" style={{ color: "var(--color-accent)" }}>Escolha seu nível</span>
          <h2 className="font-display text-4xl mt-2">Planos de membro</h2>
        </div>
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-5">
          {tiers.map((tier) => {
            const tierPerkIds = perkIdsForTier(tier.id, tiers);
            const tierPerks = perks.filter((p) => tierPerkIds.includes(p.id));
            const inst = installmentsAllowed(tier.period) && tier.price > 0 ? installmentOptions(tier.price, tier.period).at(-1) : null;
            const featured = tier.id === topTier?.id;
            return (
              <div
                key={tier.id}
                className="rounded-2xl border p-6 flex flex-col"
                style={{
                  borderColor: featured ? tier.color : "var(--color-border)",
                  background: "var(--color-surface)",
                  boxShadow: featured ? `0 24px 50px -30px ${tier.color}` : undefined,
                }}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: tier.color }} />
                  <h3 className="font-display text-xl">{tier.name}</h3>
                </div>
                <p className="text-muted text-sm min-h-[40px]">{tier.description}</p>
                <div className="my-4">
                  <span className="font-display text-4xl">{tier.price === 0 ? "Grátis" : BRL(tier.price)}</span>
                  {tier.price > 0 && <span className="text-muted text-sm"> /{tier.period === "annual" ? "ano" : tier.period === "monthly" ? "mês" : tier.period}</span>}
                </div>
                {inst && (
                  <div className="text-xs text-muted -mt-2 mb-3">ou {inst.n}× de {BRL(inst.installmentValue)}</div>
                )}
                <ul className="space-y-2 flex-1 mb-5">
                  {tierPerks.slice(0, 5).map((p) => (
                    <li key={p.id} className="flex items-start gap-2 text-sm">
                      <Check size={15} style={{ color: tier.color }} className="mt-0.5 shrink-0" />
                      {p.name}
                    </li>
                  ))}
                  {tierPerks.length === 0 && (
                    <li className="flex items-center gap-2 text-sm text-muted"><Gift size={14} /> Acesso à comunidade</li>
                  )}
                </ul>
                <Link
                  to={`/m/${orgSlug}/checkout/${tier.id}`}
                  className="rounded-full px-5 py-2.5 text-sm font-medium text-center transition-transform hover:-translate-y-0.5"
                  style={
                    featured
                      ? { background: "var(--color-primary)", color: "var(--color-primary-contrast)" }
                      : { border: "1px solid var(--color-border)" }
                  }
                >
                  {tier.price === 0 ? "Entrar grátis" : `Assinar ${tier.name}`}
                </Link>
              </div>
            );
          })}
        </div>
        <p className="text-center text-muted text-sm mt-6 font-mono">
          taxa única de 7,99% por transação · sem mensalidade · cancele quando quiser
        </p>
      </section>
    </main>
  );
}
