import { useState, useEffect, useCallback } from "react";
import { Plug, Check, Link2, Gift, ShieldCheck, ExternalLink, KeyRound, Lock, ArrowRight } from "lucide-react";
import { useStore } from "@/lib/store";
import {
  listConnectors, listConnections, getConnection, connectIntegration, disconnectIntegration,
  setTierMapping, listTiers, listPerks,
} from "@/lib/api";
import { CONNECTOR_CATEGORIES, oauthCallback, maskSecret, type Connector, type CredentialField } from "@/lib/connectors";
import { hasBackend } from "@/lib/supabase";
import {
  connectIntegration as connectIntegrationRemote, startOAuth,
  listConnections as listConnectionsRemote,
  disconnectIntegration as disconnectIntegrationRemote,
  setTierMapping as setTierMappingRemote,
} from "@/lib/integrations";
import { SectionHead, Card, CardBody, Button, Badge, Dialog, Field, Input, Textarea, Label } from "@/components/ui";
import { useAdminOrg } from "../useAdminOrg";
import type { Connection } from "@/types/domain";

const KIND_LABEL: Record<string, string> = { oauth: "OAuth 2.0", api_key: "API key", bot: "Bot", manual: "Manual", supabase: "Login · Supabase" };

export default function Integrations() {
  const { orgId } = useAdminOrg();
  const db = useStore((d) => d);
  const [active, setActive] = useState<Connector | null>(null);
  const backend = hasBackend();

  // With a real backend, connections live in Postgres (via the v1-connections
  // Edge Function), not the local store. Load them and re-fetch after changes.
  const [remoteConns, setRemoteConns] = useState<Connection[] | null>(null);
  const reload = useCallback(async () => {
    if (!backend || !orgId) return;
    try { setRemoteConns(await listConnectionsRemote(orgId)); }
    catch { setRemoteConns([]); }
  }, [backend, orgId]);
  useEffect(() => { void reload(); }, [reload]);

  if (!orgId) return null;
  const connectors = listConnectors();
  const connections = backend ? (remoteConns ?? []) : listConnections(db, orgId);
  const findConn = (provider: string): Connection | undefined =>
    backend ? connections.find((c) => c.provider === provider) : getConnection(db, orgId, provider);
  const connectedCount = connections.filter((c) => c.status === "connected").length;

  return (
    <div>
      <SectionHead
        eyebrow="Plugins · self-service"
        title="Integrações"
        desc="Conecte uma vez e os perks são entregues sozinhos. Integrações pedem as credenciais reais da API; o login é gerenciado pela Stanbase via Supabase."
        action={<Badge tone="success">{connectedCount} conectadas</Badge>}
      />

      {CONNECTOR_CATEGORIES.map((cat) => {
        const items = connectors.filter((c) => c.category === cat.key);
        if (items.length === 0) return null;
        return (
          <div key={cat.key} className="mb-7">
            <div className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-muted mb-3">{cat.label}</div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {items.map((c) => (
                <ConnectorCard
                  key={c.provider}
                  connector={c}
                  connection={findConn(c.provider)}
                  onOpen={() => setActive(c)}
                  onDisconnect={async () => {
                    if (!confirm(`Desconectar ${c.label}? Os perks ligados deixam de ser provisionados.`)) return;
                    if (backend) { try { await disconnectIntegrationRemote(orgId, c.provider); } catch { /* ignore */ } await reload(); }
                    else disconnectIntegration(orgId, c.provider);
                  }}
                />
              ))}
            </div>
          </div>
        );
      })}

      <p className="text-xs text-muted font-mono">
        não vê sua ferramenta? a gente conecta pra você.
      </p>

      {active && (
        <ConnectDialog
          connector={active}
          orgId={orgId}
          tiers={listTiers(db, orgId)}
          connection={findConn(active.provider)}
          perks={listPerks(db, orgId)}
          onChanged={reload}
          onClose={() => setActive(null)}
        />
      )}
    </div>
  );
}

function ConnectorCard({
  connector, connection, onOpen, onDisconnect,
}: {
  connector: Connector;
  connection?: Connection;
  onOpen: () => void;
  onDisconnect: () => void;
}) {
  const connected = connection?.status === "connected";
  return (
    <Card className="border-t-2" style={{ borderTopColor: connected ? "var(--color-success)" : "var(--color-border)" }}>
      <CardBody>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className="w-10 h-10 rounded-xl bg-surface-2 border border-line flex items-center justify-center">
              <Plug size={17} className={connected ? "text-success" : "text-muted"} />
            </span>
            <div>
              <div className="font-medium">{connector.label}</div>
              <div className="font-mono text-[0.55rem] uppercase tracking-wide text-muted">{KIND_LABEL[connector.auth.kind]}</div>
            </div>
          </div>
          {connected ? <Badge tone="success"><Check size={10} /> conectado</Badge> : <Badge tone="neutral">desconectado</Badge>}
        </div>
        <p className="text-sm text-muted mt-2 min-h-[40px]">{connector.blurb}</p>
        {connected && connection?.accountLabel && (
          <div className="text-xs text-muted mb-3 flex items-center gap-1.5"><Link2 size={12} /> {connection.accountLabel}</div>
        )}
        {connected ? (
          <div className="flex gap-2">
            <Button size="sm" variant="subtle" onClick={onOpen}>Gerenciar</Button>
            <Button size="sm" variant="ghost" onClick={onDisconnect}>Desconectar</Button>
          </div>
        ) : (
          <Button size="sm" onClick={onOpen}>Conectar</Button>
        )}
      </CardBody>
    </Card>
  );
}

function CredentialInput({ field, value, onChange }: { field: CredentialField; value: string; onChange: (v: string) => void }) {
  return (
    <Field label={field.label + (field.required ? " *" : "")} hint={field.help}>
      {field.type === "textarea" ? (
        <Textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} className="font-mono text-xs min-h-[110px]" />
      ) : (
        <Input
          type={field.type === "secret" ? "password" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder ?? (field.type === "url" ? "https://…" : "")}
          className="font-mono text-sm"
          autoComplete="off"
        />
      )}
    </Field>
  );
}

function ConnectDialog({
  connector, orgId, tiers, connection, perks, onChanged, onClose,
}: {
  connector: Connector;
  orgId: string;
  tiers: ReturnType<typeof listTiers>;
  connection?: Connection;
  perks: ReturnType<typeof listPerks>;
  onChanged?: () => void;
  onClose: () => void;
}) {
  const connected = connection?.status === "connected";
  const [reconfig, setReconfig] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { kind, fields, scopes, docsUrl, note } = connector.auth;
  const enabledPerks = perks.filter((p) => connector.perkTypes.includes(p.type));

  const requiredOk = fields.filter((f) => f.required).every((f) => (values[f.key] ?? "").trim().length > 0);
  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));

  /** Account label shown in the UI (derived from the first text/url field). */
  const deriveLabel = () => {
    const labelField = fields.find((f) => f.type === "text" && values[f.key]) ?? fields.find((f) => f.type === "url" && values[f.key]);
    return kind === "supabase"
      ? "Login ativo"
      : (labelField && values[labelField.key]) || `${connector.label} conectado`;
  };

  const submit = async () => {
    if (submitting) return;
    setError(null);

    // REAL backend: hit the Edge `v1-connections` function (or redirect to OAuth).
    if (hasBackend()) {
      // OAuth providers don't post credentials — redirect to the provider consent.
      if (kind === "oauth") {
        window.location.href = startOAuth(connector.provider, orgId);
        return;
      }
      // api_key / bot / manual → verify + store credentials server-side.
      if (kind === "api_key" || kind === "bot" || kind === "manual") {
        // send RAW credentials — the server encrypts them; never mask here.
        const creds: Record<string, string> = {};
        for (const f of fields) {
          const v = (values[f.key] ?? "").trim();
          if (v) creds[f.key] = v;
        }
        setSubmitting(true);
        try {
          await connectIntegrationRemote(orgId, connector.provider, creds, deriveLabel());
          onChanged?.();
          onClose();
        } catch (e) {
          // surface the provider's real verification error in the dialog.
          setError(e instanceof Error ? e.message : "Falha ao conectar.");
        } finally {
          setSubmitting(false);
        }
        return;
      }
      // `supabase` (platform-managed login) keeps the local toggle behaviour.
    }

    // PROTOTYPE / offline demo: mask secrets before storing (never keep plaintext).
    const creds: Record<string, string> = {};
    for (const f of fields) {
      const v = (values[f.key] ?? "").trim();
      if (!v) continue;
      creds[f.key] = f.type === "secret" ? maskSecret(v) : v;
    }
    connectIntegration(orgId, connector.provider, deriveLabel(), creds);
    onClose();
  };

  const showForm = !connected || reconfig;

  return (
    <Dialog
      open
      onClose={onClose}
      eyebrow={connected ? `Integração · ${KIND_LABEL[kind]}` : `Conectar · ${KIND_LABEL[kind]}`}
      title={connector.label}
      size="md"
      footer={
        showForm ? (
          <>
            <Button variant="ghost" onClick={connected ? () => setReconfig(false) : onClose}>Cancelar</Button>
            <Button onClick={submit} disabled={!requiredOk || submitting}>
              {submitting ? "Conectando…"
                : kind === "oauth" ? <><ShieldCheck size={15} /> Autorizar com {connector.label}</>
                : kind === "supabase" ? <><ShieldCheck size={15} /> Ativar login</>
                : <><KeyRound size={15} /> Conectar</>}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>Concluir</Button>
        )
      }
    >
      {note && (
        <div className="flex items-start gap-2 text-sm text-muted mb-4">
          <Lock size={14} className="mt-0.5 shrink-0 text-gold-deep" />
          <span>
            {note}{" "}
            {docsUrl && <a href={docsUrl} target="_blank" rel="noreferrer" className="text-content underline inline-flex items-center gap-0.5">documentação <ExternalLink size={11} /></a>}
          </span>
        </div>
      )}

      {showForm ? (
        <>
          {error && (
            <div className="rounded-xl border border-danger/30 bg-danger/10 text-danger text-sm px-3 py-2.5 mb-4">
              {error}
            </div>
          )}
          {kind === "oauth" && (
            <div className="rounded-xl border border-line bg-surface-2/40 p-3 mb-4 text-sm">
              {scopes && scopes.length > 0 && (
                <div className="mb-2">
                  <span className="text-muted">Permissões solicitadas:</span>
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {scopes.map((s) => <span key={s} className="font-mono text-[0.65rem] bg-surface border border-line rounded px-1.5 py-0.5">{s}</span>)}
                  </div>
                </div>
              )}
              <div>
                <span className="text-muted">URL de callback (whitelist no app):</span>
                <code className="block mt-1 text-[0.7rem] bg-surface border border-line rounded px-2 py-1.5 break-all">{oauthCallback(connector.provider)}</code>
              </div>
            </div>
          )}

          {fields.length === 0 && kind === "oauth" && (
            <p className="text-sm text-muted">Clique em autorizar para entrar com {connector.label}.</p>
          )}
          {kind === "supabase" && (
            <p className="text-sm text-muted">Ative para oferecer este método aos seus membros na tela de login. A configuração fica na plataforma (Supabase Auth) — você não informa nenhuma credencial.</p>
          )}
          {fields.map((f) => (
            <CredentialInput key={f.key} field={f} value={values[f.key] ?? ""} onChange={(v) => set(f.key, v)} />
          ))}
          {fields.length > 0 && (
            <p className="text-[0.7rem] text-muted flex items-center gap-1.5 mt-1">
              <Lock size={11} /> Segredos são cifrados e nunca expostos ao navegador.
            </p>
          )}
        </>
      ) : (
        <>
          {/* connected: login method (Supabase) — no creds/mapping */}
          {kind === "supabase" && (
            <div className="flex items-center gap-2 text-sm rounded-xl border border-success/30 bg-success/10 text-success px-3 py-2.5">
              <ShieldCheck size={15} /> Seus membros podem entrar com {connector.label}.
            </div>
          )}
          {/* connected: credentials summary */}
          {fields.length > 0 && (
            <div className="rounded-xl border border-line p-3 mb-4">
              <div className="font-mono text-[0.6rem] uppercase tracking-wide text-muted mb-2">Credenciais</div>
              {connection?.credentials && Object.keys(connection.credentials).length > 0 ? (
                <div className="space-y-1">
                  {fields.filter((f) => connection.credentials?.[f.key]).map((f) => (
                    <div key={f.key} className="flex items-center justify-between text-sm">
                      <span className="text-muted">{f.label}</span>
                      <span className="font-mono text-xs">{connection.credentials?.[f.key]}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted">Nenhuma credencial salva ainda — configure para o provisionamento funcionar.</p>
              )}
              <button onClick={() => setReconfig(true)} className="text-sm text-content underline mt-3 inline-flex items-center gap-1">
                {connection?.credentials && Object.keys(connection.credentials).length > 0 ? "Atualizar credenciais" : "Configurar credenciais"} <ArrowRight size={13} />
              </button>
            </div>
          )}

          {/* mapping */}
          {connector.resourceLabel && (
            <>
              <Label>Mapear tier → {connector.resourceLabel}</Label>
              <div className="space-y-2 mt-1 mb-5">
                {tiers.map((t) => (
                  <div key={t.id} className="flex items-center gap-3">
                    <span className="flex items-center gap-2 w-32 shrink-0 text-sm">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: t.color }} /> {t.name}
                    </span>
                    <Input
                      defaultValue={connection?.mappings.find((m) => m.tierId === t.id)?.resource ?? ""}
                      onBlur={async (e) => {
                        if (hasBackend()) {
                          try { await setTierMappingRemote(orgId, connector.provider, t.id, e.target.value); onChanged?.(); } catch { /* ignore */ }
                        } else {
                          setTierMapping(orgId, connector.provider, t.id, e.target.value);
                        }
                      }}
                      placeholder={`${connector.resourceLabel}…`}
                      className="font-mono text-sm"
                    />
                  </div>
                ))}
              </div>
            </>
          )}

          {enabledPerks.length > 0 && (
            <div>
              <div className="font-mono text-[0.6rem] uppercase tracking-wide text-muted mb-2">Perks provisionados por esta conexão</div>
              <div className="flex flex-wrap gap-1.5">
                {enabledPerks.map((p) => (
                  <span key={p.id} className="text-[0.72rem] bg-success/10 text-success border border-success/30 rounded-full px-2.5 py-1 inline-flex items-center gap-1">
                    <Gift size={11} /> {p.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
