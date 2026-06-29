import { useState } from "react";
import { Link } from "react-router-dom";
import { ChevronUp, ChevronDown, Pencil, Plus, Gift, Plug, Archive, Check } from "lucide-react";
import { useStore } from "@/lib/store";
import { listTiers, listPerks, saveTier, reorderTiers, archiveTier, createPerk, perkProvision } from "@/lib/api";
import { BRL, installmentsAllowed, installmentOptions } from "@/lib/billing";
import { PERK_CATALOG, perkType } from "@/lib/perk-catalog";
import { Card, CardHeader, CardBody, SectionHead, Button, Badge, Dialog, Field, Input, Select, Label } from "@/components/ui";
import { useAdminOrg } from "../useAdminOrg";
import { periodLabel } from "../shared";
import type { Tier, Period, PerkTypeKey } from "@/types/domain";

const PERIODS: Period[] = ["monthly", "quarterly", "semiannual", "annual"];

export default function Tiers() {
  const { orgId } = useAdminOrg();
  const db = useStore((d) => d);
  const [editing, setEditing] = useState<Tier | "new" | null>(null);
  const [addingPerk, setAddingPerk] = useState(false);

  if (!orgId) return null;
  const tiers = listTiers(db, orgId);
  const perks = listPerks(db, orgId);

  const move = (i: number, dir: -1 | 1) => {
    const ids = tiers.map((t) => t.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorderTiers(orgId, ids);
  };

  return (
    <div>
      <SectionHead
        eyebrow="Engine de membership"
        title="Tiers & Perks"
        desc="Defina o que se vende e o que se entrega. Perks são um catálogo plugável — arraste para o tier (aqui: marcar/desmarcar)."
        action={<Button size="sm" onClick={() => setEditing("new")}><Plus size={15} /> Novo tier</Button>}
      />

      <div className="grid lg:grid-cols-3 gap-5">
        {/* tiers */}
        <div className="lg:col-span-2 space-y-4">
          {tiers.map((tier, i) => {
            const tierPerks = perks.filter((p) => tier.perkIds.includes(p.id));
            const inst = installmentsAllowed(tier.period) && tier.price > 0
              ? installmentOptions(tier.price, tier.period).at(-1) : null;
            return (
              <Card key={tier.id} className="border-t-2" style={{ borderTopColor: tier.color }}>
                <CardBody>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2.5">
                        <span className="w-3 h-3 rounded-full" style={{ background: tier.color }} />
                        <h3 className="font-display text-xl">{tier.name}</h3>
                        {tier.capacity && <Badge tone="gold">{tier.capacity} vagas</Badge>}
                      </div>
                      <p className="text-muted text-sm mt-1">{tier.description}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-display text-2xl">{tier.price === 0 ? "Grátis" : BRL(tier.price)}</div>
                      <div className="font-mono text-[0.62rem] uppercase tracking-wide text-muted">
                        {tier.price === 0 ? "—" : `/ ${periodLabel[tier.period]}`}
                      </div>
                    </div>
                  </div>

                  {inst && (
                    <div className="text-xs text-muted mt-2">
                      ou até <strong>{inst.n}×</strong> de {BRL(inst.installmentValue)} (juros de 3,49% a.m.)
                    </div>
                  )}

                  <div className="flex flex-wrap gap-1.5 mt-3">
                    {tierPerks.map((p) => (
                      <span key={p.id} className="inline-flex items-center gap-1.5 text-[0.72rem] bg-surface-2 border border-line rounded-full px-2.5 py-1">
                        <Gift size={11} className="text-gold-deep" /> {p.name}
                      </span>
                    ))}
                    {tierPerks.length === 0 && <span className="text-muted text-xs">Sem perks ainda.</span>}
                  </div>

                  <div className="flex items-center gap-1 mt-4 pt-3 border-t border-line/60">
                    <Button variant="subtle" size="sm" onClick={() => setEditing(tier)}><Pencil size={13} /> Editar</Button>
                    <button onClick={() => move(i, -1)} disabled={i === 0} className="p-2 rounded-lg hover:bg-surface-2 disabled:opacity-30"><ChevronUp size={15} /></button>
                    <button onClick={() => move(i, 1)} disabled={i === tiers.length - 1} className="p-2 rounded-lg hover:bg-surface-2 disabled:opacity-30"><ChevronDown size={15} /></button>
                    {tiers.length > 1 && (
                      <button onClick={() => confirm(`Arquivar o tier ${tier.name}?`) && archiveTier(tier.id)} className="p-2 rounded-lg hover:bg-surface-2 text-muted ml-auto"><Archive size={14} /></button>
                    )}
                  </div>
                </CardBody>
              </Card>
            );
          })}
          <p className="text-xs text-muted">
            Acúmulo: tiers superiores herdam os perks dos inferiores. Reordene com as setas ↑/↓.
          </p>
        </div>

        {/* perk catalog */}
        <div>
          <Card>
            <CardHeader
              eyebrow="Catálogo plugável"
              title="Perks"
              action={<Button size="sm" variant="ghost" onClick={() => setAddingPerk(true)}><Plus size={14} /></Button>}
            />
            <CardBody className="space-y-2">
              {perks.map((p) => {
                const pt = perkType(p.type);
                const prov = perkProvision(db, orgId, p.type);
                return (
                  <div key={p.id} className="py-2 border-b border-line/50 last:border-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{p.name}</span>
                      {prov.requiresConnection && (
                        prov.connected ? (
                          <Badge tone="success"><Check size={9} /> {prov.connector?.label}</Badge>
                        ) : (
                          <Link to="/admin/integrations">
                            <Badge tone="warning"><Plug size={9} /> conectar {prov.connector?.label}</Badge>
                          </Link>
                        )
                      )}
                    </div>
                    <div className="text-xs text-muted">{pt?.label}</div>
                  </div>
                );
              })}
            </CardBody>
          </Card>
          <p className="text-xs text-muted mt-3">
            Perks que dependem de uma ferramenta mostram o status da conexão — configure em Integrações.
          </p>
        </div>
      </div>

      {editing && (
        <TierEditor
          orgId={orgId}
          tier={editing === "new" ? null : editing}
          perks={perks}
          onClose={() => setEditing(null)}
        />
      )}
      {addingPerk && <PerkCreator orgId={orgId} onClose={() => setAddingPerk(false)} />}
    </div>
  );
}

function TierEditor({
  orgId, tier, perks, onClose,
}: {
  orgId: string;
  tier: Tier | null;
  perks: ReturnType<typeof listPerks>;
  onClose: () => void;
}) {
  const [name, setName] = useState(tier?.name ?? "");
  const [description, setDescription] = useState(tier?.description ?? "");
  const [price, setPrice] = useState(String(tier?.price ?? 0));
  const [period, setPeriod] = useState<Period>(tier?.period ?? "monthly");
  const [color, setColor] = useState(tier?.color ?? "#6d28d9");
  const [capacity, setCapacity] = useState(tier?.capacity ? String(tier.capacity) : "");
  const [perkIds, setPerkIds] = useState<string[]>(tier?.perkIds ?? []);

  const save = () => {
    saveTier(orgId, {
      id: tier?.id, name, description, price: Number(price) || 0, period, color,
      capacity: capacity ? Number(capacity) : null, perkIds,
    });
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      eyebrow={tier ? "Editar tier" : "Novo tier"}
      title={tier ? tier.name : "Criar tier"}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button onClick={save} disabled={!name}>Salvar</Button></>}
    >
      <div className="grid grid-cols-2 gap-x-4">
        <div className="col-span-2"><Field label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Founder" /></Field></div>
        <div className="col-span-2"><Field label="Descrição"><Input value={description} onChange={(e) => setDescription(e.target.value)} /></Field></div>
        <Field label="Preço (R$)"><Input type="number" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
        <Field label="Período">
          <Select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            {PERIODS.map((p) => <option key={p} value={p}>{periodLabel[p]}</option>)}
          </Select>
        </Field>
        <Field label="Cor"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="w-full h-10 rounded-xl border border-line bg-surface cursor-pointer" /></Field>
        <Field label="Vagas (vazio = ilimitado)"><Input type="number" value={capacity} onChange={(e) => setCapacity(e.target.value)} placeholder="∞" /></Field>
      </div>

      {Number(price) > 0 && (
        <p className="text-xs text-muted -mt-2 mb-4">
          {installmentsAllowed(period)
            ? "Parcelamento habilitado (até 12×, juros ao cliente)."
            : "Período mensal não permite parcelamento."}
        </p>
      )}

      <Label>Perks deste tier</Label>
      <div className="grid grid-cols-2 gap-2 mt-1">
        {perks.map((p) => {
          const on = perkIds.includes(p.id);
          return (
            <button
              key={p.id}
              onClick={() => setPerkIds((ids) => (on ? ids.filter((x) => x !== p.id) : [...ids, p.id]))}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-left text-sm transition-colors ${on ? "border-[var(--color-primary)] bg-[var(--color-primary)]/5" : "border-line hover:border-content/30"}`}
            >
              <Gift size={13} className={on ? "text-[var(--color-primary)]" : "text-muted"} />
              <span className="truncate">{p.name}</span>
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}

function PerkCreator({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const [type, setType] = useState<PerkTypeKey>("exclusive_content");
  const [name, setName] = useState("");
  const [config, setConfig] = useState<Record<string, string>>({});
  const pt = perkType(type)!;

  const create = () => {
    createPerk(orgId, { type, name: name || pt.label, config });
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      eyebrow="Catálogo de perks"
      title="Novo perk"
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button onClick={create}>Criar perk</Button></>}
    >
      <Field label="Tipo de perk">
        <Select value={type} onChange={(e) => { setType(e.target.value as PerkTypeKey); setConfig({}); }}>
          {PERK_CATALOG.map((c) => <option key={c.key} value={c.key}>{c.label}{c.integration ? ` · ${c.integration}` : ""}</option>)}
        </Select>
      </Field>
      <p className="text-xs text-muted -mt-2 mb-4">{pt.description}</p>
      <Field label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={pt.label} /></Field>
      {pt.configSchema.map((f) => (
        <Field key={f.key} label={f.label}>
          {f.type === "select" ? (
            <Select value={config[f.key] ?? ""} onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))}>
              <option value="">—</option>
              {f.options?.map((o) => <option key={o} value={o}>{o}</option>)}
            </Select>
          ) : (
            <Input
              type={f.type === "number" ? "number" : "text"}
              value={config[f.key] ?? ""}
              onChange={(e) => setConfig((c) => ({ ...c, [f.key]: e.target.value }))}
            />
          )}
        </Field>
      ))}
    </Dialog>
  );
}
