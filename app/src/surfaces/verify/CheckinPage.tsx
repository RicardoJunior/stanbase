import { useState } from "react";
import { ScanLine, CheckCircle2, AlertTriangle, XCircle, Ban } from "lucide-react";
import { useStore } from "@/lib/store";
import { listOrgs, listEvents, performCheckin, getProfile, getTier } from "@/lib/api";
import { formatMemberId } from "@/lib/ids";

/** Operator console (§15) — full-screen door check-in. L2 staff view. */
export default function CheckinPage() {
  const db = useStore((d) => d);
  const orgs = listOrgs(db);
  const [orgId, setOrgId] = useState(orgs[0]?.id ?? "");
  const events = orgId ? listEvents(db, orgId) : [];
  const [eventId, setEventId] = useState<string>("");
  const [code, setCode] = useState("");
  const [outcome, setOutcome] = useState<ReturnType<typeof performCheckin> | null>(null);

  const recent = db.checkins.filter((c) => c.orgId === orgId).slice(-10).reverse();

  const run = () => {
    if (!code.trim() || !orgId) return;
    setOutcome(performCheckin(orgId, code.trim(), "Operador (porta)", eventId || undefined));
    setCode("");
  };

  const cfg = outcome
    ? {
        ok: { Icon: CheckCircle2, color: "#3f7d4e", bg: "rgba(63,125,78,.12)" },
        grace: { Icon: AlertTriangle, color: "#d8a93a", bg: "rgba(216,169,58,.12)" },
        denied: { Icon: XCircle, color: "#d36a5e", bg: "rgba(211,106,94,.12)" },
        already_used: { Icon: Ban, color: "#d36a5e", bg: "rgba(211,106,94,.12)" },
      }[outcome.result]
    : null;

  const member = outcome?.member;
  const profile = member ? getProfile(db, member.id) : undefined;
  const tier = member ? getTier(db, member?.tierId) : undefined;

  return (
    <div className="min-h-screen bg-obsidian text-[#efe9da]" data-theme="dark">
      <header className="border-b border-[#efe9da]/10 px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2 font-display text-lg">
          <ScanLine size={20} style={{ color: "#b8965a" }} /> Portaria
        </div>
        <div className="flex items-center gap-2">
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)} className="bg-transparent border border-[#efe9da]/15 rounded-lg px-3 py-1.5 text-sm">
            {orgs.map((o) => <option key={o.id} value={o.id} className="text-black">{o.name}</option>)}
          </select>
          <select value={eventId} onChange={(e) => setEventId(e.target.value)} className="bg-transparent border border-[#efe9da]/15 rounded-lg px-3 py-1.5 text-sm">
            <option value="" className="text-black">Sem evento (membership)</option>
            {events.map((e) => <option key={e.id} value={e.id} className="text-black">{e.name}</option>)}
          </select>
        </div>
      </header>

      <div className="max-w-xl mx-auto px-6 py-12">
        <label className="block font-mono text-[0.62rem] uppercase tracking-[0.18em] text-[#efe9da]/50 mb-2 text-center">
          Escaneie o QR ou digite o Member ID
        </label>
        <input
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder="B7K2-M9X4"
          className="w-full bg-transparent border-2 border-[#efe9da]/20 rounded-2xl px-6 py-5 text-center font-mono text-3xl tracking-[0.15em] uppercase focus:outline-none focus:border-[#b8965a]"
        />
        <button
          onClick={run}
          disabled={!code.trim()}
          className="w-full mt-4 rounded-2xl py-4 font-medium text-lg disabled:opacity-40"
          style={{ background: "#b8965a", color: "#15140f" }}
        >
          Validar & check-in
        </button>

        {outcome && cfg && (
          <div className="mt-8 rounded-2xl border p-8 text-center" style={{ borderColor: cfg.color + "66", background: cfg.bg }}>
            <cfg.Icon size={72} style={{ color: cfg.color }} className="mx-auto mb-4" />
            <div className="font-display text-3xl mb-1">{outcome.message}</div>
            {member && (
              <div className="mt-5 pt-5 border-t border-[#efe9da]/10">
                <div className="font-display text-2xl">{profile?.name}</div>
                <div className="flex items-center justify-center gap-3 mt-2 text-[#efe9da]/70">
                  {tier && (
                    <span className="inline-flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: tier.color }} /> {tier.name}
                    </span>
                  )}
                  <span className="font-mono">{formatMemberId(member.memberId)}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {recent.length > 0 && (
          <div className="mt-10">
            <div className="font-mono text-[0.62rem] uppercase tracking-[0.18em] text-[#efe9da]/50 mb-3">Recentes</div>
            <div className="space-y-1.5">
              {recent.map((c) => {
                const p = getProfile(db, c.memberId);
                const color = c.result === "ok" ? "#3f7d4e" : c.result === "grace" ? "#d8a93a" : "#d36a5e";
                return (
                  <div key={c.id} className="flex items-center justify-between py-2 border-b border-[#efe9da]/8 text-sm">
                    <span>{p?.name ?? c.memberId}</span>
                    <span className="flex items-center gap-2 text-[#efe9da]/50">
                      <span>{new Date(c.at).toLocaleTimeString("pt-BR")}</span>
                      <span className="w-2 h-2 rounded-full" style={{ background: color }} />
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <p className="text-center text-[0.7rem] text-[#efe9da]/40 mt-10 font-mono">
em pendência de pagamento o membro passa com aviso amarelo · anti-reuso de ingresso · o operador não vê dados financeiros
        </p>
      </div>
    </div>
  );
}
