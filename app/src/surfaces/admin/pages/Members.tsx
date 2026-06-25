import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Search, Download } from "lucide-react";
import { useStore } from "@/lib/store";
import { listMembers, listTiers, getProfile, getMetrics, getTier, getMemberTags } from "@/lib/api";
import { BRL } from "@/lib/billing";
import { formatMemberId } from "@/lib/ids";
import { SectionHead, Card, Table, Avatar, Input, Button, type Column } from "@/components/ui";
import { useAdminOrg } from "../useAdminOrg";
import { statusBadge } from "../shared";
import type { Member } from "@/types/domain";

export default function Members() {
  const { orgId } = useAdminOrg();
  const db = useStore((d) => d);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [q, setQ] = useState("");
  const [tierFilter, setTierFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState(params.get("filter") === "risk" ? "risk" : "all");

  const tiers = orgId ? listTiers(db, orgId) : [];
  const rows = useMemo(() => {
    if (!orgId) return [];
    return listMembers(db, orgId).filter((m) => {
      const p = getProfile(db, m.id);
      const mm = getMetrics(db, m.id);
      if (q) {
        const hay = `${p?.name ?? ""} ${m.memberId} ${p?.email ?? ""}`.toLowerCase();
        if (!hay.includes(q.toLowerCase())) return false;
      }
      if (tierFilter !== "all" && m.tierId !== tierFilter) return false;
      if (statusFilter === "risk") return (mm?.churnScore ?? 0) >= 70 && m.status !== "canceled";
      if (statusFilter !== "all" && m.status !== statusFilter) return false;
      return true;
    });
  }, [db, orgId, q, tierFilter, statusFilter]);

  if (!orgId) return null;

  const columns: Column<Member>[] = [
    {
      key: "name",
      header: "Membro",
      render: (m) => {
        const p = getProfile(db, m.id);
        return (
          <div className="flex items-center gap-3">
            <Avatar name={p?.name ?? "—"} size={34} />
            <div className="leading-tight">
              <div className="font-medium">{p?.name}</div>
              <div className="font-mono text-[0.7rem] text-muted">{formatMemberId(m.memberId)}</div>
            </div>
          </div>
        );
      },
    },
    {
      key: "tier",
      header: "Tier",
      render: (m) => {
        const t = getTier(db, m.tierId);
        return t ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: t.color }} />
            {t.name}
          </span>
        ) : (
          <span className="text-muted">—</span>
        );
      },
    },
    { key: "status", header: "Status", render: (m) => statusBadge(m, getMetrics(db, m.id)) },
    {
      key: "ltv",
      header: "LTV",
      align: "right",
      render: (m) => <span className="font-mono">{BRL(getMetrics(db, m.id)?.ltv ?? 0)}</span>,
    },
    {
      key: "tags",
      header: "Tags",
      render: (m) => (
        <div className="flex flex-wrap gap-1">
          {getMemberTags(db, orgId, m.id).slice(0, 2).map((t) => (
            <span key={t.id} className="text-[0.62rem] font-mono px-1.5 py-0.5 rounded border" style={{ borderColor: t.color + "66", color: t.color }}>
              {t.label}
            </span>
          ))}
        </div>
      ),
    },
    {
      key: "last",
      header: "Última atividade",
      align: "right",
      render: (m) => (
        <span className="text-muted text-sm">
          {new Date(getMetrics(db, m.id)?.lastActiveAt ?? m.joinedAt).toLocaleDateString("pt-BR")}
        </span>
      ),
    },
  ];

  return (
    <div>
      <SectionHead
        eyebrow="CRM · base de customers"
        title="Membros"
        desc="A visão 360º de cada pessoa — perfil, financeiro, engajamento e timeline."
        action={
          <Button variant="ghost" size="sm" onClick={() => alert("Export CSV — auditado (REPLAN: backend real).")}>
            <Download size={15} /> Exportar
          </Button>
        }
      />

      <div className="flex flex-wrap gap-3 mb-4">
        <div className="relative flex-1 min-w-[240px]">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nome, Member ID, e-mail…"
            className="pl-9"
          />
        </div>
        <select
          value={tierFilter}
          onChange={(e) => setTierFilter(e.target.value)}
          className="bg-surface border border-line rounded-xl px-3 text-sm cursor-pointer"
        >
          <option value="all">Todos os tiers</option>
          {tiers.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-surface border border-line rounded-xl px-3 text-sm cursor-pointer"
        >
          <option value="all">Todos os status</option>
          <option value="active">Ativos</option>
          <option value="past_due">Em grace</option>
          <option value="reactivated">Reativados</option>
          <option value="canceled">Cancelados</option>
          <option value="lead">Leads</option>
          <option value="risk">Em risco (IA)</option>
        </select>
      </div>

      <div className="text-sm text-muted mb-3">{rows.length} membros</div>

      <Card className="overflow-hidden">
        <Table columns={columns} rows={rows} rowKey={(m) => m.id} onRowClick={(m) => navigate(`/admin/members/${m.id}`)} />
      </Card>
    </div>
  );
}
