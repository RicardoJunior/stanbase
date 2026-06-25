import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Mail, Phone, Gamepad2, ShieldCheck, Clock, StickyNote, Gift, Plus } from "lucide-react";
import { useStore } from "@/lib/store";
import {
  getMember, getProfile, getMetrics, getTier, listMemberTransactions, listInteractions,
  listNotes, listTags, getMemberTags, memberPerks, getMemberSubscription, addNote, toggleTag, cancelMembership,
} from "@/lib/api";
import { BRL } from "@/lib/billing";
import { formatMemberId } from "@/lib/ids";
import { perkType } from "@/lib/perk-catalog";
import { Card, CardHeader, CardBody, Tabs, Button, Badge, Avatar, Textarea, Field, Stat } from "@/components/ui";
import { MemberCard } from "@/components/MemberCard";
import { useAdminOrg } from "../useAdminOrg";
import { statusBadge, periodLabel, methodLabel } from "../shared";

type Tab = "overview" | "timeline" | "financial" | "perks";

export default function MemberDetail() {
  const { id = "" } = useParams();
  const { org, orgId } = useAdminOrg();
  const db = useStore((d) => d);
  const [tab, setTab] = useState<Tab>("overview");
  const [note, setNote] = useState("");

  const member = getMember(db, id);
  if (!member || !org || !orgId) return <div className="text-muted">Membro não encontrado.</div>;
  const p = getProfile(db, id);
  const mm = getMetrics(db, id);
  const tier = getTier(db, member.tierId);
  const txs = listMemberTransactions(db, id);
  const timeline = listInteractions(db, id);
  const notes = listNotes(db, id);
  const allTags = listTags(db, orgId);
  const myTags = new Set(getMemberTags(db, orgId, id).map((t) => t.id));
  const perks = memberPerks(db, orgId, member);
  const sub = getMemberSubscription(db, id);

  return (
    <div>
      <Link to="/admin/members" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-content mb-4">
        <ArrowLeft size={15} /> Membros
      </Link>

      {/* header */}
      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div className="flex items-center gap-4">
          <Avatar name={p?.name ?? "—"} size={56} />
          <div>
            <div className="flex items-center gap-3">
              <h1 className="font-display text-2xl">{p?.name}</h1>
              {statusBadge(member, mm)}
            </div>
            <div className="flex items-center gap-3 mt-1 text-sm text-muted">
              <span className="font-mono">{formatMemberId(member.memberId)}</span>
              {tier && (
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full" style={{ background: tier.color }} /> {tier.name}
                </span>
              )}
              <span>membro desde {new Date(member.joinedAt).toLocaleDateString("pt-BR")}</span>
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          {member.status !== "canceled" && (
            <Button variant="ghost" size="sm" onClick={() => confirm("Cancelar este membership? (acesso até o fim do período pago)") && cancelMembership(id)}>
              Cancelar membership
            </Button>
          )}
        </div>
      </div>

      <Tabs<Tab>
        tabs={[
          { value: "overview", label: "Visão geral" },
          { value: "timeline", label: "Timeline", count: timeline.length },
          { value: "financial", label: "Financeiro", count: txs.length },
          { value: "perks", label: "Perks & Passport", count: perks.length },
        ]}
        value={tab}
        onChange={setTab}
      />

      <div className="grid lg:grid-cols-3 gap-5 mt-5">
        <div className="lg:col-span-2 space-y-5">
          {tab === "overview" && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <Stat label="LTV" value={BRL(mm?.ltv ?? 0)} />
                <Stat label="Total pago" value={BRL(mm?.totalPaid ?? 0)} />
                <Stat label="Engajamento" value={`${mm?.engagementScore ?? 0}`} />
                <Stat label="Risco churn" value={`${mm?.churnScore ?? 0}%`} tone={mm && mm.churnScore >= 70 ? "down" : undefined} />
              </div>

              <Card>
                <CardHeader eyebrow="Identidade" title="Contato & atributos" />
                <CardBody className="space-y-3 text-sm">
                  <Row icon={<Mail size={15} />} label="E-mail" value={p?.email ?? "— sem canal de contato"} />
                  <Row icon={<Phone size={15} />} label="Telefone" value={p?.phone ?? "—"} />
                  <Row icon={<Gamepad2 size={15} />} label="Gamertag" value={p?.attributes.gamertag ?? "—"} />
                  <Row icon={<Gamepad2 size={15} />} label="Jogo principal" value={p?.attributes.jogo_principal ?? "—"} />
                  <Row icon={<ShieldCheck size={15} />} label="Consentimentos" value={
                    Object.entries(p?.consents ?? {}).filter(([, v]) => v).map(([k]) => k).join(", ") || "nenhum"
                  } />
                </CardBody>
              </Card>

              <Card>
                <CardHeader eyebrow="Segmentação" title="Tags" />
                <CardBody>
                  <div className="flex flex-wrap gap-2">
                    {allTags.map((t) => {
                      const on = myTags.has(t.id);
                      return (
                        <button
                          key={t.id}
                          onClick={() => toggleTag(orgId, id, t.id)}
                          className="text-xs font-mono px-2.5 py-1 rounded-full border transition-colors"
                          style={{
                            borderColor: t.color + (on ? "" : "44"),
                            color: on ? "#fff" : t.color,
                            background: on ? t.color : "transparent",
                          }}
                        >
                          {t.label}
                        </button>
                      );
                    })}
                  </div>
                </CardBody>
              </Card>
            </>
          )}

          {tab === "timeline" && (
            <Card>
              <CardHeader eyebrow="Histórico" title="Timeline de interações" />
              <CardBody>
                <ol className="relative border-l border-line ml-2">
                  {timeline.map((i) => (
                    <li key={i.id} className="ml-5 pb-5 last:pb-0 relative">
                      <span className="absolute -left-[26px] top-1 w-3 h-3 rounded-full bg-gold border-2 border-surface" />
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm">{i.title}</span>
                        <span className="text-[0.7rem] text-muted">{new Date(i.occurredAt).toLocaleString("pt-BR")}</span>
                      </div>
                      <p className="text-muted text-sm">{i.detail}</p>
                    </li>
                  ))}
                </ol>
              </CardBody>
            </Card>
          )}

          {tab === "financial" && (
            <Card>
              <CardHeader eyebrow="Billing" title="Assinatura & transações" />
              <CardBody>
                {sub && (
                  <div className="mb-4 p-4 rounded-xl bg-surface-2 border border-line text-sm flex flex-wrap gap-x-8 gap-y-2">
                    <span><span className="text-muted">Período:</span> {periodLabel[sub.period]}</span>
                    <span><span className="text-muted">Método:</span> {methodLabel[sub.method]}{sub.installments > 1 ? ` ${sub.installments}×` : ""}</span>
                    <span><span className="text-muted">Renova:</span> {sub.autoRenew ? "automático" : "compra avulsa"}</span>
                    <span><span className="text-muted">Próx. ciclo:</span> {new Date(sub.currentPeriodEnd).toLocaleDateString("pt-BR")}</span>
                  </div>
                )}
                <div className="space-y-2">
                  {txs.map((t) => (
                    <div key={t.id} className="flex items-center justify-between py-2 border-b border-line/50 last:border-0">
                      <div>
                        <div className="text-sm font-medium">{t.description}</div>
                        <div className="text-xs text-muted">
                          {new Date(t.createdAt).toLocaleDateString("pt-BR")} · {methodLabel[t.method]}{t.installments > 1 ? ` ${t.installments}×` : ""}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-mono text-sm">{BRL(t.chargedTotal)}</div>
                        {t.status !== "paid" && <Badge tone={t.status === "failed" ? "danger" : "warning"}>{t.status}</Badge>}
                      </div>
                    </div>
                  ))}
                  {txs.length === 0 && <p className="text-muted text-sm">Sem transações.</p>}
                </div>
              </CardBody>
            </Card>
          )}

          {tab === "perks" && (
            <>
              <Card>
                <CardHeader eyebrow="Entitlements" title="Perks ativos" />
                <CardBody className="space-y-2">
                  {perks.map((pk) => (
                    <div key={pk.id} className="flex items-center gap-3 py-2 border-b border-line/50 last:border-0">
                      <span className="w-8 h-8 rounded-lg bg-surface-2 border border-line flex items-center justify-center">
                        <Gift size={15} className="text-gold-deep" />
                      </span>
                      <div>
                        <div className="text-sm font-medium">{pk.name}</div>
                        <div className="text-xs text-muted">{perkType(pk.type)?.label}{perkType(pk.type)?.integration ? ` · ${perkType(pk.type)?.integration}` : ""}</div>
                      </div>
                    </div>
                  ))}
                  {perks.length === 0 && <p className="text-muted text-sm">Nenhum perk (tier gratuito ou sem tier).</p>}
                </CardBody>
              </Card>
            </>
          )}
        </div>

        {/* right rail */}
        <div className="space-y-5">
          <MemberCard
            orgLogoText={org.logoText}
            memberName={p?.name ?? "—"}
            memberIdCode={member.memberId}
            tierName={tier?.name ?? "Sem tier"}
            tierColor={tier?.color}
            joinedAt={member.joinedAt}
            status={member.status === "canceled" ? "inactive" : "active"}
            art={org.theme.memberCardArt}
          />

          <Card>
            <CardHeader eyebrow="Equipe" title={<span className="flex items-center gap-2"><StickyNote size={15} /> Notas</span>} />
            <CardBody>
              <Field>
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anotação interna sobre o membro…" />
              </Field>
              <Button
                size="sm"
                disabled={!note.trim()}
                onClick={() => {
                  addNote(orgId, id, "Ricardo Júnior", note.trim());
                  setNote("");
                }}
              >
                <Plus size={14} /> Adicionar nota
              </Button>
              <div className="mt-4 space-y-3">
                {notes.map((n) => (
                  <div key={n.id} className="text-sm border-l-2 border-gold pl-3">
                    <p>{n.body}</p>
                    <div className="text-[0.7rem] text-muted flex items-center gap-1.5 mt-1">
                      <Clock size={11} /> {n.author} · {new Date(n.createdAt).toLocaleDateString("pt-BR")}
                    </div>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-muted">{icon}</span>
      <span className="text-muted w-28 shrink-0">{label}</span>
      <span className="text-content">{value}</span>
    </div>
  );
}
