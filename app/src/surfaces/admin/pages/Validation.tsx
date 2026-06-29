import { useState } from "react";
import { ScanLine, ExternalLink, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";
import { Link } from "react-router-dom";
import { useStore } from "@/lib/store";
import { performCheckin, getProfile, getTier, getMember } from "@/lib/api";
import { formatMemberId } from "@/lib/ids";
import { SectionHead, Card, CardHeader, CardBody, Button, Input, Field, Badge } from "@/components/ui";
import { useAdminOrg } from "../useAdminOrg";

export default function Validation() {
  const { orgId } = useAdminOrg();
  const db = useStore((d) => d);
  const [code, setCode] = useState("");
  const [outcome, setOutcome] = useState<ReturnType<typeof performCheckin> | null>(null);

  if (!orgId) return null;
  const recent = db.checkins.filter((c) => c.orgId === orgId).slice(-8).reverse();

  const run = () => {
    if (!code.trim()) return;
    setOutcome(performCheckin(orgId, code.trim(), "Equipe Portaria"));
    setCode("");
  };

  const Icon = outcome?.result === "ok" ? CheckCircle2 : outcome?.result === "grace" ? AlertTriangle : XCircle;
  const tone = outcome?.result === "ok" ? "success" : outcome?.result === "grace" ? "warning" : "danger";

  return (
    <div>
      <SectionHead
        eyebrow="Portaria"
        title="Validação & Check-in"
        desc="Escaneie o QR ou digite o Member ID. Com pagamento pendente, o membro passa com aviso amarelo."
        action={
          <Link to="/checkin" target="_blank">
            <Button variant="ghost" size="sm"><ExternalLink size={15} /> Modo operador (tela cheia)</Button>
          </Link>
        }
      />

      <div className="grid lg:grid-cols-2 gap-5">
        <Card>
          <CardHeader eyebrow="Scanner" title={<span className="flex items-center gap-2"><ScanLine size={18} /> Validar membro</span>} />
          <CardBody>
            <Field label="Member ID" hint="Ex.: B7K2-M9X4. Aceita com ou sem hífen.">
              <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="B7K2-M9X4" onKeyDown={(e) => e.key === "Enter" && run()} className="font-mono uppercase" />
            </Field>
            <Button onClick={run} disabled={!code.trim()}>Validar & check-in</Button>

            {outcome && (
              <div className={`mt-5 p-4 rounded-xl border flex items-start gap-3 ${tone === "success" ? "border-success/40 bg-success/5" : tone === "warning" ? "border-warning/40 bg-warning/5" : "border-danger/40 bg-danger/5"}`}>
                <Icon size={22} className={tone === "success" ? "text-success" : tone === "warning" ? "text-warning" : "text-danger"} />
                <div>
                  <div className="font-medium">{outcome.message}</div>
                  {outcome.member && (
                    <div className="text-sm text-muted mt-0.5">
                      {getProfile(db, outcome.member.id)?.name} · {getTier(db, outcome.member.tierId)?.name ?? "—"} · {formatMemberId(outcome.member.memberId)}
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader eyebrow="Ao vivo" title="Check-ins recentes" />
          <CardBody className="space-y-2">
            {recent.length === 0 && <p className="text-muted text-sm">Nenhum check-in ainda. Valide um Member ID ao lado.</p>}
            {recent.map((c) => {
              const m = getMember(db, c.memberId);
              return (
                <div key={c.id} className="flex items-center justify-between py-2 border-b border-line/50 last:border-0">
                  <div>
                    <div className="text-sm font-medium">{m ? getProfile(db, m.id)?.name : c.memberId}</div>
                    <div className="text-xs text-muted">{new Date(c.at).toLocaleTimeString("pt-BR")} · {c.operator}</div>
                  </div>
                  <Badge tone={c.result === "ok" ? "success" : c.result === "grace" ? "warning" : "danger"}>{c.result}</Badge>
                </div>
              );
            })}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
