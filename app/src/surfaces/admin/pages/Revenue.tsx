import { useStore } from "@/lib/store";
import { listTransactions, listSubscriptions, getProfile, computeDashboard } from "@/lib/api";
import { BRL } from "@/lib/billing";
import { SectionHead, Stat, Card, CardHeader, CardBody, Table, Badge, type Column } from "@/components/ui";
import { useAdminOrg } from "../useAdminOrg";
import { methodLabel } from "../shared";
import type { Transaction } from "@/types/domain";

export default function Revenue() {
  const { orgId } = useAdminOrg();
  const db = useStore((d) => d);
  if (!orgId) return null;

  const txs = listTransactions(db, orgId).filter((t) => t.status === "paid");
  const dash = computeDashboard(db, orgId);
  const subs = listSubscriptions(db, orgId);
  const payouts = db.payouts.filter((p) => p.orgId === orgId);

  const totalBase = txs.reduce((s, t) => s + t.baseCommission, 0);
  const totalSpread = txs.reduce((s, t) => s + t.financingSpread, 0);
  const totalNet = txs.reduce((s, t) => s + t.netOrg, 0);
  const totalGross = txs.reduce((s, t) => s + t.chargedTotal, 0);

  const columns: Column<Transaction>[] = [
    {
      key: "member",
      header: "Membro",
      render: (t) => <span className="text-sm">{getProfile(db, t.memberId)?.name ?? "—"}</span>,
    },
    { key: "desc", header: "Descrição", render: (t) => <span className="text-sm text-muted">{t.description}</span> },
    {
      key: "method",
      header: "Método",
      render: (t) => (
        <span className="text-sm">
          {methodLabel[t.method]}
          {t.installments > 1 && <Badge tone="gold" className="ml-1.5">{t.installments}×</Badge>}
        </span>
      ),
    },
    { key: "plan", header: "Plano", align: "right", render: (t) => <span className="font-mono text-sm">{BRL(t.planValue)}</span> },
    { key: "interest", header: "Juros", align: "right", render: (t) => <span className="font-mono text-sm text-muted">{t.customerInterest ? BRL(t.customerInterest) : "—"}</span> },
    { key: "commission", header: "Comissão 7,99%", align: "right", render: (t) => <span className="font-mono text-sm text-gold-deep">{BRL(t.baseCommission)}</span> },
    { key: "spread", header: "Spread", align: "right", render: (t) => <span className="font-mono text-sm text-gold-deep">{t.financingSpread ? BRL(t.financingSpread) : "—"}</span> },
    { key: "net", header: "Líquido org", align: "right", render: (t) => <span className="font-mono text-sm">{BRL(t.netOrg)}</span> },
  ];

  return (
    <div>
      <SectionHead
        eyebrow="Financeiro"
        title="Receita & Pagamentos"
        desc="Comissão de 7,99% + spread de parcelamento. Cada transação registra bruto, comissão, taxa do PSP, financiamento e líquido da org."
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Stat label="Receita do mês" value={BRL(dash.monthRevenue)} hint={`ticket médio ${BRL(dash.avgTicket)}`} />
        <Stat label="Líquido da org (total)" value={BRL(totalNet)} hint="repassado / a repassar" tone="up" />
        <Stat label="Comissão base 7,99%" value={BRL(totalBase)} hint="padrão Stanbase" />
        <Stat label="Spread de parcelamento" value={BRL(totalSpread)} hint="margem premium de financiamento" tone="up" />
      </div>

      <div className="grid lg:grid-cols-3 gap-5 mb-6">
        <Card className="lg:col-span-2">
          <CardHeader eyebrow="Como a Stanbase ganha" title="Receita Stanbase: base vs. financiamento" />
          <CardBody>
            <div className="flex items-end gap-6">
              <div>
                <div className="font-display text-3xl">{BRL(totalBase + totalSpread)}</div>
                <div className="text-muted text-sm">receita total da plataforma</div>
              </div>
            </div>
            <div className="mt-4 h-3 rounded-full overflow-hidden flex bg-surface-2">
              <div className="h-full bg-gold-deep" style={{ width: `${(totalBase / (totalBase + totalSpread || 1)) * 100}%` }} title="Comissão base" />
              <div className="h-full bg-gold" style={{ width: `${(totalSpread / (totalBase + totalSpread || 1)) * 100}%` }} title="Spread" />
            </div>
            <div className="flex gap-5 mt-3 text-sm">
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-gold-deep" /> Comissão base {BRL(totalBase)}</span>
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-gold" /> Spread parcelamento {BRL(totalSpread)}</span>
            </div>
            <p className="text-xs text-muted mt-4">
              O cliente paga 3,49% a.m.; o Asaas antecipa a ~1,25% a.m.; a Stanbase retém o spread (~2,2% a.m. por mês financiado). A org recebe antecipado, sem absorver juros.
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader eyebrow="Asaas" title="Repasses (payouts)" />
          <CardBody className="space-y-3">
            {payouts.map((p) => (
              <div key={p.id} className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">{BRL(p.amount)}</div>
                  <div className="text-xs text-muted">{p.period}</div>
                </div>
                <Badge tone={p.status === "paid" ? "success" : "warning"}>{p.status === "paid" ? "pago" : "agendado"}</Badge>
              </div>
            ))}
            <p className="text-xs text-muted pt-2 border-t border-line">
              Repasse diário automático + saque sob demanda. Reconciliação com o Asaas.
            </p>
          </CardBody>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <CardHeader eyebrow={`${txs.length} transações · ${subs.length} assinaturas`} title="Transações" />
        <Table columns={columns} rows={txs.slice(0, 40)} rowKey={(t) => t.id} />
        <div className="px-4 py-3 border-t border-line flex justify-between font-mono text-sm bg-surface-2/40">
          <span className="text-muted">Totais (pagas)</span>
          <span>bruto {BRL(totalGross)} · comissão {BRL(totalBase)} · líquido org {BRL(totalNet)}</span>
        </div>
      </Card>
    </div>
  );
}
