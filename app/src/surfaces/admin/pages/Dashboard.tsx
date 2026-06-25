import { Link } from "react-router-dom";
import { TrendingUp, AlertTriangle, Sparkles, ArrowUpRight } from "lucide-react";
import { useStore } from "@/lib/store";
import { computeDashboard, listMembers, getProfile, getMetrics, listTransactions } from "@/lib/api";
import { BRL, PCT } from "@/lib/billing";
import { SectionHead, Stat, Card, CardHeader, CardBody, Badge, Avatar } from "@/components/ui";
import { useAdminOrg } from "../useAdminOrg";

export default function Dashboard() {
  const { orgId } = useAdminOrg();
  const db = useStore((d) => d);
  if (!orgId) return null;

  const dash = computeDashboard(db, orgId);
  const members = listMembers(db, orgId);
  const atRisk = members
    .map((m) => ({ m, mm: getMetrics(db, m.id), p: getProfile(db, m.id) }))
    .filter((x) => (x.mm?.churnScore ?? 0) >= 70 && x.m.status !== "canceled")
    .sort((a, b) => (b.mm?.churnScore ?? 0) - (a.mm?.churnScore ?? 0))
    .slice(0, 5);
  const recent = listTransactions(db, orgId).filter((t) => t.status === "paid").slice(0, 6);
  const maxTierMrr = Math.max(1, ...dash.tierDistribution.map((t) => t.mrr));

  return (
    <div>
      <SectionHead
        eyebrow="Visão geral"
        title="Dashboard"
        desc="A saúde da sua base num relance — receita, membros e os sinais que a IA destacaria."
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Stat label="MRR" value={BRL(dash.mrr)} hint={<><TrendingUp size={12} className="inline" /> receita recorrente</>} tone="up" />
        <Stat label="Receita do mês" value={BRL(dash.monthRevenue)} hint={`líquido org ${BRL(dash.netOrg)}`} />
        <Stat label="Membros ativos" value={dash.activeMembers} hint={`+${dash.newThisMonth} novos no mês`} tone="up" />
        <Stat label="Churn" value={PCT(dash.churnRate)} hint={`${dash.canceled} cancelados`} tone="down" />
      </div>

      <div className="grid lg:grid-cols-3 gap-5">
        <div className="lg:col-span-2 space-y-5">
          {/* tier distribution */}
          <Card>
            <CardHeader eyebrow="Membership" title="Distribuição por tier" action={<Link to="/admin/tiers" className="text-sm text-muted hover:text-content flex items-center gap-1">Tiers <ArrowUpRight size={14} /></Link>} />
            <CardBody className="space-y-4">
              {dash.tierDistribution.map(({ tier, count, mrr }) => (
                <div key={tier.id}>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: tier.color }} />
                      <span className="font-medium text-[0.95rem]">{tier.name}</span>
                      <span className="text-muted text-sm">· {count} membros</span>
                    </div>
                    <span className="font-mono text-sm text-muted">{BRL(mrr)}/mês</span>
                  </div>
                  <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
                    <div className="h-full rounded-full" style={{ width: `${(mrr / maxTierMrr) * 100}%`, background: tier.color }} />
                  </div>
                </div>
              ))}
            </CardBody>
          </Card>

          {/* recent activity */}
          <Card>
            <CardHeader eyebrow="Atividade" title="Pagamentos recentes" />
            <CardBody className="space-y-1">
              {recent.map((t) => {
                const p = getProfile(db, t.memberId);
                return (
                  <div key={t.id} className="flex items-center justify-between py-2 border-b border-line/50 last:border-0">
                    <div className="flex items-center gap-3">
                      <Avatar name={p?.name ?? "—"} size={30} />
                      <div className="leading-tight">
                        <div className="text-sm font-medium">{p?.name}</div>
                        <div className="text-xs text-muted">{t.description}</div>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-mono text-sm">{BRL(t.chargedTotal)}</div>
                      <div className="text-[0.65rem] text-muted">{t.installments > 1 ? `${t.installments}×` : t.method === "pix" ? "Pix" : "cartão"}</div>
                    </div>
                  </div>
                );
              })}
            </CardBody>
          </Card>
        </div>

        <div className="space-y-5">
          {/* AI suggestion */}
          <div className="rounded-2xl p-5 text-[#efe9da] relative overflow-hidden" style={{ background: "#15140f" }}>
            <div className="absolute -top-16 -right-12 w-44 h-44 rounded-full" style={{ background: "radial-gradient(circle, rgba(184,150,90,.22), transparent 65%)" }} />
            <div className="relative">
              <div className="flex items-center gap-2 eyebrow" style={{ color: "var(--gold)" }}>
                <Sparkles size={13} /> IA · sugestão
              </div>
              <p className="font-display text-lg mt-2 leading-snug">
                {atRisk.length} membros com alto risco de churn neste mês.
              </p>
              <p className="text-[0.88rem] mt-1.5" style={{ color: "rgba(239,233,218,.66)" }}>
                Enviar um perk de retenção pode segurar {BRL(dash.mrr * 0.08)} de MRR.
              </p>
              <Link to="/admin/members?filter=risk" className="inline-flex items-center gap-1.5 mt-4 text-sm font-medium" style={{ color: "var(--gold)" }}>
                Ver em risco <ArrowUpRight size={14} />
              </Link>
            </div>
          </div>

          {/* at risk list */}
          <Card>
            <CardHeader eyebrow="Retenção" title={<span className="flex items-center gap-2"><AlertTriangle size={16} className="text-danger" /> Em risco</span>} />
            <CardBody className="space-y-2">
              {atRisk.map(({ m, mm, p }) => (
                <Link key={m.id} to={`/admin/members/${m.id}`} className="flex items-center justify-between py-1.5 hover:bg-surface-2 -mx-2 px-2 rounded-lg">
                  <div className="flex items-center gap-2.5">
                    <Avatar name={p?.name ?? "—"} size={28} />
                    <span className="text-sm font-medium">{p?.name}</span>
                  </div>
                  <Badge tone="danger">{mm?.churnScore}% risco</Badge>
                </Link>
              ))}
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}
