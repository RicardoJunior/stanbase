import { useNavigate, useParams } from "react-router-dom";
import { listMembers, getProfile, getTier } from "@/lib/api";
import { memberSession } from "@/lib/session";
import { formatMemberId } from "@/lib/ids";
import { useMemberOrg } from "../useMemberOrg";

export default function Login() {
  const { orgSlug } = useParams();
  const { org, db } = useMemberOrg();
  const navigate = useNavigate();
  if (!org) return null;

  const personas = listMembers(db, org.id)
    .filter((m) => m.status !== "lead")
    .slice(0, 6);

  const loginAs = (id: string) => {
    memberSession.set(id);
    navigate(`/m/${orgSlug}/app`);
  };

  return (
    <main className="max-w-md mx-auto px-6 py-16">
      <div className="text-center mb-8">
        <span className="eyebrow" style={{ color: "var(--color-accent)" }}>Bem-vindo de volta</span>
        <h1 className="font-display text-3xl mt-2">Entrar na {org.name}</h1>
      </div>

      <div className="space-y-2.5 mb-6">
        {(["Google", "Apple", "X"] as const).map((p) => (
          <button
            key={p}
            onClick={() => personas[0] && loginAs(personas[0].id)}
            className="w-full rounded-xl border border-line px-4 py-3 text-sm font-medium hover:border-content/40 transition-colors"
          >
            Continuar com {p}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-3 my-6">
        <div className="h-px bg-line flex-1" />
        <span className="font-mono text-[0.62rem] uppercase tracking-wide text-muted">ou entre como (demo)</span>
        <div className="h-px bg-line flex-1" />
      </div>

      <div className="space-y-2">
        {personas.map((m) => {
          const p = getProfile(db, m.id);
          const tier = getTier(db, m.tierId);
          return (
            <button
              key={m.id}
              onClick={() => loginAs(m.id)}
              className="w-full flex items-center gap-3 rounded-xl border border-line px-4 py-3 text-left hover:border-content/40 transition-colors"
            >
              <span className="w-9 h-9 rounded-full flex items-center justify-center font-mono text-xs" style={{ background: "var(--color-surface-2, #2a2820)", border: "1px solid var(--color-border)" }}>
                {p?.name?.[0]}
              </span>
              <span className="flex-1">
                <span className="block text-sm font-medium">{p?.name}</span>
                <span className="block font-mono text-[0.68rem] text-muted">{formatMemberId(m.memberId)} · {tier?.name ?? "—"}</span>
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-center text-xs text-muted mt-6 font-mono">REPLAN: Supabase Auth (OTP + Google/Apple/X)</p>
    </main>
  );
}
