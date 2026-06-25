## 26. Super-admin Stanbase (interno)

> O **painel interno multi-tenant** que o time da Stanbase (persona *Stanbase Staff*, STANBASE §2) usa para operar a plataforma inteira — **todos os tenants ao mesmo tempo**. É o `apps/stanbase-admin` da estrutura de repositório (§28.1). Concentra: gestão de Contas/Orgs, **billing da plataforma** (comissões capturadas, spread de financiamento, repasses, conciliação Asaas no nível agregado), **suporte com impersonate auditado**, **feature flags por org**, **métricas agregadas cross-tenant**, **moderação** e **suspensão de org inadimplente / com KYC pendente**, além de reembolso/intervenção pela plataforma.
>
> Fonte de verdade: `STANBASE.md` §2 (personas), §13 (billing/comissão/spread), §26 (segurança/LGPD/RLS), §27 (observabilidade), §28 (repositório/ambientes), §30 (decisões). Decisões imutáveis assumidas: PSP = Asaas; comissão base **7,99%**; juros parcelado **3,49% a.m.** (regra `max`); 1 membership por org; **uma Conta possui N orgs**; isolamento por `org_id` via RLS.
>
> **Princípio de fronteira:** este domínio é o **único** lugar onde a fronteira de isolamento por `org_id` é deliberadamente atravessada. Por isso ele é o mais sensível em segurança e auditoria de toda a plataforma. Tudo aqui é **logado, atribuível a um humano nominal, e reversível quando possível**. O super-admin **não** é "um owner com mais poder" — é uma identidade separada, com app separado, auth separado e trilha de auditoria separada.

---

### 26.1 Como funciona

#### 26.1.1 Conceitos e fronteiras

- **Stanbase Staff** — funcionário interno da Stanbase. **Não** é `org_users` de ninguém. Vive em uma tabela própria (`platform_staff`) ligada a um `auth.users` (mesma base de auth do resto, e-mail `@stanbase.com` / `@scaleup.com.br`). Ter conta de staff **não** dá acesso a nenhuma org por padrão — o acesso a dados de uma org é **sempre** mediado por uma ação explícita e auditada (consulta read-only de suporte ou sessão de impersonation).
- **Papéis de staff** (`platform_staff.role`): `support` (suporte L1/L2), `finance` (billing/conciliação/repasses), `trust_safety` (moderação/suspensão), `engineering` (feature flags, observabilidade técnica), `superadmin` (god-mode interno; gestão de staff). Cada papel tem **scopes** (capabilities) — RBAC interno espelhando o RBAC de org (§auth-rbac §1.7), mas com módulos do *painel interno*.
- **App separado** (`apps/stanbase-admin`) servido em domínio próprio e isolado: `internal.stanbase.com` (sugerido) — **nunca** sob `app.stanbase.com` (admin de org) nem `*.stanbase.com` de membro. SSO corporativo + MFA **obrigatório** (decisão §26.8).
- **Sem dados de cartão / PII desnecessária:** o painel interno respeita os mesmos limites de LGPD; vê o necessário para operar, com PII sensível sob *reveal* auditado (§26.1.9).

> **Distinção crítica vs. Owner:** o Org Owner enxerga **uma** org de cada vez (seletor de contexto, §auth-rbac §1.5). O super-admin enxerga **N orgs** em listagens e dashboards agregados, mas **nunca** vê PII de membros de várias orgs misturada numa mesma tela sem necessidade — métricas cross-tenant são **agregadas/anonimizadas** por padrão (§26.1.7).

#### 26.1.2 Como o super-admin acessa dados de org — os três modos (e o que cada um pode)

| Modo | O que é | PII de membro | Escrita em dados de org | Auditoria |
|---|---|---|---|---|
| **Agregado** | Métricas cross-tenant, contagens, somas. Default de quase todas as telas. | **Não** (só agregados k-anonimizados) | Não | Acesso logado (consulta) |
| **Read-only de suporte** | Abre **uma** org específica em modo leitura (ver assinatura, transação, status de membership de **1** membro citado num ticket). | Sim, **campo a campo sob reveal** | Não | Cada reveal/consulta logado com motivo |
| **Impersonation** | Entra **como se fosse** um operador da org (assume contexto de um `org_users` específico) para reproduzir/corrigir um problema. | Conforme o operador impersonado | Sim (com restrições — §26.1.5) | Sessão inteira gravada (banner, timer, action log) |

**Regra de ouro:** escalada de modo é **explícita e justificada**. Abrir read-only exige selecionar um motivo/ticket; iniciar impersonation exige motivo + (opcionalmente) consentimento do owner (decisão §26.8).

#### 26.1.3 Máquina de estados — Conta (billing da plataforma)

A **Conta** (não a org) é a unidade de billing **da plataforma** no sentido de relacionamento comercial, mas o **fluxo de dinheiro** (comissão capturada) acontece por **transação/org** via split Asaas (§payments-billing). Aqui modelamos o **estado de saúde** da conta/org sob a ótica da Stanbase:

```
ACCOUNT:   active → flagged (sob investigação) → active
                  → delinquent_platform (pendência com a Stanbase) → active
                  → closed (encerramento)
```

```
ORG (visão plataforma, complementa organizations.status de §auth-rbac §1.3):
   active
     ├→ kyc_blocked        (subconta Asaas ≠ active → não pode receber checkout)
     ├→ suspended          (Stanbase suspende: inadimplência/abuso/moderação)
     ├→ restricted         (suspensão parcial: bloqueia checkout/payout, mantém leitura)
     ├→ under_moderation    (conteúdo/atividade sob revisão de trust&safety)
     └→ archived           (soft delete pelo owner — fora do escopo deste domínio mexer)
```

Regras concretas:
- `suspended` (org) → propaga para `organizations.status='suspended'` (§auth-rbac §1.3) → **todos os vínculos de operador param de emitir claims**; front de membro mostra "comunidade temporariamente indisponível"; checkout e payout bloqueados; passport mostra status conforme política (não necessariamente "inativo" — ver §26.8).
- `restricted` → bloqueia **novas cobranças e saques** mas **mantém acesso** dos membros já pagantes (evita punir o fã pela falha do dono). Usado como passo intermediário antes da suspensão dura.
- `kyc_blocked` é **derivado** do estado da subconta Asaas (`asaas_subaccounts.status ≠ active`, §payments-billing §10.1.3) — não é um estado que o super-admin define manualmente; ele só **acompanha e destrava** (reabrir KYC, contatar Asaas).
- Toda transição de estado de org/conta feita pela plataforma exige **motivo obrigatório** + gera `platform_audit_logs` + (opcional) notificação ao owner.

#### 26.1.4 Máquina de estados — Sessão de impersonation

```
                 request (motivo + org_id + target_org_user_id)
                          │
                          ▼  [aprovação se requerida — §26.8]
                 ┌──────────────┐  start
   approved ───► │  PENDING     │ ───────► ┌──────────────┐
                 └──────────────┘          │  ACTIVE       │  (TTL curto, ex.: 30 min)
                                           └──────┬───────┘
                          end (manual)  ┌─────────┼──────────┐  TTL expira
                                        ▼         │          ▼
                                 ┌──────────┐     │   ┌──────────────┐
                                 │  ENDED    │◄────┘   │  EXPIRED      │
                                 └──────────┘          └──────────────┘
                                        ▲
                          revoked (kill-switch do superadmin/owner)
```

- **Token de impersonation é distinto** do JWT normal: carrega claims `impersonation: { staff_id, target_org_id, target_org_user_id, session_id, reason, exp }`. O RLS e as Edge Functions **sabem** que é uma sessão impersonada (não é indistinguível de um login real do operador) — isso é requisito de auditoria (§26.1.5).
- **TTL curto** (default 30 min, configurável por papel; renovável com re-justificativa). Ao expirar → `EXPIRED`, sessão encerrada, banner some.
- **Kill-switch:** o owner da org **pode** ver e encerrar sessões de impersonation ativas na sua org ("alguém da Stanbase está te ajudando agora"), e o superadmin pode matar qualquer sessão. (Decisão de visibilidade ao owner em §26.8.)
- Toda a sessão é **gravada**: ações de escrita ficam taggeadas com `session_id` em `platform_audit_logs` e também no `audit_logs` da própria org (com `actor_impersonated_by`).

#### 26.1.5 Fluxo passo a passo — Impersonation segura e auditada (edge case central)

1. Staff de suporte abre o ticket / a org no painel interno → clica **"Acessar como operador"**.
2. Seleciona **qual** `org_users` impersonar (default: o owner; pode ser um admin específico). **Justificativa obrigatória** (texto livre + link de ticket).
3. **Gate de aprovação** (configurável por papel/risco — §26.8): suporte L1 pode precisar de aprovação de um superadmin; finance/trust_safety podem ter trilha própria. Recomendação MVP: impersonation **sem aprovação prévia** mas **100% auditada + notificação ao owner** (menos fricção, rastreável).
4. Edge Function `impersonation-start`:
   - Valida staff ativo + scope `support.impersonate`.
   - Valida que `target_org_user_id` pertence à `org_id` e está ativo.
   - Cria `impersonation_sessions` (status `active`, `expires_at`, `reason`, `ticket_ref`).
   - Emite **token de impersonation** (não reusa o token de staff; claims dedicados, TTL curto).
   - Grava `platform_audit_logs` (`action='impersonation.started'`).
   - Dispara notificação ao owner ("Suporte Stanbase iniciou acesso assistido — ver detalhes/encerrar").
5. Front entra na **org real** (admin da org) com **banner persistente vermelho** no topo: *"Você está agindo como {operador} de {org} — sessão de suporte Stanbase — encerra em mm:ss"* + botão **Encerrar**.
6. **Restrições durante a sessão** (defesa em profundidade):
   - **Ações destrutivas/financeiras bloqueadas por padrão** durante impersonation (excluir base, anonimizar membro em massa, sacar payout, transferir posse, deletar org). Exigem escalada/desativação explícita do bloqueio com motivo (decisão §26.8). Razão: impedir que suporte/atacante "limpe" uma org sob o disfarce do owner.
   - **Nunca** revela segredos cifrados (credenciais de integração, API keys completas) — esses ficam mascarados mesmo para o super-admin (§26.8 / §security-lgpd).
   - Toda escrita gera **duplo log**: `audit_logs` da org (`actor=target_org_user`, `impersonated_by=staff_id`, `session_id`) **e** `platform_audit_logs`.
7. Encerramento: manual (botão), TTL, ou kill-switch → `impersonation-end` revoga o token, fecha a sessão, registra `impersonation.ended` + duração + nº de ações.
8. **Pós-sessão:** um resumo da sessão (timeline de ações) fica anexado ao ticket e visível ao owner.

> **Anti-padrões explicitamente proibidos:** (a) impersonar sem motivo; (b) sessão sem TTL; (c) usar o token de staff para escrever direto em tabelas de org sem passar por impersonation (toda escrita em dados de org **tem** que ter um `org_users` responsável associado, mesmo que via impersonation); (d) impersonation indistinguível de login real nos logs.

#### 26.1.6 Fluxo passo a passo — Suspensão de org inadimplente / em moderação

1. **Gatilho** pode ser: (a) **automático** — `delinquent_platform` por X dias (job), KYC reprovado há muito tempo, taxa de chargeback acima de limiar; (b) **manual** — trust&safety abre caso de moderação; finance identifica fraude/risco.
2. Super-admin (com scope `org.suspend` / `org.moderate`) abre a org → escolhe **nível**: `restricted` (parcial) ou `suspended` (total) ou `under_moderation`.
3. **Motivo obrigatório** + **template de comunicação** ao owner (e-mail) + janela de carência opcional ("você tem 7 dias antes da suspensão dura").
4. Edge Function `org-suspend`:
   - Atualiza `organizations.status` + `org_platform_state`.
   - **Efeitos colaterais** (orquestrados, idempotentes):
     - `restricted`: bloqueia `checkout-create` e `payout-withdraw` (gate no domínio payments); membros pagantes **mantêm** acesso.
     - `suspended`: além do acima, derruba claims de operadores (§auth-rbac §1.11.5), bloqueia login no admin da org, mostra banner/landing de indisponibilidade no front de membro. **Não** estorna automaticamente nem revoga membership já paga (decisão §26.8 — o membro pagou de boa-fé).
   - Dispara webhook interno + notificação + `platform_audit_logs`.
5. **Reversão (`reinstate`):** super-admin reativa → estado volta a `active`, claims voltam a emitir no próximo refresh, gates liberam. Tudo logado.

> **Edge case — quem paga o quê na suspensão:** se a org é suspensa por inadimplência **com a plataforma** (raro, já que a comissão é capturada no split antes do repasse), o saldo retido na subconta Asaas pode ser usado para quitar pendências. Caso de fraude → **congelar payouts** (`payouts.status='on_hold'`, `hold_reason='fraud'`, §payments-billing §10.2.3) e reter saldo até resolução. Membros lesados → fluxo de reembolso pela plataforma (§26.1.8).

#### 26.1.7 Métricas agregadas cross-tenant (edge case central: isolamento)

O super-admin precisa de **visão de plataforma** (GMV, comissão capturada, spread de financiamento, MRR agregado, nº de orgs ativas, churn médio, top orgs por receita) **sem** violar isolamento nem expor PII de membros de múltiplas orgs.

Regras de implementação:
- **Camada de agregação dedicada** (views materializadas / tabelas `platform_metrics_*`) populadas por **jobs** que rodam com role de serviço — **não** se consulta tabela de domínio crua cruzando orgs no request do painel. Isso evita N+1 cross-tenant e centraliza o controle de o-que-pode-ser-agregado.
- **k-anonimato / supressão:** rankings e distribuições que poderiam identificar um membro específico (ex.: "membro de maior LTV da plataforma") são **proibidos por padrão**; agregados são por org ou por faixa. "Top orgs por GMV" é permitido (org não é PII); "top membros" cross-tenant **não**.
- **Segregação de leitura financeira:** métricas de **receita da Stanbase** (comissão base + spread − psp_fee, §payments-billing §10.1.2) vivem em agregados de plataforma; **não** se deriva isso varrendo `transactions` de todas as orgs ao vivo no front.
- **Acesso a métrica também é logado** (quem viu o dashboard financeiro da plataforma, quando) — auditoria de leitura, não só de escrita, para dados sensíveis.

#### 26.1.8 Reembolso pela plataforma (edge case central)

Casos em que **a Stanbase**, não a org, precisa estornar: fraude, org suspensa/abandonada que não atende o membro, decisão de chargeback, erro de cobrança da própria plataforma, ordem judicial.

1. Finance/superadmin abre a transação (via busca por `member_id`, `asaas_payment_id`, e-mail, etc.).
2. Escolhe **reembolso total/parcial** + **quem absorve**: `org` (debita saldo/payout da org) | `stanbase` (a plataforma come o prejuízo — fraude/erro nosso) | `split` (rateia). Esse campo (`liability`) é **decisão crítica** e exige scope `billing.platform_refund`.
3. Edge Function reusa `fn:refund-process` (§payments-billing §10.3.2) mas com **flag de origem `platform`** e o `liability` escolhido:
   - Reverte (ou não) a **comissão base** conforme `liability`.
   - Ajusta `net_org` / saldo da org.
   - Aplica política de acesso (manter até fim do período | revogar já).
   - Grava `refunds` (com `initiated_by='platform'`, `staff_id`, `reason`) + `platform_audit_logs`.
4. Edge case **org sem saldo** para cobrir o estorno: a Stanbase adianta (vira **crédito a receber da org**, `org_platform_balance` negativo) e persegue a cobrança/compensa em payouts futuros. Política configurável.
5. Notifica org + membro; reflete na timeline do CRM do membro (`interactions`) e nos relatórios financeiros da org (transparência).

> **Princípio:** o fã nunca deve ficar "no prejuízo e sem suporte" porque a org sumiu — a plataforma tem que ter o botão de estornar pela org, mesmo que isso gere um acerto de contas com o dono depois.

#### 26.1.9 Reveal de PII e moderação

- **Reveal auditado:** campos sensíveis (e-mail, telefone, documento, dados bancários do KYC) aparecem **mascarados** por padrão no painel interno. Clicar "revelar" exige motivo e gera log (`pii.revealed`, com campo + member/org alvo). Dados bancários do payout e credenciais de integração são **sempre mascarados** mesmo no reveal (só os últimos dígitos) — nunca exibimos o segredo cru (§security-lgpd, §STANBASE §26).
- **Moderação:** trust&safety pode (a) sinalizar/derrubar **conteúdo gated** abusivo de uma org (`under_moderation` + takedown de `content_items`), (b) bloquear uma org que viole termos, (c) tratar denúncias. Toda ação de moderação é logada e (quando aplicável) comunicada ao owner com base/termo violado.

#### 26.1.10 Feature flags por org

- Flags controlam rollout de funcionalidades **por org** (e por Conta, e global), permitindo liberar features novas a orgs piloto, fazer kill-switch de uma feature problemática, e dar overrides a clientes enterprise.
- **Resolução em camadas** (precedência): `override por org` > `override por conta` > `regra de segmento` (ex.: % rollout, vertical) > `default global`. Resultado é um booleano/variante por `(flag_key, org_id)`.
- Flags são lidas tanto no **admin de org** quanto no **front de membro** quanto nas **Edge Functions** — exposição via `GET /v1/feature-flags` (escopo da org derivado da credencial) + cache curto. O super-admin **escreve**; os demais só **leem as suas**.
- Mudança de flag por org = `platform_audit_logs`. Flags com impacto financeiro/segurança exigem scope elevado.

---

### 26.2 Modelo de dados

Tabelas **novas** deste domínio vivem **fora** do escopo de RLS por `org_id` (são da plataforma). Acesso controlado por RLS contra `platform_staff` + role de serviço. Reusa/toca tabelas de §auth-rbac, §payments-billing e §25 do STANBASE.

#### 26.2.1 Staff interno e RBAC de plataforma

```sql
platform_staff (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) unique,
  email         text not null,                 -- deve bater com domínio corporativo permitido
  name          text not null,
  role          text not null,                 -- support|finance|trust_safety|engineering|superadmin
  scopes        jsonb not null default '{}',   -- capabilities granulares (ver §26.1.1)
  status        text not null default 'active',-- active|suspended|offboarded
  mfa_enrolled  boolean not null default false,
  last_active_at timestamptz,
  created_at    timestamptz default now(),
  created_by    uuid references platform_staff(id),
  offboarded_at timestamptz
)
-- índice: (status), (role)

-- Convites de staff (onboarding interno)
platform_staff_invites (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  role        text not null,
  scopes      jsonb,
  token       text not null,
  status      text not null default 'pending', -- pending|accepted|revoked|expired
  invited_by  uuid references platform_staff(id),
  expires_at  timestamptz not null,
  created_at  timestamptz default now()
)
```

#### 26.2.2 Estado de plataforma de Conta/Org

```sql
-- complementa accounts/organizations (§25.1, §auth-rbac) — visão da plataforma
org_platform_state (
  org_id            uuid primary key references organizations(id),
  platform_status   text not null default 'active', -- active|restricted|suspended|under_moderation|kyc_blocked
  suspension_reason text,
  suspended_by      uuid references platform_staff(id),
  suspended_at      timestamptz,
  grace_until       timestamptz,                 -- janela de carência antes da suspensão dura
  risk_score        numeric(5,2),                -- score interno (chargeback, fraude, abuso)
  chargeback_rate   numeric(6,4),                -- %, alimentado por job
  notes             text,
  updated_at        timestamptz default now()
)

account_platform_state (
  account_id        uuid primary key references accounts(id),
  status            text not null default 'active', -- active|flagged|delinquent_platform|closed
  flag_reason       text,
  platform_balance  numeric(14,2) not null default 0, -- negativo = org/conta deve à Stanbase (ver §26.1.8)
  updated_at        timestamptz default now()
)
```

#### 26.2.3 Impersonation

```sql
impersonation_sessions (
  id                  uuid primary key default gen_random_uuid(),
  staff_id            uuid not null references platform_staff(id),
  org_id              uuid not null references organizations(id),
  target_org_user_id  uuid not null references org_users(id),
  reason              text not null,
  ticket_ref          text,
  status              text not null default 'active', -- pending|active|ended|expired|revoked
  destructive_unlocked boolean not null default false, -- se ações destrutivas foram liberadas (com motivo)
  started_at          timestamptz default now(),
  expires_at          timestamptz not null,
  ended_at            timestamptz,
  ended_reason        text,                      -- manual|ttl|kill_switch_owner|kill_switch_admin
  actions_count       int default 0,
  ip                  inet,
  user_agent          text
)
-- índices: (org_id, status), (staff_id, started_at), parcial WHERE status='active'

-- toda ação dentro da sessão (espelho leve; a fonte fina é audit_logs/platform_audit_logs)
impersonation_actions (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references impersonation_sessions(id),
  method      text, route text, target text,
  at          timestamptz default now()
)
```

#### 26.2.4 Auditoria de plataforma (separada do audit_logs de org)

```sql
-- audit_logs (§25.6) é POR ORG. Este é o audit da PLATAFORMA (ações de staff cross-tenant).
platform_audit_logs (
  id          uuid primary key default gen_random_uuid(),
  staff_id    uuid references platform_staff(id),
  action      text not null,    -- impersonation.started|org.suspended|pii.revealed|flag.changed|refund.platform|metrics.viewed_financial...
  org_id      uuid,             -- alvo (nullable para ações globais)
  account_id  uuid,
  target      text,             -- member_id / transaction_id / flag_key etc.
  reason      text,
  payload     jsonb,            -- diff/contexto (com PII redigida)
  session_id  uuid,             -- se dentro de impersonation
  ip          inet,
  user_agent  text,
  at          timestamptz default now()
)
-- índices: (org_id, at), (staff_id, at), (action, at)
-- RETENÇÃO LONGA (compliance) + append-only (sem UPDATE/DELETE via policy)
```

#### 26.2.5 Feature flags

```sql
feature_flags (
  key         text primary key,         -- ex.: 'pix_automatico', 'ai_copilot', 'hall_of_fame'
  description text,
  default_value jsonb not null default 'false'::jsonb, -- bool ou variante
  type        text not null default 'boolean', -- boolean|variant|number
  rollout_rules jsonb,                   -- % rollout, por vertical etc.
  created_at  timestamptz default now()
)

feature_flag_overrides (
  id          uuid primary key default gen_random_uuid(),
  flag_key    text not null references feature_flags(key),
  scope       text not null,            -- org|account|global
  org_id      uuid references organizations(id),
  account_id  uuid references accounts(id),
  value       jsonb not null,
  reason      text,
  set_by      uuid references platform_staff(id),
  expires_at  timestamptz,              -- override temporário (kill-switch com TTL)
  created_at  timestamptz default now(),
  unique nulls not distinct (flag_key, scope, org_id, account_id)
)
-- índice: (org_id), (flag_key)
```

#### 26.2.6 Métricas agregadas (cross-tenant, sem PII)

```sql
-- preenchidas por jobs com role de serviço; NUNCA por query ao vivo no request do painel
platform_metrics_daily (
  day               date primary key,
  gmv               numeric(16,2),       -- volume bruto processado (todas as orgs)
  base_commission   numeric(16,2),       -- comissão 7,99% capturada
  financing_spread  numeric(16,2),       -- spread de antecipação retido
  psp_fees          numeric(16,2),
  stanbase_net      numeric(16,2),       -- receita líquida plataforma
  active_orgs       int,
  new_orgs          int,
  churned_orgs      int,
  active_members    int,                 -- soma agregada, sem identificar
  new_members       int,
  txn_count         int,
  chargeback_count  int,
  computed_at       timestamptz default now()
)

platform_org_metrics (   -- por org, p/ ranking de orgs (org não é PII)
  org_id            uuid references organizations(id),
  day               date,
  gmv               numeric(14,2),
  stanbase_commission numeric(14,2),
  active_members    int,
  mrr               numeric(14,2),
  churn_rate        numeric(6,4),
  primary key (org_id, day)
)

-- fila de revisão de conciliação no nível plataforma (agrega reconciliation_exceptions das orgs)
platform_reconciliation_queue (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid,
  exception_id  uuid,                    -- ref a reconciliation_exceptions (§payments-billing)
  severity      text,                    -- low|medium|high
  status        text default 'open',     -- open|investigating|resolved
  assigned_to   uuid references platform_staff(id),
  resolved_by   uuid references platform_staff(id),
  created_at    timestamptz default now()
)
```

#### 26.2.7 Suporte / tickets (leve, MVP)

```sql
-- registro mínimo de atendimento; integra com ferramenta externa (§26.5) se houver
support_cases (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid references organizations(id),
  opened_by   uuid references platform_staff(id),
  subject     text,
  external_ref text,                     -- id no Intercom/Zendesk/Linear
  status      text default 'open',       -- open|pending|resolved
  created_at  timestamptz default now()
)
```

**Constraints/RLS-chave:**
- Todas as tabelas deste domínio têm RLS que **exige `platform_staff.status='active'`** e scope adequado; **negam** acesso a qualquer `org_users`/membro comum.
- `platform_audit_logs` e `impersonation_*` são **append-only** (policy nega UPDATE/DELETE; correção via novo registro).
- `feature_flag_overrides`: unique por `(flag_key, scope, org_id, account_id)` (não há dois overrides conflitantes).
- `org_platform_state.platform_status` e `account_platform_state.status` validados por CHECK/enum.
- Trigger: ao escrever `org_platform_state.platform_status` **sincroniza** `organizations.status` (suspended/active) na mesma transação.

#### 26.2.8 RLS e bypass de isolamento

- Função `auth.is_platform_staff()` (SECURITY DEFINER) → true se `auth.uid()` ∈ `platform_staff` ativo.
- Função `auth.staff_has_scope(module, action)`.
- **Bypass controlado:** policies das tabelas de **domínio de org** ganham um ramo adicional: `... OR (auth.is_platform_staff() AND auth.staff_has_scope(<module>, 'read') AND current_setting('app.support_context_org', true) = org_id::text)`. Ou seja, o staff só lê dados de **uma** org quando há um **contexto de suporte explícito** setado (via Edge Function que registrou o motivo) — **não** um bypass irrestrito. Para impersonation, o caminho é o **token de impersonation** que carrega `active_org_id` como se fosse o operador (RLS normal de org se aplica) + flag de auditoria.
- **Nunca** existe uma policy "staff vê tudo de todas as orgs sem contexto" para tabelas com PII. O agregado cross-tenant vem **só** das `platform_metrics_*`.

---

### 26.3 API & Edge Functions

> Endpoints internos sob **prefixo separado** `/internal/v1` (não `/v1` público), servidos só ao app `stanbase-admin`, atrás de SSO+MFA, **nunca** expostos no OpenAPI público nem no MCP público.

#### 26.3.1 Endpoints `/internal/v1`

```
# Staff & RBAC interno
GET    /internal/v1/staff
POST   /internal/v1/staff/invite
PATCH  /internal/v1/staff/{id}                 # papel/scopes/status
POST   /internal/v1/staff/{id}/offboard        # encerra acesso + revoga sessões

# Contas & Orgs (gestão cross-tenant)
GET    /internal/v1/accounts                   # listar/buscar contas
GET    /internal/v1/accounts/{id}
GET    /internal/v1/orgs                        # listar/filtrar (status, kyc, risco, plano)
GET    /internal/v1/orgs/{id}                   # ficha 360º da org (agregado + saúde)
POST   /internal/v1/orgs/{id}/suspend           # restricted|suspended|under_moderation (+motivo)
POST   /internal/v1/orgs/{id}/reinstate
GET    /internal/v1/orgs/{id}/audit             # audit_logs daquela org (read)

# Suporte read-only (abre contexto de 1 org com motivo)
POST   /internal/v1/support/context             # seta app.support_context_org (motivo/ticket) → token de suporte
GET    /internal/v1/support/members/{memberId}  # ficha de 1 membro (PII sob reveal)
POST   /internal/v1/support/pii-reveal          # revela 1 campo PII (motivo) → logado

# Impersonation
POST   /internal/v1/impersonation/start         # {org_id, target_org_user_id, reason, ticket_ref}
POST   /internal/v1/impersonation/{id}/end
POST   /internal/v1/impersonation/{id}/unlock-destructive  # libera ações destrutivas (motivo, scope alto)
GET    /internal/v1/impersonation/active         # sessões ativas (kill-switch)

# Billing da plataforma
GET    /internal/v1/platform/revenue            # GMV, comissão, spread, net (agregado, por período)
GET    /internal/v1/platform/orgs-revenue       # ranking de orgs por GMV/comissão
GET    /internal/v1/platform/payouts            # repasses agregados / em hold
POST   /internal/v1/platform/payouts/{id}/hold  # congela repasse (fraude/disputa)
GET    /internal/v1/platform/reconciliation     # fila de exceções de conciliação (cross-org)
POST   /internal/v1/platform/refund             # reembolso pela plataforma (liability: org|stanbase|split)

# Feature flags
GET    /internal/v1/flags
POST   /internal/v1/flags                        # criar/atualizar flag global + rollout
PUT    /internal/v1/flags/{key}/override         # override por org/conta (+TTL)
DELETE /internal/v1/flags/{key}/override/{id}

# Moderação
POST   /internal/v1/moderation/orgs/{id}/flag
POST   /internal/v1/moderation/content/{id}/takedown

# Métricas / observabilidade de plataforma
GET    /internal/v1/metrics/overview
GET    /internal/v1/metrics/kyc-pending          # orgs com subconta Asaas ≠ active
GET    /internal/v1/platform/audit               # platform_audit_logs (filtros)
```

```
# Exposição read-only PARA a org (não-interno): a org lê suas próprias flags
GET    /v1/feature-flags                          # resolvido p/ org da credencial (público/admin)
```

#### 26.3.2 Edge Functions / Jobs

```
fn:impersonation-start        # valida, cria sessão, emite token de impersonation, notifica owner
fn:impersonation-end          # encerra/expira/kill, registra duração e contagem de ações
fn:support-context-open       # registra motivo, seta contexto de suporte read-only (1 org)
fn:pii-reveal                 # desmascara 1 campo, loga (pii.revealed)
fn:org-suspend                # aplica restricted/suspended/under_moderation + efeitos + sync organizations.status
fn:org-reinstate              # reverte
fn:platform-refund            # wrapper sobre fn:refund-process com liability + auditoria
fn:flag-resolve               # resolve valor de flag p/ (org) — usado por /v1/feature-flags (cache curto)
fn:staff-offboard             # revoga sessões/tokens do staff, marca offboarded

job:platform-metrics-rollup (cron, diário/horário)  # popula platform_metrics_daily / platform_org_metrics
job:risk-scoring (cron)        # recalcula risk_score/chargeback_rate por org → flag automático
job:auto-suspend (cron)        # candidatos a restricted/suspend (delinquência, KYC parado, chargeback alto) → fila p/ revisão humana
job:impersonation-reaper (cron)# expira sessões além do TTL (rede de segurança ao TTL do token)
job:recon-aggregator (cron)    # agrega reconciliation_exceptions das orgs em platform_reconciliation_queue
job:audit-retention (cron)     # arquiva/retém platform_audit_logs conforme política (sem deletar antes do prazo legal)
```

> **`job:auto-suspend` nunca suspende sozinho** ações que afetam o membro pagante sem **revisão humana** (default). Ele **enfileira candidatos**; a suspensão dura é confirmada por staff. (Decisão §26.8 — pode haver suspensão 100% automática para fraude flagrante.)

---

### 26.4 Telas / Front (`apps/stanbase-admin`)

App interno separado, design system próprio (pode reusar `packages/ui` com tema "internal" distinto para **não** confundir com admin de org). Tudo atrás de SSO+MFA.

- **Dashboard de plataforma:** GMV, comissão capturada, spread de financiamento, receita líquida Stanbase, orgs ativas/novas/churned, membros agregados, alertas (KYC parado, chargeback alto, conciliação pendente, orgs em risco). Tudo **agregado**.
- **Contas & Orgs (lista):** busca/filtro por status, KYC, plano, risco, vertical; colunas de GMV, comissão, membros, status de plataforma. Ação rápida: abrir ficha, suspender, impersonar.
- **Ficha da Org (360º interno):** dados da org + Conta dona; saúde (KYC, risco, chargeback, conciliação); métricas; histórico de suspensões/moderação; **botões: Acessar como (impersonate), Read-only suporte, Suspender/Restringir, Feature flags, Ver audit**.
- **Sessão de impersonation:** ao iniciar, **redireciona para o admin da org real** com **banner persistente** (operador, org, timer, encerrar). Lista de **sessões ativas** com kill-switch.
- **Suporte / Ticket:** busca de membro por ID/e-mail (cross-org com cuidado — exige contexto), ficha read-only com PII mascarada + reveal auditado, ações de billing (estorno pela plataforma) com confirmação dupla.
- **Billing da plataforma:** receita (base vs spread), repasses, em-hold, **conciliação Asaas** (fila de exceções cross-org, atribuir/resolver), reembolsos pela plataforma (com seletor de `liability`).
- **Feature flags:** lista de flags, valor default + rollout, **matriz de overrides por org/conta**, criar/editar, kill-switch com TTL.
- **Moderação / Trust&Safety:** fila de casos, takedown de conteúdo, flag/suspensão de org, denúncias.
- **Staff & permissões:** gestão de funcionários internos, papéis/scopes, convites, offboarding, MFA status.
- **Auditoria de plataforma:** `platform_audit_logs` filtrável (por staff, ação, org, período) — incl. quem revelou PII, quem impersonou, quem viu financeiro.

> **No app de org (admin do dono), telas tocadas por este domínio:** (a) **banner de impersonation** quando há sessão Stanbase ativa + lista "Acessos de suporte ativos" em Configurações com **botão encerrar**; (b) **banner de org suspensa/restrita** com motivo e o que fazer; (c) leitura de **feature flags** que ligam/desligam módulos do próprio admin.

---

### 26.5 Integrações externas

- **Supabase Auth (SSO + MFA):** SSO corporativo (Google Workspace / SAML) para staff; **MFA obrigatório**. Possível Supabase project/instância separada ou claims/allowlist por domínio de e-mail (decisão §26.8).
- **Asaas (visão plataforma):** leitura agregada de transfers/settlements/antecipações para **conciliação cross-org** e de **status de subconta/KYC** (orgs com KYC pendente). Congelamento de payout (`on_hold`) e reembolso pela plataforma reusam o `AsaasProvider` (§payments-billing §10.5). Não há "subconta da Stanbase" exposta aqui além do walletId que recebe a comissão.
- **Ferramenta de suporte/tickets** (Intercom / Zendesk / Linear) — `external_ref` em `support_cases`; deep-link do painel para o ticket e vice-versa (pós-MVP).
- **Observabilidade** (logs/tracing/alertas, §STANBASE §27, domínio `observability-qa`): o painel surfa alertas técnicos e de negócio; jobs publicam métricas.
- **Comunicação** (e-mail, domínio `communication`): notificações ao owner (impersonation iniciada, org suspensa, reembolso pela plataforma, carência).
- **LLM (opcional, pós-MVP):** copiloto interno de suporte ("resuma o problema desta org", "explique esta divergência de conciliação") — sempre sobre dados já autorizados, com guardrails (§STANBASE §19.1).

---

### 26.6 Épicos & tarefas

#### Épico E1 — Fundação do painel interno + RBAC de staff
- T1.1 `platform_staff` + `platform_staff_invites` + RLS (`is_platform_staff`, `staff_has_scope`). **M**
- T1.2 App `apps/stanbase-admin` (shell, roteamento, layout, tema "internal" distinto). **M**
- T1.3 SSO corporativo + **MFA obrigatório** + allowlist de domínio de e-mail. **M**
- T1.4 Convite/onboarding/offboarding de staff (`fn:staff-offboard` revoga sessões). **M**
- T1.5 Middleware de scope nas Edge Functions `/internal/v1`. **S**

#### Épico E2 — Auditoria de plataforma (transversal, fazer cedo)
- T2.1 `platform_audit_logs` append-only + policy nega update/delete. **M**
- T2.2 Helper de auditoria (toda Edge Function interna loga ação/motivo/ip/payload redigido). **M**
- T2.3 Tela de auditoria filtrável (staff, ação, org, período). **M**
- T2.4 `job:audit-retention` (retenção legal, sem deletar antes do prazo). **S**

#### Épico E3 — Gestão de Contas & Orgs
- T3.1 `org_platform_state` + `account_platform_state` + triggers de sync com `organizations.status`. **M**
- T3.2 `/internal/v1/orgs` + `/accounts` (listas/filtros/busca, ficha 360º interna). **L**
- T3.3 Dashboard de saúde da org (KYC, risco, chargeback, conciliação). **M**

#### Épico E4 — Suspensão / moderação
- T4.1 `fn:org-suspend` / `fn:org-reinstate` (restricted|suspended|under_moderation + efeitos idempotentes). **L**
- T4.2 Gates nos domínios afetados (checkout/payout bloqueados; claims derrubados). **M**
- T4.3 Telas de suspensão + moderação (motivo, carência, template de e-mail). **M**
- T4.4 Takedown de conteúdo (`moderation/content/{id}/takedown`). **M**
- T4.5 `job:risk-scoring` + `job:auto-suspend` (enfileira candidatos p/ revisão humana). **L**

#### Épico E5 — Impersonation segura e auditada
- T5.1 `impersonation_sessions` + `impersonation_actions` + estados/TTL. **M**
- T5.2 `fn:impersonation-start` (token dedicado, claims de impersonation, notifica owner). **L**
- T5.3 `fn:impersonation-end` + `job:impersonation-reaper` + kill-switch (owner & superadmin). **M**
- T5.4 **Bloqueio de ações destrutivas/financeiras** durante impersonation + `unlock-destructive`. **L**
- T5.5 Duplo log (audit_logs da org + platform_audit_logs) com `impersonated_by`/`session_id`. **M**
- T5.6 Banner persistente no admin da org + "acessos de suporte ativos" (com encerrar). **M**

#### Épico E6 — Suporte read-only + reveal de PII
- T6.1 `fn:support-context-open` (motivo/ticket → `app.support_context_org`) + ramo RLS de leitura. **L**
- T6.2 `fn:pii-reveal` (desmascara 1 campo, loga) + mascaramento por default. **M**
- T6.3 Telas de suporte (busca de membro, ficha read-only, ações de billing). **M**
- T6.4 `support_cases` + integração leve com ferramenta externa (external_ref). **S**

#### Épico E7 — Billing da plataforma & reembolso
- T7.1 `fn:platform-refund` (liability org|stanbase|split, wrapper sobre `fn:refund-process`). **L**
- T7.2 Congelar payout (`on_hold`) + saldo `platform_balance` (crédito a receber da org). **M**
- T7.3 `job:recon-aggregator` + `platform_reconciliation_queue` + tela de conciliação. **L**
- T7.4 `/internal/v1/platform/revenue` + dashboard (comissão base vs spread vs net). **M**

#### Épico E8 — Métricas agregadas cross-tenant
- T8.1 `platform_metrics_daily` + `platform_org_metrics` + `job:platform-metrics-rollup`. **L**
- T8.2 Regras de k-anonimato/supressão (proibir top-membros cross-tenant). **M**
- T8.3 Dashboard de plataforma + auditoria de leitura de dados financeiros. **M**
- T8.4 Tela `kyc-pending` (orgs com subconta Asaas ≠ active). **S**

#### Épico E9 — Feature flags
- T9.1 `feature_flags` + `feature_flag_overrides` (resolução em camadas + TTL). **M**
- T9.2 `fn:flag-resolve` + `GET /v1/feature-flags` (leitura pela org, cache curto). **M**
- T9.3 Telas: lista de flags, matriz de overrides por org/conta, kill-switch. **M**
- T9.4 SDK/cliente de flag no admin de org, front de membro e Edge Functions. **M**

#### Épico E10 — Hardening & segurança
- T10.1 Pentest do bypass de RLS (garantir que staff sem contexto não lê org). **M**
- T10.2 Rate limit/alerta de comportamento anômalo de staff (muitos reveals/impersonations). **M**
- T10.3 Testes de isolamento cross-tenant (nenhuma tela vaza PII de N orgs). **M**

---

### 26.7 Dependências

| Depende de | Por quê |
|---|---|
| **fundacao** | Postgres/RLS, pgmq/pg_cron (jobs de rollup/risco/reaper), Vault, ambientes (§28.2), esqueleto Edge Functions. |
| **auth-rbac** | Modelo Conta→Org, `org_users`, claims/JWT, `organizations.status`, `audit_logs` de org; impersonation reusa o contexto de org; suspensão derruba claims. **Dependência mais forte.** |
| **payments-billing** | Comissão/spread/`transactions`/`payouts`/`refunds`/`asaas_subaccounts` (KYC) — billing da plataforma, conciliação, reembolso e congelamento de payout são leituras/wrappers desse domínio. |
| **member-identity / crm** | Suporte read-only e reveal de PII operam sobre membros; estorno reflete na timeline do CRM. |
| **security-lgpd** | Mascaramento/reveal auditado, retenção de logs, DPA, preservação de registros financeiros em anonimização, regras de PII cross-tenant. |
| **communication** | Notificações ao owner (impersonation, suspensão, carência, reembolso pela plataforma). |
| **observability-qa** | Alertas técnicos/negócio no painel, métricas dos jobs, monitoramento de conciliação/DLQ. |
| **content-gating** | Takedown de conteúdo na moderação. |
| **integrations-framework** | Mascaramento de credenciais cifradas (nunca revelar segredo cru, nem em impersonation). |
| **admin-app** | Banner de impersonation, banner de suspensão e leitura de feature flags dentro do admin de org. |

**Quem depende deste domínio:** `auth-rbac` referencia o bypass/suspensão definidos aqui; `payments-billing` espera o `on_hold`/reembolso pela plataforma; todos os domínios consomem **feature flags** para rollout; todos produzem dados que aparecem nas **métricas agregadas**.

---

### 26.8 Riscos & decisões técnicas (edge cases)

1. **Impersonation é o maior vetor de abuso interno.** Mitigações obrigatórias: token dedicado e distinguível, TTL curto, motivo obrigatório, duplo log, banner ao owner + kill-switch, bloqueio de ações destrutivas por default. **Decisão pendente:** exigir aprovação prévia (4-eyes) e/ou consentimento do owner antes de iniciar? (Trade-off fricção × controle.)
2. **Bypass de RLS por contexto, não irrestrito.** O staff só lê **uma** org com contexto explícito (motivo). Um bug que vaze um bypass amplo = vazamento entre **todos** os tenants. Exige teste de isolamento dedicado (E10) e revisão de toda policy que tenha o ramo `is_platform_staff`.
3. **Métricas cross-tenant vs. PII.** Rankings de membros cross-tenant são proibidos; só agregados/por-org. Risco de alguém "derivar" um membro de um agregado pequeno → k-anonimato/supressão. **Decisão:** definir o limiar de supressão (ex.: não mostrar célula com < 5 membros).
4. **Suspensão punindo o fã errado.** Suspender uma org corta o acesso de membros que **pagaram de boa-fé**. Por isso o estado `restricted` intermediário e a regra "membros pagantes mantêm acesso na restrição". **Decisão de produto:** na suspensão dura, o membership pago é **mantido até o fim do período** ou cortado? E o passport mostra "inativo" ou "comunidade indisponível"? (Recomendação: manter acesso pago / mensagem neutra, não "inativo".)
5. **Reembolso pela plataforma e `liability`.** Definir quem absorve o estorno (org/stanbase/split) tem impacto financeiro direto e pode deixar a org com saldo negativo. **Decisão:** política default de quem paga em cada cenário (fraude da org × erro nosso × decisão de chargeback) e se a Stanbase adianta com `platform_balance` negativo.
6. **KYC pendente trava receita, mas não é culpa do painel.** O super-admin acompanha/destrava, mas o estado é do Asaas. Edge case: org publica tier pago e fica `kyc_blocked` indefinidamente → comunicar e oferecer caminho (alinhado a §payments §10.8.10).
7. **Auditoria de leitura, não só de escrita.** Ver PII e ver financeiro de plataforma são ações sensíveis que precisam ser logadas mesmo sendo "só leitura" (LGPD/insider risk). Custo de log alto em volume → amostrar? Não para PII/financeiro (logar sempre).
8. **Offboarding de staff precisa ser imediato.** Funcionário que sai não pode manter sessão; `staff-offboard` revoga refresh tokens + mata sessões de impersonation ativas. TTL curto + SSO corporativo (desativar no IdP propaga).
9. **Feature flag como kill-switch crítico.** Flags com TTL e scope elevado para mudanças sensíveis; risco de flag mal configurada derrubar uma feature de muitas orgs → exigir confirmação/preview de impacto ("esta mudança afeta N orgs").
10. **App e auth separados de verdade.** Servir o painel interno sob o mesmo domínio/auth do admin de org aumentaria a superfície de ataque e o risco de confusão de contexto. Decisão: instância/domínio dedicado + MFA. **Pendente:** mesmo Supabase project com allowlist por e-mail, ou project separado?
11. **Determinismo da conciliação cross-org.** O painel agrega `reconciliation_exceptions` das orgs; precisa de fonte única de verdade (job de payments) para não divergir. Evitar recalcular conciliação aqui — só **agregar e atribuir**.
12. **Notificar o owner da impersonation pode atrapalhar suporte sensível** (ex.: investigação de fraude do próprio owner). **Decisão:** permitir impersonation **silenciosa** restrita a trust_safety/superadmin com justificativa reforçada e auditoria extra (não notifica o owner-suspeito), enquanto o suporte comum sempre notifica.

---

### 26.9 Escopo MVP vs. depois

**MVP** (necessário para operar a plataforma com segurança desde o primeiro cliente pago — STANBASE §29 Fases 0–1):
- `platform_staff` + RBAC interno + SSO/MFA + app `stanbase-admin` (shell).
- **`platform_audit_logs` append-only** (transversal — sem isso, nada interno deveria existir).
- Gestão de Contas/Orgs (lista, ficha 360º interna, saúde/KYC).
- **Suspensão `restricted`/`suspended`** + gates de checkout/payout + sync de status + banners (essencial p/ inadimplência/abuso).
- **Impersonation segura e auditada** (token dedicado, TTL, banner, duplo log, bloqueio de destrutivas, kill-switch) — suporte não opera sem isso.
- Suporte read-only + **reveal de PII auditado** (mascaramento por default).
- Billing da plataforma básico: dashboard de comissão base vs spread; congelar payout; **reembolso pela plataforma** com `liability`.
- Métricas agregadas básicas (rollup diário, dashboard, `kyc-pending`).
- Feature flags com override por org + kill-switch (mesmo que poucas flags no início).

**Depois (pós-MVP):**
- Aprovação 4-eyes / consentimento do owner para impersonation; impersonation silenciosa para trust&safety.
- Moderação avançada (fila de denúncias, takedown sofisticado, score de risco automático com auto-suspensão para fraude flagrante).
- Conciliação cross-org avançada (auto-resolução de exceções, alertas).
- Copiloto interno de suporte (LLM) sobre conciliação/tickets.
- Integração profunda com ferramenta de tickets (Intercom/Zendesk/Linear) bidirecional.
- `account_platform_state` com gestão de crédito/cobrança da plataforma elaborada (planos enterprise, faturas da plataforma).
- Métricas/coortes avançadas, exportações, BI.
- Rollouts por segmento/% e experimentação (A/B) sobre feature flags.
