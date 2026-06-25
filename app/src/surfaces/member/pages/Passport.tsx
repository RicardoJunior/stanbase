import { Navigate, useParams } from "react-router-dom";
import { Apple, Smartphone, ShieldCheck } from "lucide-react";
import { getProfile, getTier, listMemberPasses } from "@/lib/api";
import { formatMemberId } from "@/lib/ids";
import { verifyUrl } from "@/lib/verify-token";
import { MemberCard } from "@/components/MemberCard";
import { Qr } from "@/components/Qr";
import { useMemberOrg } from "../useMemberOrg";

export default function Passport() {
  const { orgSlug } = useParams();
  const { org, member, db } = useMemberOrg();
  if (!org) return null;
  if (!member) return <Navigate to={`/m/${orgSlug}/login`} replace />;

  const p = getProfile(db, member.id);
  const tier = getTier(db, member.tierId);
  const passes = listMemberPasses(db, member.id);
  const membershipPass = passes.find((x) => x.type === "membership");
  const url = verifyUrl(member.memberId);

  return (
    <main className="max-w-4xl mx-auto px-6 py-12">
      <div className="text-center mb-8">
        <span className="eyebrow" style={{ color: "var(--color-accent)" }}>Passport</span>
        <h1 className="font-display text-3xl mt-2">Sua carteirinha na carteira do celular</h1>
        <p className="text-muted mt-2 max-w-lg mx-auto">
          Adicione à Apple Wallet ou Google Wallet. O QR carrega um token assinado — a portaria valida
          online, sem dar para forjar.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-10 items-center">
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

        <div>
          <div className="flex flex-col gap-3 mb-6">
            <button
              onClick={() => alert("REPLAN: gera e assina .pkpass real (certificado Apple Pass Type ID).")}
              className="flex items-center justify-center gap-2.5 rounded-xl px-5 py-3.5 font-medium"
              style={{ background: "#000", color: "#fff" }}
            >
              <Apple size={18} /> Adicionar à Apple Wallet
            </button>
            <button
              onClick={() => alert("REPLAN: JWT 'Save to Google Wallet' assinado por service account.")}
              className="flex items-center justify-center gap-2.5 rounded-xl px-5 py-3.5 font-medium border border-line"
            >
              <Smartphone size={18} /> Adicionar à Google Wallet
            </button>
          </div>

          <div className="rounded-2xl border border-line p-5 text-center" style={{ background: "var(--color-surface)" }}>
            <div className="font-mono text-[0.62rem] uppercase tracking-wide text-muted mb-3">QR de validação</div>
            <div className="inline-block p-3 rounded-xl bg-white">
              <Qr data={member.memberId} to={url} size={150} />
            </div>
            <div className="font-mono text-sm mt-3">{formatMemberId(member.memberId)}</div>
            <p className="flex items-center justify-center gap-1.5 text-xs text-muted mt-2">
              <ShieldCheck size={12} /> token assinado · expira em ~12h · clique para validar
            </p>
          </div>

          {membershipPass && (
            <p className="text-center text-xs text-muted mt-3 font-mono">
              passe {membershipPass.platform} · série {membershipPass.serial}
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
