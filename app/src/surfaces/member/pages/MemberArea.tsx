import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { Gift, Wallet, ArrowUpRight, CalendarDays, Sparkles } from "lucide-react";
import { getProfile, getTier, memberPerks, listTiers, listEvents, perkProvision } from "@/lib/api";
import { perkType } from "@/lib/perk-catalog";
import { MemberCard } from "@/components/MemberCard";
import { useMemberOrg } from "../useMemberOrg";

export default function MemberArea() {
  const { orgSlug } = useParams();
  const { org, member, db } = useMemberOrg();
  const [params] = useSearchParams();

  if (!org) return null;
  if (!member) return <Navigate to={`/m/${orgSlug}/login`} replace />;

  const p = getProfile(db, member.id);
  const tier = getTier(db, member.tierId);
  const perks = memberPerks(db, org.id, member);
  const tiers = listTiers(db, org.id);
  const nextTier = tiers.find((t) => (tier ? t.position > tier.position : true));
  const events = listEvents(db, org.id);
  const welcome = params.get("welcome");

  return (
    <main className="max-w-6xl mx-auto px-6 py-12">
      {welcome && (
        <div className="rounded-2xl border p-4 mb-6 flex items-center gap-3" style={{ borderColor: "var(--color-accent)", background: "color-mix(in srgb, var(--color-accent) 8%, transparent)" }}>
          <Sparkles size={18} style={{ color: "var(--color-accent)" }} />
          <span>Bem-vindo à {org.name}! Sua carteirinha já está pronta — adicione à Wallet.</span>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-10 items-start">
        <div>
          <span className="eyebrow" style={{ color: "var(--color-accent)" }}>Sua carteirinha</span>
          <h1 className="font-display text-3xl mt-2 mb-6">Olá, {p?.name?.split(" ")[0]}</h1>
          <MemberCard
            orgLogoText={org.logoText}
            memberName={p?.name ?? "—"}
            memberIdCode={member.memberId}
            tierName={tier?.name ?? "Sem tier"}
            tierColor={tier?.color ?? org.theme.accent}
            joinedAt={member.joinedAt}
            status={member.status === "canceled" ? "inactive" : "active"}
            art={org.theme.memberCardArt}
          />
          <div className="flex gap-3 mt-5">
            <Link
              to={`/m/${orgSlug}/passport`}
              className="flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-medium"
              style={{ background: "var(--color-primary)", color: "var(--color-primary-contrast)" }}
            >
              <Wallet size={16} /> Adicionar à Wallet
            </Link>
            {member.status === "past_due" && (
              <span className="flex items-center text-sm" style={{ color: "var(--color-warning)" }}>
                Pagamento pendente — acesso mantido no grace.
              </span>
            )}
          </div>
        </div>

        <div className="space-y-6">
          {/* perks */}
          <div>
            <h2 className="font-display text-xl mb-3 flex items-center gap-2"><Gift size={18} style={{ color: "var(--color-accent)" }} /> Seus perks</h2>
            <div className="space-y-2">
              {perks.map((pk) => {
                const prov = perkProvision(db, org.id, pk.type);
                return (
                  <div key={pk.id} className="flex items-center gap-3 rounded-xl border border-line px-4 py-3" style={{ background: "var(--color-surface)" }}>
                    <span className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
                      <Gift size={16} style={{ color: "var(--color-accent)" }} />
                    </span>
                    <div className="flex-1">
                      <div className="text-sm font-medium">{pk.name}</div>
                      <div className="text-xs text-muted">{perkType(pk.type)?.label}</div>
                    </div>
                    {prov.requiresConnection && !prov.connected ? (
                      <span className="text-[0.62rem] font-mono uppercase tracking-wide text-muted">em breve</span>
                    ) : (
                      <span className="text-[0.62rem] font-mono uppercase tracking-wide flex items-center gap-1" style={{ color: "var(--color-success, #3f7d4e)" }}>
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: "var(--color-success, #3f7d4e)" }} /> ativo
                      </span>
                    )}
                  </div>
                );
              })}
              {perks.length === 0 && (
                <p className="text-muted text-sm rounded-xl border border-line px-4 py-3">Seu tier ainda não tem perks. Faça upgrade para liberar benefícios.</p>
              )}
            </div>
          </div>

          {/* upgrade — não oferecer a membros cancelados */}
          {nextTier && member.status !== "canceled" && (
            <div className="rounded-2xl border p-5" style={{ borderColor: nextTier.color, background: "var(--color-surface)" }}>
              <div className="eyebrow" style={{ color: nextTier.color }}>Próximo nível</div>
              <h3 className="font-display text-xl mt-1">Suba para {nextTier.name}</h3>
              <p className="text-muted text-sm mt-1 mb-3">Desbloqueie mais perks e reconhecimento.</p>
              <Link to={`/m/${orgSlug}/checkout/${nextTier.id}`} className="inline-flex items-center gap-1.5 text-sm font-medium" style={{ color: nextTier.color }}>
                Fazer upgrade <ArrowUpRight size={14} />
              </Link>
            </div>
          )}

          {/* events */}
          {events.length > 0 && (
            <div>
              <h2 className="font-display text-xl mb-3 flex items-center gap-2"><CalendarDays size={18} style={{ color: "var(--color-accent)" }} /> Próximos eventos</h2>
              {events.map((e) => (
                <div key={e.id} className="rounded-xl border border-line px-4 py-3" style={{ background: "var(--color-surface)" }}>
                  <div className="font-medium">{e.name}</div>
                  <div className="text-xs text-muted">{new Date(e.startsAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "long" })} · {e.venue}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
