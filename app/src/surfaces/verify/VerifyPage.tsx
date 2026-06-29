import { type CSSProperties } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";
import { CheckCircle2, AlertTriangle, XCircle, ShieldCheck, Lock } from "lucide-react";
import { useStore } from "@/lib/store";
import { getMemberByCode, getOrg, getProfile, getTier } from "@/lib/api";
import { verifyMemberToken } from "@/lib/verify-token";
import { resolveThemeVars } from "@/lib/theme";
import { formatMemberId, normalizeMemberId } from "@/lib/ids";

/**
 * Public member validation (§9). PII levels (Q70):
 *  L0 (no token): brand + tier + status + "membro desde" — minimal, no PII.
 *  L1 (valid token from QR): + abbreviated name; photo OFF by default.
 *  L2 (staff): handled by the operator console (/checkin).
 */
function abbreviate(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

export default function VerifyPage() {
  const { memberId = "" } = useParams();
  const [params] = useSearchParams();
  const db = useStore((d) => d);

  const member = getMemberByCode(db, memberId);
  const org = member ? getOrg(db, member.orgId) : undefined;
  const token = params.get("token");
  const tokenResult = token ? verifyMemberToken(token) : null;
  // a valid token only unlocks PII for the member it was issued to: the embedded
  // memberId must match the member in the URL (prevents using A's token on B's page).
  const tokenOk =
    !!tokenResult &&
    tokenResult.valid &&
    !!member &&
    normalizeMemberId(tokenResult.memberId) === normalizeMemberId(member.memberId);
  const tokenFailed = !!tokenResult && !tokenOk;

  const themeVars = (org ? resolveThemeVars(org.theme, "dark") : {}) as CSSProperties;

  let state: "valid" | "grace" | "inactive" | "notfound";
  if (!member) state = "notfound";
  else if (member.status === "canceled") state = "inactive";
  else if (member.status === "past_due") state = "grace";
  else state = "valid";

  const profile = member ? getProfile(db, member.id) : undefined;
  const tier = member ? getTier(db, member.tierId) : undefined;

  const config = {
    valid: { Icon: CheckCircle2, color: "#3f7d4e", label: "Membro válido" },
    grace: { Icon: AlertTriangle, color: "#b8861f", label: "Válido — pendência no grace" },
    inactive: { Icon: XCircle, color: "#b4453a", label: "Membership inativo" },
    notfound: { Icon: XCircle, color: "#b4453a", label: "Member ID não encontrado" },
  }[state];

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-obsidian text-[#efe9da]" data-theme="dark" style={themeVars}>
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          {org ? (
            <div className="font-display text-2xl lowercase" style={{ color: "var(--color-accent, #b8965a)" }}>
              {org.logoText}
            </div>
          ) : (
            <div className="font-display text-2xl">stan<b style={{ color: "#b8965a" }}>base</b></div>
          )}
          <div className="font-mono text-[0.6rem] uppercase tracking-[0.2em] text-[#efe9da]/50 mt-1">
            validação de membro
          </div>
        </div>

        <div className="rounded-2xl border p-8 text-center" style={{ borderColor: config.color + "55", background: "rgba(255,255,255,.03)" }}>
          <config.Icon size={56} style={{ color: config.color }} className="mx-auto mb-4" />
          <div className="font-display text-2xl mb-1">{config.label}</div>
          <div className="font-mono text-sm text-[#efe9da]/60">{formatMemberId(memberId)}</div>

          {member && state !== "inactive" && (
            <div className="mt-6 pt-6 border-t border-[#efe9da]/10 space-y-3 text-left">
              {tier && (
                <Row label="Tier">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full" style={{ background: tier.color }} /> {tier.name}
                  </span>
                </Row>
              )}
              <Row label="Status">{state === "grace" ? "Ativo (grace)" : "Ativo"}</Row>
              <Row label="Membro desde">{new Date(member.joinedAt).toLocaleDateString("pt-BR", { month: "long", year: "numeric" })}</Row>
              {tokenOk && profile && <Row label="Nome">{abbreviate(profile.name)}</Row>}
            </div>
          )}

          <div className="mt-6 flex items-center justify-center gap-1.5 text-xs text-[#efe9da]/50">
            {tokenOk ? (
              <><ShieldCheck size={13} style={{ color: config.color }} /> token assinado válido</>
            ) : tokenFailed ? (
              <><Lock size={13} />{" "}
                {tokenResult && !tokenResult.valid && tokenResult.reason === "expired"
                  ? "token expirado — faça o scan novamente"
                  : "token inválido — visão pública mínima"}
              </>
            ) : (
              <><Lock size={13} /> visão pública mínima — sem PII</>
            )}
          </div>
        </div>

        <p className="text-center text-[0.7rem] text-[#efe9da]/40 mt-5 font-mono">
          {org?.name ?? "stanbase"} · verify.stanbase.com · LGPD: foto OFF por padrão
        </p>
        <div className="text-center mt-4">
          <Link to="/checkin" className="text-sm underline text-[#efe9da]/50 hover:text-[#efe9da]">Sou staff — abrir portaria</Link>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-[#efe9da]/55">{label}</span>
      <span>{children}</span>
    </div>
  );
}
