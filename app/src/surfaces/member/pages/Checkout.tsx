import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ShieldCheck, Check } from "lucide-react";
import { getTier, checkout } from "@/lib/api";
import { memberSession } from "@/lib/session";
import { BRL, installmentOptions, installmentsAllowed, computeTransaction } from "@/lib/billing";
import { useMemberOrg } from "../useMemberOrg";
import type { PaymentMethod } from "@/types/domain";

export default function Checkout() {
  const { orgSlug, tierId = "" } = useParams();
  const { org, db } = useMemberOrg();
  const navigate = useNavigate();
  const tier = getTier(db, tierId);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("pix");
  const [installments, setInstallments] = useState(1);

  const canInstall = tier ? installmentsAllowed(tier.period) && method === "credit_card" : false;
  const options = useMemo(
    () => (tier ? installmentOptions(tier.price, tier.period) : []),
    [tier]
  );
  const breakdown = useMemo(
    () => (tier ? computeTransaction(tier.price, method, canInstall ? installments : 1, tier.period) : null),
    [tier, method, installments, canInstall]
  );

  if (!org || !tier) return <div className="max-w-2xl mx-auto px-6 py-20 text-center text-muted">Tier não encontrado.</div>;

  const isFree = tier.price === 0;

  const submit = () => {
    if (!name.trim()) return;
    const res = checkout({
      orgId: org.id,
      tierId: tier.id,
      method,
      installments: canInstall ? installments : 1,
      name: name.trim(),
      email: email.trim() || undefined,
    });
    memberSession.set(res.member.id);
    navigate(`/m/${orgSlug}/app?welcome=1`);
  };

  return (
    <main className="max-w-5xl mx-auto px-6 py-12">
      <Link to={`/m/${orgSlug}`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-content mb-6">
        <ArrowLeft size={15} /> Voltar aos planos
      </Link>

      <div className="grid md:grid-cols-2 gap-8">
        {/* form */}
        <div>
          <span className="eyebrow" style={{ color: "var(--color-accent)" }}>Checkout</span>
          <h1 className="font-display text-3xl mt-2 mb-1">
            {isFree ? "Entrar grátis" : `Assinar ${tier.name}`}
          </h1>
          <p className="text-muted mb-6">{tier.description}</p>

          <div className="space-y-4">
            <div>
              <label className="block font-mono text-[0.66rem] tracking-[0.12em] uppercase text-muted mb-1.5">Nome</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Como você quer aparecer na carteirinha"
                className="w-full bg-surface border border-line rounded-xl px-3.5 py-2.5 focus:outline-none focus:border-[var(--color-primary)]"
              />
            </div>
            <div>
              <label className="block font-mono text-[0.66rem] tracking-[0.12em] uppercase text-muted mb-1.5">E-mail (opcional)</label>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="voce@email.com"
                className="w-full bg-surface border border-line rounded-xl px-3.5 py-2.5 focus:outline-none focus:border-[var(--color-primary)]"
              />
            </div>

            {!isFree && (
              <>
                <div>
                  <label className="block font-mono text-[0.66rem] tracking-[0.12em] uppercase text-muted mb-1.5">Forma de pagamento</label>
                  <div className="grid grid-cols-2 gap-2">
                    {(["pix", "credit_card"] as PaymentMethod[]).map((m) => (
                      <button
                        key={m}
                        onClick={() => { setMethod(m); if (m === "pix") setInstallments(1); }}
                        className="rounded-xl border px-4 py-3 text-sm font-medium text-left transition-colors"
                        style={{
                          borderColor: method === m ? "var(--color-primary)" : "var(--color-border)",
                          background: method === m ? "color-mix(in srgb, var(--color-primary) 8%, transparent)" : "transparent",
                        }}
                      >
                        {m === "pix" ? "Pix" : "Cartão de crédito"}
                        <span className="block text-xs text-muted font-normal">
                          {m === "pix" ? "à vista, sem juros" : canInstall ? "parcela em até 12×" : "à vista"}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {canInstall && (
                  <div>
                    <label className="block font-mono text-[0.66rem] tracking-[0.12em] uppercase text-muted mb-1.5">Parcelas</label>
                    <select
                      value={installments}
                      onChange={(e) => setInstallments(Number(e.target.value))}
                      className="w-full bg-surface border border-line rounded-xl px-3.5 py-2.5 cursor-pointer focus:outline-none focus:border-[var(--color-primary)]"
                    >
                      {options.map((o) => (
                        <option key={o.n} value={o.n}>
                          {o.n}× de {BRL(o.installmentValue)}
                          {o.n > 1 ? ` — total ${BRL(o.total)} (juros ${(o.surchargePct * 100).toFixed(1)}%)` : " — à vista"}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-muted mt-1.5">Juros de 3,49% a.m. transparentes, pagos por você (modelo Hotmart).</p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* summary */}
        <div>
          <div className="rounded-2xl border border-line p-6" style={{ background: "var(--color-surface)" }}>
            <h3 className="font-display text-lg mb-4">Resumo</h3>
            {breakdown && !isFree ? (
              <div className="space-y-2.5 text-sm">
                <Row label={`Plano ${tier.name}`} value={BRL(breakdown.planValue)} />
                {breakdown.customerInterest > 0 && (
                  <Row label={`Juros do parcelamento (${installments}×)`} value={BRL(breakdown.customerInterest)} muted />
                )}
                <div className="h-px bg-line my-2" />
                <Row label="Total" value={BRL(breakdown.chargedTotal)} bold />
                {breakdown.customerInterest > 0 && (
                  <p className="text-xs text-muted">{installments}× de {BRL(breakdown.chargedTotal / installments)}</p>
                )}
                <div className="rounded-xl border border-line p-3 mt-3 text-xs text-muted space-y-1" style={{ background: "var(--color-bg)" }}>
                  <div className="flex justify-between"><span>Taxa Stanbase (7,99%)</span><span>{BRL(breakdown.baseCommission)}</span></div>
                  <div className="flex justify-between"><span>{org.name} recebe</span><span>{BRL(breakdown.netOrg)}</span></div>
                  <p className="pt-1 opacity-80">Sem letrinha miúda: você vê exatamente para onde vai cada real.</p>
                </div>
              </div>
            ) : (
              <p className="text-muted text-sm">Plano gratuito — sem cobrança. Você ganha sua carteirinha e entra na comunidade.</p>
            )}

            <button
              onClick={submit}
              disabled={!name.trim()}
              className="w-full rounded-full px-5 py-3 font-medium mt-5 disabled:opacity-50"
              style={{ background: "var(--color-primary)", color: "var(--color-primary-contrast)" }}
            >
              {isFree ? "Entrar grátis" : method === "pix" ? "Pagar com Pix" : "Pagar"}
            </button>
            <p className="flex items-center justify-center gap-1.5 text-xs text-muted mt-3">
              <ShieldCheck size={13} /> pagamento simulado (REPLAN: Asaas split real)
            </p>
            <ul className="mt-4 space-y-1.5 text-xs text-muted">
              {["Carteirinha digital na Wallet", "Acesso imediato aos perks", "Cancele quando quiser"].map((b) => (
                <li key={b} className="flex items-center gap-2"><Check size={13} style={{ color: "var(--color-accent)" }} /> {b}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </main>
  );
}

function Row({ label, value, muted, bold }: { label: string; value: string; muted?: boolean; bold?: boolean }) {
  return (
    <div className={`flex justify-between ${muted ? "text-muted" : ""} ${bold ? "font-display text-lg" : ""}`}>
      <span>{label}</span>
      <span className={bold ? "" : "font-mono"}>{value}</span>
    </div>
  );
}
