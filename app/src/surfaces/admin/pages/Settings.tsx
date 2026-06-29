import { useEffect, useState, type CSSProperties } from "react";
import { Check, X, AlertTriangle, Users, Receipt, ShieldCheck, Plus, Trash2, Mail, Crown, Globe, Copy, Settings2 } from "lucide-react";
import { useStore } from "@/lib/store";
import {
  updateOrgTheme, updateOrg, listOrgUsers, inviteOrgUser, updateOrgUserRole, removeOrgUser, activateOrgUser,
  listCustomDomains, addCustomDomain, verifyCustomDomain, removeCustomDomain, DOMAIN_CNAME_TARGET,
  ROLE_LABEL, ROLE_DESC,
} from "@/lib/api";
import { themeContrastReport, resolveThemeVars } from "@/lib/theme";
import { BRL } from "@/lib/billing";
import { GOOGLE_FONTS, loadGoogleFont } from "@/lib/google-fonts";
import { SectionHead, Card, CardHeader, CardBody, Button, Field, Label, Input, Select, Switch, Badge, Tabs, Dialog, ColorField, Combobox } from "@/components/ui";
import { MemberCard } from "@/components/MemberCard";
import { useAdminOrg } from "../useAdminOrg";
import type { OrgTheme, PlatformBillingSettings, Organization, Role, CustomDomain } from "@/types/domain";

type Tab = "general" | "theme" | "domain" | "team" | "billing" | "lgpd";

export default function Settings() {
  const { org, orgId } = useAdminOrg();
  const db = useStore((d) => d);
  const [tab, setTab] = useState<Tab>("general");

  if (!org || !orgId) return null;

  return (
    <div>
      <SectionHead eyebrow="Configurações" title="Configurações do membership" />
      <Tabs<Tab>
        tabs={[
          { value: "general", label: "Geral" },
          { value: "theme", label: "Marca & Tema" },
          { value: "domain", label: "Domínio" },
          { value: "team", label: "Equipe", count: db.orgUsers.filter((u) => u.orgId === orgId).length },
          { value: "billing", label: "Faturamento" },
          { value: "lgpd", label: "LGPD" },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="mt-5">
        {tab === "general" && <GeneralPanel org={org} orgId={orgId} />}
        {tab === "theme" && <ThemeEditor org={org} orgId={orgId} />}
        {tab === "domain" && <DomainPanel org={org} orgId={orgId} />}
        {tab === "team" && <TeamPanel orgId={orgId} />}
        {tab === "billing" && <BillingPanel settings={db.platformBilling} />}
        {tab === "lgpd" && <LgpdPanel />}
      </div>
    </div>
  );
}

/* ── geral ────────────────────────────────────────────────────── */
function GeneralPanel({ org, orgId }: { org: Organization; orgId: string }) {
  const [name, setName] = useState(org.name);
  const [vertical, setVertical] = useState(org.vertical);
  const [tagline, setTagline] = useState(org.tagline);
  const [logoText, setLogoText] = useState(org.logoText);
  const dirty = name !== org.name || vertical !== org.vertical || tagline !== org.tagline || logoText !== org.logoText;
  const memberUrl = `${window.location.origin}/m/${org.slug}`;

  return (
    <Card>
      <CardHeader eyebrow="Identidade" title={<span className="flex items-center gap-2"><Settings2 size={17} /> Dados da comunidade</span>} />
      <CardBody>
        <div className="grid sm:grid-cols-2 gap-x-4">
          <Field label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Logo (texto)"><Input value={logoText} onChange={(e) => setLogoText(e.target.value)} /></Field>
          <Field label="Vertical"><Input value={vertical} onChange={(e) => setVertical(e.target.value)} placeholder="esports, fitness…" /></Field>
          <Field label="Endereço público" hint="O slug não muda aqui (preserva links).">
            <Input value={memberUrl} readOnly className="opacity-70" />
          </Field>
          <div className="sm:col-span-2"><Field label="Frase de efeito"><Input value={tagline} onChange={(e) => setTagline(e.target.value)} /></Field></div>
        </div>
        <Button disabled={!dirty} onClick={() => updateOrg(orgId, { name, vertical, tagline, logoText })}>Salvar</Button>
        <p className="text-xs text-muted mt-4">
          Um membership tem: dados aqui · tiers &amp; perks · página do membro (blocos) · marca &amp; tema · domínio próprio · integrações · eventos · equipe · faturamento.
        </p>
      </CardBody>
    </Card>
  );
}

/* ── domínio próprio ──────────────────────────────────────────── */
const DOMAIN_STATUS: Record<CustomDomain["status"], { label: string; tone: "neutral" | "warning" | "success" | "danger" }> = {
  pending_dns: { label: "aguardando DNS", tone: "warning" },
  dns_ok: { label: "DNS ok — emitindo SSL", tone: "warning" },
  ssl_issued: { label: "SSL emitido", tone: "warning" },
  active: { label: "ativo", tone: "success" },
  error: { label: "erro", tone: "danger" },
  disabled: { label: "desativado", tone: "neutral" },
};

function DomainPanel({ org, orgId }: { org: Organization; orgId: string }) {
  const db = useStore((d) => d);
  const domains = listCustomDomains(db, orgId);
  const [host, setHost] = useState("");
  const valid = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host.trim());

  return (
    <Card>
      <CardHeader eyebrow="White-label" title={<span className="flex items-center gap-2"><Globe size={17} /> Domínio próprio</span>} />
      <CardBody>
        <p className="text-sm text-muted mb-4">
          Sirva a área de membro no seu domínio (ex.: <code className="font-mono">membros.suacomunidade.com</code>).
          Aponte um <strong>CNAME</strong> para <code className="font-mono">{DOMAIN_CNAME_TARGET}</code> e a gente emite o SSL automaticamente.
          Enquanto não fica ativo, <code className="font-mono">/m/{org.slug}</code> sempre funciona.
        </p>

        <div className="flex gap-2 mb-5">
          <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="membros.suacomunidade.com" className="font-mono" />
          <Button disabled={!valid} onClick={() => { addCustomDomain(orgId, host); setHost(""); }}><Plus size={15} /> Adicionar</Button>
        </div>

        <div className="space-y-2">
          {domains.map((d) => {
            const s = DOMAIN_STATUS[d.status];
            return (
              <div key={d.id} className="rounded-xl border border-line p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-mono text-sm font-medium">{d.host}</div>
                    <div className="text-xs text-muted">CNAME → {DOMAIN_CNAME_TARGET}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={s.tone}>{s.label}</Badge>
                    {d.status !== "active" && <Button size="sm" variant="subtle" onClick={() => verifyCustomDomain(d.id)}>Verificar</Button>}
                    <button onClick={() => removeCustomDomain(d.id)} className="p-2 rounded-lg text-muted hover:text-danger hover:bg-surface-2" aria-label="Remover"><Trash2 size={15} /></button>
                  </div>
                </div>
                {d.status !== "active" && (
                  <button
                    onClick={() => navigator.clipboard?.writeText(`${d.host} CNAME ${DOMAIN_CNAME_TARGET}`)}
                    className="mt-3 text-xs text-muted hover:text-content inline-flex items-center gap-1.5"
                  >
                    <Copy size={12} /> copiar registro DNS
                  </button>
                )}
              </div>
            );
          })}
          {domains.length === 0 && <p className="text-muted text-sm">Nenhum domínio próprio ainda.</p>}
        </div>
      </CardBody>
    </Card>
  );
}

/* ── theme editor ─────────────────────────────────────────────── */
function ThemeEditor({ org, orgId }: { org: Organization; orgId: string }) {
  const [draft, setDraft] = useState<OrgTheme>(org.theme);
  const [mode, setMode] = useState<"light" | "dark">(org.theme.defaultMode === "dark" ? "dark" : "light");
  const set = (patch: Partial<OrgTheme>) => setDraft((d) => ({ ...d, ...patch }));
  const report = themeContrastReport(draft, mode);
  const canPublish = !report.some((r) => r.gating && r.verdict === "fail");
  const dirty = JSON.stringify(draft) !== JSON.stringify(org.theme);

  useEffect(() => {
    loadGoogleFont(draft.fontDisplay);
    loadGoogleFont(draft.fontBody);
  }, [draft.fontDisplay, draft.fontBody]);

  const statusFor = (r: (typeof report)[number]) => {
    if (r.verdict === "pass") return { word: "ótimo", tone: "success" as const, Icon: Check };
    if (r.verdict === "aa-large") return { word: "ok", tone: "warning" as const, Icon: AlertTriangle };
    if (r.gating) return { word: "ilegível", tone: "danger" as const, Icon: X };
    return { word: "fraco (só detalhe)", tone: "neutral" as const, Icon: AlertTriangle };
  };

  return (
    <div className="grid lg:grid-cols-2 gap-5">
      <div className="space-y-5">
        <Card>
          <CardHeader eyebrow="White-label" title="Identidade da org" />
          <CardBody className="space-y-1">
            <div className="grid grid-cols-2 gap-x-4">
              <Field label="Cor primária"><ColorField value={draft.primary ?? "#6d28d9"} onChange={(v) => set({ primary: v })} /></Field>
              <Field label="Cor de realce"><ColorField value={draft.accent ?? "#b8965a"} onChange={(v) => set({ accent: v })} /></Field>
              <Field label="Fundo (claro)"><ColorField value={draft.bgLight ?? "#fffefb"} onChange={(v) => set({ bgLight: v })} /></Field>
              <Field label="Fundo (escuro)"><ColorField value={draft.bgDark ?? "#15140f"} onChange={(v) => set({ bgDark: v })} /></Field>
              <Field label="Fonte display" hint="Qualquer fonte do Google Fonts">
                <Combobox value={draft.fontDisplay ?? "Jost"} options={GOOGLE_FONTS} onChange={(v) => { set({ fontDisplay: v }); loadGoogleFont(v); }} searchPlaceholder="Buscar fonte…" previewFont />
              </Field>
              <Field label="Fonte corpo" hint="Qualquer fonte do Google Fonts">
                <Combobox value={draft.fontBody ?? "Hanken Grotesk"} options={GOOGLE_FONTS} onChange={(v) => { set({ fontBody: v }); loadGoogleFont(v); }} searchPlaceholder="Buscar fonte…" previewFont />
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
          <CardHeader eyebrow="Acessibilidade" title="Legibilidade" />
          <CardBody>
            <p className="text-sm text-muted mb-4">
              Checamos se os <strong className="text-content">textos ficam legíveis</strong> com as suas cores. Verde é ótimo.
              Você só publica se nada estiver <span className="text-danger">ilegível</span>.
            </p>
            <div className="space-y-3">
              {report.map((r) => {
                const s = statusFor(r);
                return (
                  <div key={r.pair} className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium">{r.label}</div>
                      <div className="text-xs text-muted">{r.desc}</div>
                    </div>
                    <span className="flex items-center gap-2 shrink-0">
                      <span className="font-mono text-[0.65rem] text-muted/70">{r.ratio}:1</span>
                      <Badge tone={s.tone}><s.Icon size={10} /> {s.word}</Badge>
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted pt-3 mt-3 border-t border-line">
              A cor do texto sobre botões/realce é escolhida automaticamente (claro ou escuro) para ficar legível.
            </p>
          </CardBody>
        </Card>

        <div className="flex gap-3">
          <Button disabled={!canPublish || !dirty} onClick={() => updateOrgTheme(orgId, draft)}>
            {canPublish ? "Publicar tema" : "Ajuste as cores para publicar"}
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
            style={{ ...(resolveThemeVars(draft, mode) as CSSProperties), background: "var(--color-bg)", color: "var(--color-text)" }}
          >
            <div className="eyebrow mb-2" style={{ color: "var(--color-accent)" }}>{org.name}</div>
            <h3 className="font-display text-2xl mb-1" style={{ fontFamily: `"${draft.fontDisplay ?? "Jost"}", sans-serif` }}>
              {org.tagline}
            </h3>
            <p className="text-sm mb-5" style={{ fontFamily: `"${draft.fontBody ?? "Hanken Grotesk"}", sans-serif`, color: "var(--color-text-muted)" }}>
              Esta é a cara da sua área de membro. Cores, fontes, fundo e arte da carteirinha mudam aqui.
            </p>
            <button className="rounded-full px-5 py-2.5 text-sm font-medium mb-6" style={{ background: "var(--color-primary)", color: "var(--color-primary-contrast)" }}>
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
          <p className="text-xs text-muted mt-3">Trocar a arte da carteirinha republica os passes dos membros.</p>
        </div>
      </div>
    </div>
  );
}

/* ── team ─────────────────────────────────────────────────────── */
const ROLES: Role[] = ["owner", "admin", "operator"];

function TeamPanel({ orgId }: { orgId: string }) {
  const db = useStore((d) => d);
  const users = listOrgUsers(db, orgId);
  const [inviting, setInviting] = useState(false);

  const remove = (id: string) => {
    if (!confirm("Remover este membro da equipe?")) return;
    const res = removeOrgUser(id);
    if (!res.ok) alert(res.reason);
  };

  return (
    <Card>
      <CardHeader
        eyebrow="RBAC · permissões"
        title={<span className="flex items-center gap-2"><Users size={17} /> Equipe & papéis</span>}
        action={<Button size="sm" onClick={() => setInviting(true)}><Plus size={14} /> Convidar</Button>}
      />
      <CardBody className="space-y-1">
        {users.map((u) => (
          <div key={u.id} className="flex items-center justify-between gap-3 py-3 border-b border-line/50 last:border-0">
            <div className="flex items-center gap-3 min-w-0">
              <span className="w-9 h-9 rounded-full bg-surface-2 border border-line flex items-center justify-center font-mono text-xs text-muted shrink-0">
                {u.name.split(" ").slice(0, 2).map((n) => n[0]).join("").toUpperCase()}
              </span>
              <div className="min-w-0">
                <div className="text-sm font-medium flex items-center gap-2">
                  {u.name}
                  {u.role === "owner" && <Crown size={12} className="text-gold-deep" />}
                  {u.status === "invited" && <Badge tone="warning">convite pendente</Badge>}
                </div>
                <div className="text-xs text-muted truncate">{u.email}</div>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {u.status === "invited" && (
                <Button size="sm" variant="ghost" onClick={() => { activateOrgUser(u.id); }}>
                  <Mail size={13} /> Marcar aceito
                </Button>
              )}
              <Select
                value={u.role}
                onChange={(e) => updateOrgUserRole(u.id, e.target.value as Role)}
                className="w-auto text-sm py-1.5"
              >
                {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </Select>
              <button onClick={() => remove(u.id)} className="p-2 rounded-lg text-muted hover:text-danger hover:bg-surface-2" aria-label="Remover">
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        ))}

        <div className="pt-3 space-y-1.5">
          {ROLES.map((r) => (
            <div key={r} className="flex items-start gap-2 text-xs">
              <Badge tone={r === "owner" ? "gold" : r === "admin" ? "primary" : "neutral"}>{ROLE_LABEL[r]}</Badge>
              <span className="text-muted">{ROLE_DESC[r]}</span>
            </div>
          ))}
        </div>
      </CardBody>

      {inviting && <InviteDialog orgId={orgId} onClose={() => setInviting(false)} />}
    </Card>
  );
}

function InviteDialog({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("admin");
  const valid = /.+@.+\..+/.test(email);

  return (
    <Dialog
      open
      onClose={onClose}
      eyebrow="Equipe"
      title="Convidar para a equipe"
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button disabled={!valid} onClick={() => { inviteOrgUser(orgId, name.trim(), email.trim(), role); onClose(); }}><Mail size={15} /> Enviar convite</Button></>}
    >
      <Field label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome da pessoa" /></Field>
      <Field label="E-mail" hint="Recebe o convite para acessar o admin"><Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="pessoa@email.com" /></Field>
      <Field label="Papel">
        <Select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {ROLES.filter((r) => r !== "owner").map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          <option value="owner">{ROLE_LABEL.owner}</option>
        </Select>
      </Field>
      <p className="text-xs text-muted -mt-1">{ROLE_DESC[role]}</p>
      <p className="text-xs text-muted mt-3">O convidado recebe um e-mail para acessar o admin.</p>
    </Dialog>
  );
}

/* ── billing / lgpd ───────────────────────────────────────────── */
function BillingPanel({ settings }: { settings: PlatformBillingSettings }) {
  const rows = [
    { label: "Comissão base", value: `${(settings.baseCommissionRate * 100).toFixed(2)}%`, note: "Pix · à vista · parcelado" },
    { label: "Juros de parcelamento (cliente)", value: `${(settings.installmentInterestRateAm * 100).toFixed(2)}% a.m.`, note: "pagos pelo cliente" },
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
          <Button variant="ghost" size="sm" onClick={() => alert("Exportação de dados iniciada.")}>Exportar dados (DSR)</Button>
          <Button variant="ghost" size="sm" onClick={() => alert("Anonimização preserva os registros financeiros legais.")}>Anonimizar membro</Button>
        </div>
      </CardBody>
    </Card>
  );
}
