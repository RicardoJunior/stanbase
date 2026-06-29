import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Building2, ArrowUpRight, Save, ShieldAlert } from "lucide-react";
import { useStore } from "@/lib/store";
import { listOrgs, listMembers, computeDashboard, listTransactions, updateBillingSettings } from "@/lib/api";
import { BRL } from "@/lib/billing";
import { adminOrg } from "@/lib/session";
import type { PlatformBillingSettings } from "@/types/domain";

/** Stanbase staff console (§2 super-admin) — identity chrome, not themable. */
export default function SuperadminApp() {
  const db = useStore((d) => d);
  const navigate = useNavigate();
  const orgs = listOrgs(db);

  // platform totals across all orgs
  const allTx = orgs.flatMap((o) => listTransactions(db, o.id)).filter((t) => t.status === "paid");
  const gmv = allTx.reduce((s, t) => s + t.chargedTotal, 0);
  const stanbaseRev = allTx.reduce((s, t) => s + t.baseCommission + t.financingSpread, 0);
  const totalMembers = orgs.reduce((s, o) => s + listMembers(db, o.id).length, 0);

  const openOrg = (orgId: string) => {
    adminOrg.set(orgId);
    navigate("/admin");
  };

  return (
    <div className="min-h-screen bg-obsidian text-[#efe9da]" data-theme="dark">
      <header className="border-b border-[#efe9da]/10 px-7 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link to="/" className="font-display text-xl">stan<b style={{ color: "#b8965a" }}>base</b></Link>
          <span className="font-mono text-[0.55rem] uppercase tracking-[0.18em] text-[#efe9da]/50 border border-[#efe9da]/15 rounded px-1.5 py-0.5">
            staff console
          </span>
        </div>
        <div className="flex items-center gap-2 text-sm text-[#efe9da]/60">
          <ShieldAlert size={15} style={{ color: "#b8965a" }} /> super-admin · multi-tenant
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-7 py-8">
        <h1 className="font-display text-3xl mb-1">Plataforma</h1>
        <p className="text-[#efe9da]/55 mb-7">Todas as organizações, billing global e operação da Stanbase.</p>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          <PlatStat label="GMV (processado)" value={BRL(gmv)} />
          <PlatStat label="Receita Stanbase" value={BRL(stanbaseRev)} accent />
          <PlatStat label="Organizações" value={String(orgs.length)} />
          <PlatStat label="Membros (total)" value={String(totalMembers)} />
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          {/* orgs */}
          <div className="lg:col-span-2">
            <h2 className="font-mono text-[0.62rem] uppercase tracking-[0.18em] text-[#efe9da]/50 mb-3">Organizações</h2>
            <div className="space-y-2">
              {orgs.map((o) => {
                const dash = computeDashboard(db, o.id);
                return (
                  <div key={o.id} className="flex items-center justify-between rounded-xl border border-[#efe9da]/10 px-4 py-3.5 bg-white/[.02]">
                    <div className="flex items-center gap-3">
                      <span className="w-9 h-9 rounded-lg flex items-center justify-center font-display" style={{ background: o.theme.primary ?? "#6d28d9", color: "#fff" }}>
                        {o.name[0]}
                      </span>
                      <div>
                        <div className="font-medium flex items-center gap-2">
                          {o.name}
                          <span className="font-mono text-[0.55rem] uppercase tracking-wide text-[#efe9da]/40 border border-[#efe9da]/15 rounded px-1">{o.status}</span>
                        </div>
                        <div className="text-xs text-[#efe9da]/50">{o.vertical} · {dash.activeMembers} ativos · MRR {BRL(dash.mrr)}</div>
                      </div>
                    </div>
                    <button onClick={() => openOrg(o.id)} className="flex items-center gap-1.5 text-sm text-[#efe9da]/70 hover:text-[#efe9da]">
                      Abrir admin <ArrowUpRight size={14} />
                    </button>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-[#efe9da]/40 mt-4 flex items-center gap-2">
              <Building2 size={13} /> Uma Conta possui N orgs (bases). Aqui você cria, suspende e move orgs entre contas.
            </p>
          </div>

          {/* billing settings */}
          <BillingSettings settings={db.platformBilling} />
        </div>
      </main>
    </div>
  );
}

function PlatStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="rounded-2xl border border-[#efe9da]/10 p-5 bg-white/[.02]">
      <div className="font-mono text-[0.58rem] uppercase tracking-[0.16em] text-[#efe9da]/45 mb-2">{label}</div>
      <div className="font-display text-2xl" style={accent ? { color: "#b8965a" } : undefined}>{value}</div>
    </div>
  );
}

function BillingSettings({ settings }: { settings: PlatformBillingSettings }) {
  const [base, setBase] = useState(String(settings.baseCommissionRate * 100));
  const [interest, setInterest] = useState(String(settings.installmentInterestRateAm * 100));
  const [maxInst, setMaxInst] = useState(String(settings.maxInstallments));
  const [psp, setPsp] = useState(String(settings.pspAnticipationRateAm * 100));

  const save = () => {
    updateBillingSettings({
      baseCommissionRate: Number(base) / 100,
      installmentInterestRateAm: Number(interest) / 100,
      maxInstallments: Number(maxInst),
      pspAnticipationRateAm: Number(psp) / 100,
    });
  };

  const fields: { label: string; value: string; set: (v: string) => void; suffix: string }[] = [
    { label: "Comissão base", value: base, set: setBase, suffix: "%" },
    { label: "Juros parcelamento", value: interest, set: setInterest, suffix: "% a.m." },
    { label: "Teto de parcelas", value: maxInst, set: setMaxInst, suffix: "×" },
    { label: "Antecipação Asaas", value: psp, set: setPsp, suffix: "% a.m." },
  ];

  return (
    <div>
      <h2 className="font-mono text-[0.62rem] uppercase tracking-[0.18em] text-[#efe9da]/50 mb-3">Billing global (padrão Stanbase)</h2>
      <div className="rounded-2xl border border-[#efe9da]/10 p-5 bg-white/[.02]">
        {fields.map((f) => (
          <div className="mb-3" key={f.label}>
            <label className="block font-mono text-[0.6rem] uppercase tracking-wide text-[#efe9da]/45 mb-1">{f.label}</label>
            <div className="flex items-center gap-2">
              <input value={f.value} onChange={(e) => f.set(e.target.value)} className="w-full bg-transparent border border-[#efe9da]/15 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#b8965a]" />
              <span className="text-xs text-[#efe9da]/40 w-12">{f.suffix}</span>
            </div>
          </div>
        ))}
        <button onClick={save} className="w-full mt-2 rounded-lg py-2.5 text-sm font-medium flex items-center justify-center gap-2" style={{ background: "#b8965a", color: "#15140f" }}>
          <Save size={15} /> Salvar parâmetros
        </button>
        <p className="text-[0.68rem] text-[#efe9da]/40 mt-3">
          Padrão global da plataforma — afeta o cálculo de todas as orgs.
        </p>
      </div>
    </div>
  );
}
