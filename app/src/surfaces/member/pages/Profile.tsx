import { useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { Check } from "lucide-react";
import { getProfile, getTier, updateMemberProfile } from "@/lib/api";
import { formatMemberId } from "@/lib/ids";
import { Field, Input, Button, Switch } from "@/components/ui";
import { useMemberOrg } from "../useMemberOrg";

export default function Profile() {
  const { orgSlug } = useParams();
  const { org, member, db } = useMemberOrg();
  const p = member ? getProfile(db, member.id) : undefined;

  const [name, setName] = useState(p?.name ?? "");
  const [email, setEmail] = useState(p?.email ?? "");
  const [phone, setPhone] = useState(p?.phone ?? "");
  const [address, setAddress] = useState(p?.address ?? "");
  const [consents, setConsents] = useState(p?.consents ?? { email: true, whatsapp: false, push: true, photoPublic: false });
  const [saved, setSaved] = useState(false);

  if (!org) return null;
  if (!member || !p) return <Navigate to={`/m/${orgSlug}/login`} replace />;
  const tier = getTier(db, member.tierId);

  const dirty =
    name !== (p.name ?? "") || email !== (p.email ?? "") || phone !== (p.phone ?? "") ||
    address !== (p.address ?? "") || JSON.stringify(consents) !== JSON.stringify(p.consents);

  const save = () => {
    updateMemberProfile(member.id, { name, email, phone, address, consents });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const setConsent = (k: keyof typeof consents, v: boolean) => setConsents((c) => ({ ...c, [k]: v }));

  return (
    <main className="max-w-xl mx-auto px-6 py-12">
      <span className="eyebrow" style={{ color: "var(--color-accent)" }}>Meu perfil</span>
      <h1 className="font-display text-3xl mt-2 mb-6">Olá, {p.name.split(" ")[0]}</h1>

      {/* read-only identity */}
      <div className="rounded-2xl border border-line p-4 mb-6 grid grid-cols-3 gap-3 text-center" style={{ background: "var(--color-surface)" }}>
        <RO label="Member ID" value={formatMemberId(member.memberId)} />
        <RO label="Tier" value={tier?.name ?? "—"} />
        <RO label="Membro desde" value={new Date(member.joinedAt).toLocaleDateString("pt-BR", { month: "short", year: "numeric" })} />
      </div>

      {/* editable */}
      <Field label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="E-mail"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@email.com" /></Field>
      <Field label="Telefone / WhatsApp"><Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+55 11 90000-0000" /></Field>
      <Field label="Endereço"><Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Rua, número — cidade/UF" /></Field>

      {p.attributes.gamertag !== undefined && (
        <Field label="Gamertag"><Input value={p.attributes.gamertag} disabled className="opacity-60" /></Field>
      )}

      <div className="mt-2 mb-6">
        <div className="font-mono text-[0.66rem] tracking-[0.12em] uppercase text-muted mb-3">Preferências de contato</div>
        <div className="space-y-3">
          <ConsentRow label="Receber e-mails" checked={consents.email} onChange={(v) => setConsent("email", v)} />
          <ConsentRow label="Receber no WhatsApp" checked={consents.whatsapp} onChange={(v) => setConsent("whatsapp", v)} />
          <ConsentRow label="Notificações push" checked={consents.push} onChange={(v) => setConsent("push", v)} />
          <ConsentRow label="Exibir minha foto na validação pública" checked={consents.photoPublic} onChange={(v) => setConsent("photoPublic", v)} />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={!dirty}>{saved ? <><Check size={15} /> Salvo</> : "Salvar alterações"}</Button>
        {dirty && (
          <Button variant="ghost" onClick={() => { setName(p.name ?? ""); setEmail(p.email ?? ""); setPhone(p.phone ?? ""); setAddress(p.address ?? ""); setConsents(p.consents); }}>
            Descartar
          </Button>
        )}
      </div>
    </main>
  );
}

function RO({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[0.55rem] uppercase tracking-wide text-muted">{label}</div>
      <div className="font-medium text-sm mt-0.5">{value}</div>
    </div>
  );
}

function ConsentRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-content">{label}</span>
      <Switch checked={checked} onChange={onChange} />
    </div>
  );
}
