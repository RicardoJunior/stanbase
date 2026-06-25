import { Navigate, useParams } from "react-router-dom";
import { getProfile, getTier } from "@/lib/api";
import { formatMemberId } from "@/lib/ids";
import { useMemberOrg } from "../useMemberOrg";

export default function Profile() {
  const { orgSlug } = useParams();
  const { org, member, db } = useMemberOrg();
  if (!org) return null;
  if (!member) return <Navigate to={`/m/${orgSlug}/login`} replace />;
  const p = getProfile(db, member.id);
  const tier = getTier(db, member.tierId);

  return (
    <main className="max-w-xl mx-auto px-6 py-12">
      <span className="eyebrow" style={{ color: "var(--color-accent)" }}>Perfil</span>
      <h1 className="font-display text-3xl mt-2 mb-6">{p?.name}</h1>
      <dl className="space-y-3">
        <Row label="Member ID" value={formatMemberId(member.memberId)} />
        <Row label="Tier" value={tier?.name ?? "—"} />
        <Row label="E-mail" value={p?.email ?? "—"} />
        <Row label="Membro desde" value={new Date(member.joinedAt).toLocaleDateString("pt-BR")} />
        <Row label="Gamertag" value={p?.attributes.gamertag ?? "—"} />
      </dl>
      <p className="text-xs text-muted mt-8 font-mono">
        Você edita contatos e consentimentos; atributos operacionais são read-only (Q36).
      </p>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-line py-2.5">
      <dt className="text-muted">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
