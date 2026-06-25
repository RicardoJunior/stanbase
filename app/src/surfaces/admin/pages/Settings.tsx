import { useState } from "react";
import { Check, X, AlertTriangle, Users, Receipt, ShieldCheck } from "lucide-react";
import { useStore } from "@/lib/store";
import { updateOrgTheme } from "@/lib/api";
import { themeContrastReport } from "@/lib/theme";
import { BRL } from "@/lib/billing";
import { SectionHead, Card, CardHeader, CardBody, Button, Field, Label, Select, Switch, Badge, Tabs } from "@/components/ui";
import { MemberCard } from "@/components/MemberCard";
import { useAdminOrg } from "../useAdminOrg";
import type { OrgTheme, OrgUser, PlatformBillingSettings, Organization } from "@/types/domain";

const FONTS = ["Jost", "Hanken Grotesk", "Space Mono", "Inter", "Sora", "Manrope", "Playfair Display"];
type Tab = "theme" | "team" | "billing" | "lgpd";

export default function Settings() {
  const { org, orgId } = useAdminOrg();
  const db = useStore((d) => d);
  const [tab, setTab] = useState<Tab>("theme");

  if (!org || !orgId) return null;

  return (
    <div>
      <SectionHead eyebrow="Configurações" title="Marca, equipe & faturamento" />
      <Tabs<Tab>
        tabs={[
          { value: "theme", label: "Marca & Tema" },
          { value: "team", label: "Equipe" },
          { value: "billing", label: "Faturamento" },
          { value: "lgpd", label: "LGPD" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="mt-5">
        {tab === "theme" && <ThemeEditor org={org} orgId={orgId} />}
        {tab === "team" && <TeamPanel orgUsers={db.orgUsers.filter((u) => u.orgId === orgId)} />}
        {tab === "billing" && <BillingPanel settings={db.platformBilling} />}
        {tab === "lgpd" && <LgpdPanel />}
      </div>
    </div>
  );
}

function ThemeEditor({ org, orgId }: { org: Organization; orgId: string }) {
  const [draft, setDraft] = useState<OrgTheme>(org.theme);
  const [mode, setMode] = useState<"light" | "dark">(org.theme.defaultMode === "dark" ? "dark" : "light");
  const set = (patch: Partial<OrgTheme>) => setDraft((d) => ({ ...d, ...patch }));
  const report = themeContrastReport(draft, mode);
  const canPublish = !report.some((r) => r.gating && r.verdict === "fail");
  const dirty = JSON.stringify(draft) !== JSON.stringify(org.theme);

  return (
    <div className="grid lg:grid-cols-2 gap-5">
      <div className="space-y-5">
        <Card>
          <CardHeader eyebrow="White-label" title="Identidade da org" />
          <CardBody className="space-y-1">
            <div className="grid grid-cols-2 gap-x-4">
              <Field label="Cor primária">
                <div className="flex items-center gap-2">
                  <input type="color" value={draft.primary ?? "#6d28d9"} onChange={(e) => set({ primary: e.target.value })} className="w-12 h-10 rounded-lg border border-line cursor-pointer" />
                  <span className="font-mono text-sm text-muted">{draft.primary}</span>
                </div>
              </Field>
              <Field label="Cor de realce">
                <div className="flex items-center gap-2">
                  <input type="color" value={draft.accent ?? "#b8965a"} onChange={(e) => set({ accent: e.target.value })} className="w-12 h-10 rounded-lg border border-line cursor-pointer" />
                  <span className="font-mono text-sm text-muted">{draft.accent}</span>
                </div>
              </Field>
              <Field label="Fonte display">
                <Select value={draft.fontDisplay ?? "Jost"} onChange={(e) => set({ fontDisplay: e.target.value })}>
                  {FONTS.map((f) => <option key={f}>{f}</option>)}
                </Select>
              </Field>
              <Field label="Fonte corpo">
                <Select value={draft.fontBody ?? "Hanken Grotesk"} onChange={(e) => set({ fontBody: e.target.value })}>
                  {FONTS.map((f) => <option key={f}>{f}</option>)}
                </Select>
              </Field>
            </div>
            <div className="flex items-center gap-6 pt-1">
              <div>
                <Label>Modo padrão</Label>
                <Select value={draft.defaultMode ?? "system"} onChange={(e) => set({ defaultMode: e.target.value as OrgTheme["defaultMode"] })}>
                  <option value="light">Claro</option>
                  <option value="dark">Escuro</option>
                  <option value="system">Sistema</option>
                </Select>
              </div>
              <div className="pt-5">
                <Switch checked={draft.darkEnabled ?? true} onChange={(v) => set({ darkEnabled: v })} label="Dark habilitado" />
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader eyebrow="Acessibilidade" title="Contraste (gate de publicação)" />
          <CardBody className="space-y-2">
            {report.map((r) => (
              <div key={r.pair} className="flex items-center justify-between text-sm">
                <span className="text-muted">{r.pair}</span>
                <span className="flex items-center gap-2">
                  <span className="font-mono">{r.ratio}:1</span>
                  {r.verdict === "pass" ? <Badge tone="success"><Check size={10} /> AA</Badge>
                    : r.verdict === "aa-large" ? <Badge tone="warning"><AlertTriangle size={10} /> AA-large</Badge>
                    : r.gating ? <Badge tone="danger"><X size={10} /> falha</Badge>
                    : <Badge tone="warning"><AlertTriangle size={10} /> só acento</Badge>}
                </span>
              </div>
            ))}
            <p className="text-xs text-muted pt-2 border-t border-line">
              `*-contrast` é derivado automaticamente; publicação bloqueia abaixo de 3:1 em texto (§23.1.5).
            </p>
          </CardBody>
        </Card>

        <div className="flex gap-3">
          <Button disabled={!canPublish || !dirty} onClick={() => updateOrgTheme(orgId, draft)}>
            {canPublish ? "Publicar tema" : "Corrija o contraste para publicar"}
          </Button>
          {dirty && <Button variant="ghost" onClick={() => setDraft(org.theme)}>Descartar</Button>}
        </div>
      </div>

      {/* live preview */}
      <div>
        <div className="sticky top-24">
          <div className="flex items-center justify-between mb-3">
            <Label>Preview ao vivo</Label>
            <div className="flex gap-1 text-xs">
              <button onClick={() => setMode("light")} className={`px-2.5 py-1 rounded-lg ${mode === "light" ? "bg-surface-2 border border-line" : "text-muted"}`}>claro</button>
              <button onClick={() => setMode("dark")} className={`px-2.5 py-1 rounded-lg ${mode === "dark" ? "bg-surface-2 border border-line" : "text-muted"}`}>escuro</button>
            </div>
          </div>
          <div
            className="rounded-2xl border border-line p-6"
            data-theme={mode}
            style={{
              background: mode === "dark" ? "#15140f" : "#fffefb",
              ["--color-primary" as string]: draft.primary,
              ["--color-accent" as string]: draft.accent,
            }}
          >
            <div className="eyebrow mb-2" style={{ color: draft.accent }}>{org.name}</div>
            <h3 className="font-display text-2xl mb-1" style={{ fontFamily: `"${draft.fontDisplay ?? "Jost"}", sans-serif`, color: mode === "dark" ? "#efe9da" : "#16150f" }}>
              {org.tagline}
            </h3>
            <p className="text-sm mb-5" style={{ fontFamily: `"${draft.fontBody ?? "Hanken Grotesk"}", sans-serif`, color: mode === "dark" ? "rgba(239,233,218,.65)" : "#5d584c" }}>
              Esta é a cara da sua área de membro. Cores, fontes e arte da carteirinha mudam aqui.
            </p>
            <button className="rounded-full px-5 py-2.5 text-sm font-medium mb-6" style={{ background: draft.primary, color: "#fff" }}>
              Assinar Membro
            </button>
            <MemberCard
              orgLogoText={org.logoText}
              memberName="seu maior fã"
              memberIdCode="B7K2M9X4"
              tierName="Founder"
              tierColor={draft.accent}
              joinedAt={new Date().toISOString()}
              art={draft.memberCardArt}
              showQr
            />
          </div>
          <p className="text-xs text-muted mt-3">REPLAN: preview por iframe do member-app real + republish de passes ao mudar a arte (§23.1.6).</p>
        </div>
      </div>
    </div>
  );
}

function TeamPanel({ orgUsers }: { orgUsers: OrgUser[] }) {
  return (
    <Card>
      <CardHeader eyebrow="Permissões" title={<span className="flex items-center gap-2"><Users size={17} /> Equipe & papéis</span>} />
      <CardBody className="space-y-3">
        {orgUsers.map((u) => (
          <div key={u.id} className="flex items-center justify-between py-2 border-b border-line/50 last:border-0">
            <div>
              <div className="text-sm font-medium">{u.name}</div>
              <div className="text-xs text-muted">{u.email}</div>
            </div>
            <Badge tone={u.role === "owner" ? "gold" : u.role === "admin" ? "primary" : "neutral"}>{u.role}</Badge>
          </div>
        ))}
        <p className="text-xs text-muted pt-1">Presets dos 3 papéis (owner/admin/operator) no MVP; templates reutilizáveis pós-MVP (Q16).</p>
      </CardBody>
    </Card>
  );
}

function BillingPanel({ settings }: { settings: PlatformBillingSettings }) {
  const rows = [
    { label: "Comissão base (all-in)", value: `${(settings.baseCommissionRate * 100).toFixed(2)}%`, note: "Pix · à vista · parcelado" },
    { label: "Juros de parcelamento (cliente)", value: `${(settings.installmentInterestRateAm * 100).toFixed(2)}% a.m.`, note: "pass-through, modelo Hotmart" },
    { label: "Teto de parcelas", value: `${settings.maxInstallments}×`, note: "só tri/semestral/anual" },
    { label: "Antecipação Asaas (custo)", value: `${(settings.pspAnticipationRateAm * 100).toFixed(2)}% a.m.`, note: "spread = juros − custo" },
  ];
  return (
    <Card>
      <CardHeader eyebrow="Plataforma" title={<span className="flex items-center gap-2"><Receipt size={17} /> Parâmetros de faturamento</span>} />
      <CardBody className="space-y-3">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between py-2 border-b border-line/50 last:border-0">
            <div>
              <div className="text-sm font-medium">{r.label}</div>
              <div className="text-xs text-muted">{r.note}</div>
            </div>
            <span className="font-mono text-lg">{r.value}</span>
          </div>
        ))}
        <p className="text-xs text-muted pt-1">Padrão Stanbase global (não configurável por org). Editável no superadmin. {BRL(0)} de mensalidade.</p>
      </CardBody>
    </Card>
  );
}

function LgpdPanel() {
  return (
    <Card>
      <CardHeader eyebrow="Privacidade" title={<span className="flex items-center gap-2"><ShieldCheck size={17} /> LGPD & direitos do titular</span>} />
      <CardBody className="space-y-4">
        <p className="text-sm text-muted">
          Consentimento por canal, minimização na rota pública (foto OFF por padrão), exportar/retificar/anonimizar dados,
          DPA com sub-processadores. Dados de cartão nunca tocam a Stanbase (tokenização no PSP).
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" size="sm" onClick={() => alert("Export de dados — auditado (REPLAN: DSR real).")}>Exportar dados (DSR)</Button>
          <Button variant="ghost" size="sm" onClick={() => alert("Anonimização preserva registros financeiros legais (REPLAN).")}>Anonimizar membro</Button>
        </div>
      </CardBody>
    </Card>
  );
}
