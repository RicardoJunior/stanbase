## 05. Fundação & Arquitetura

> Domínio base que sustenta todos os demais. Define o monorepo, o projeto Supabase, os padrões de Edge Functions, a estratégia de RLS multi-tenant por `org_id`, a geração de tipos (DB→TS e OpenAPI→SDK/MCP), CI/CD, ambientes e convenções de código. **Não entrega features de produto** — entrega o chão sobre o qual `auth-rbac`, `member-identity`, `payments-billing`, `public-api`, etc. são construídos.
>
> Fontes de verdade no doc: §6 (Arquitetura e stack), §28 (Estrutura de repositório e ambientes), §26 (Segurança/RLS/LGPD), §25 (Modelo de dados), §21 (API REST + OpenAPI).

---

### 1. Como funciona

Este domínio não tem "máquina de estados de produto"; tem **máquinas de estado de plataforma** que governam como código vira ambiente rodando. Três fluxos centrais.

#### 1.1 Princípio arquitetural (decidido no doc, §6.2)

Existem **dois caminhos de acesso a dados**, e a fundação tem que tornar essa distinção física e impossível de confundir:

1. **App interno (admin, member, superadmin)** → fala direto com Postgres via **`supabase-js` + RLS**. Rápido, sem camada intermediária, isolamento garantido por política de banco. Usa o **JWT do usuário** (claims com `org_id` e `role`).
2. **API pública `/v1` (parceiros, headless, MCP, webhooks)** → passa por **Edge Functions (TS/Deno)** que expõem DTOs versionados, autenticam por **API key / OAuth client-credentials / JWT**, aplicam rate-limit, idempotência e auditoria, e só então tocam o banco usando a **service role** com `org_id` derivado da credencial (nunca confiando em input do cliente).

> Regra de ouro da fundação: **o front nunca usa a API `/v1` para ler/escrever seus próprios dados** — usa `supabase-js`. A API `/v1` é para terceiros. Isso evita duplicar latência e mantém o dogfooding correto (o admin chama a mesma API só onde faz sentido expor uma capacidade pública). *Edge case:* operações que exigem segredos (split Asaas, assinatura de `.pkpass`, chamada a LLM) **sempre** passam por Edge Function mesmo vindas do app interno, porque o segredo não pode chegar ao browser.

#### 1.2 Máquina de estados — ciclo de vida de uma migration

```
[escrita local] → [aplicada em dev] → [PR aberto] → [CI: lint+typecheck+RLS tests+migration dry-run]
   → [merge main] → [aplicada em staging (auto)] → [smoke + RLS tests em staging]
   → [tag release / aprovação manual] → [aplicada em prod] → [imutável]
```

Regras concretas:
- Migrations são **append-only e versionadas por timestamp** (`supabase migration new <nome>` → `supabase/migrations/<timestamp>_<nome>.sql`). Nunca editar uma migration já aplicada em staging/prod; corrige-se com **nova** migration.
- Toda migration que cria tabela de domínio **deve** no mesmo arquivo: (a) criar a coluna `org_id`, (b) `ENABLE ROW LEVEL SECURITY`, (c) `FORCE ROW LEVEL SECURITY`, (d) criar as policies via helper, (e) criar índice em `org_id`. Um teste de CI falha o build se existir tabela com `org_id` e RLS desabilitada (lint estrutural).
- **Rollback:** não há `down` automático em produção (Supabase CLI não roda down em prod com segurança). A estratégia é **roll-forward**: nova migration que corrige. Migrations devem ser desenhadas para serem **backward-compatible** com o código já em prod (expand/contract: primeiro adiciona coluna nullable, deploya código, depois backfill, depois torna NOT NULL em migration separada).

#### 1.3 Máquina de estados — deploy de uma Edge Function

```
[código em functions/] → [deno check + test local] → [PR/CI] → [deploy staging via CLI]
   → [smoke test contra staging] → [deploy prod] → [versionado por /v1 no path, nunca breaking dentro de major]
```

#### 1.4 Fluxo passo a passo — geração de tipos (a "cola" do monorepo)

A coerência de tipos é o que faz o monorepo valer a pena. Dois geradores, encadeados:

1. **DB → TS:** `supabase gen types typescript` lê o schema do banco e gera `packages/types/src/database.types.ts`. Consumido pelo `supabase-js` (tipa queries do app interno) e pelas Edge Functions (tipa acesso ao banco). Rodado no CI **após** aplicar migrations; se o output diverge do commitado, o build falha (garante que ninguém mexeu no schema sem regenerar).
2. **OpenAPI → SDK/MCP/Tipos da API:** `openapi/openapi.yaml` é a fonte de verdade do contrato público. Um gerador (ex.: `openapi-typescript` para tipos + gerador custom para o cliente) produz: `packages/sdk-js` (cliente público), os request/response types em `packages/types/src/api.types.ts`, e o `packages/mcp-server` (cada operação OpenAPI vira uma tool MCP). Tudo no CI; divergência = build falha.

> *Edge case crítico:* os tipos do **banco** (`database.types.ts`, `snake_case`, colunas internas) e os tipos da **API pública** (`api.types.ts`, DTOs limpos) são **deliberadamente diferentes**. As Edge Functions fazem o mapeamento `Row → DTO`. Nunca vazar `database.types.ts` para o `sdk-js`. Quem confunde isso acopla o contrato público ao schema interno e perde a liberdade de evoluir o banco.

#### 1.5 Regras de negócio concretas da fundação

- **Isolamento por org é inviolável.** Toda query do app interno passa por RLS; toda Edge Function deriva `org_id` da credencial, nunca do body. Um vazamento cross-org é incidente de severidade máxima.
- **`org_id` no JWT.** No login, um hook de Auth (Custom Access Token Hook do Supabase Auth) injeta nos claims o `org_id` ativo, o `account_id` e o `role` do usuário naquela org. Como uma Conta tem N orgs (§2 do doc), o JWT carrega a **org ativa** (a selecionada no seletor de org do admin); trocar de org **re-emite o token** com novo `org_id`.
- **Service role nunca chega ao browser.** Só vive em Edge Functions (secret do projeto). O front usa exclusivamente a `anon key` + JWT do usuário.
- **Nada é hard-coded por tenant.** Marca, tema, domínio, comissão — tudo é dado em tabela. O código é idêntico para todos os tenants (princípio do admin padronizado, §10).

---

### 2. Modelo de dados

A fundação **não** cria tabelas de domínio (isso é dos outros domínios), mas cria a **infraestrutura de schema** que todos herdam: helpers de RLS, função de claims, tabelas de plataforma e convenções. As tabelas `accounts`, `organizations`, `org_users` são do doc §25.1 e tecnicamente nascem aqui (são pré-requisito de RLS) — porém o RBAC/permissões delas pertence ao domínio `auth-rbac`. A fundação cria **a estrutura mínima** dessas três para o RLS funcionar; `auth-rbac` enriquece.

#### 2.1 Tabelas criadas/tocadas pela fundação

**`accounts`** (estrutura mínima — dona de N orgs)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK default `gen_random_uuid()` | |
| `name` | `text` not null | |
| `owner_user_id` | `uuid` → `auth.users.id` | |
| `created_at` | `timestamptz` default `now()` | |

**`organizations`** (estrutura mínima — 1 membership por org)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK | |
| `account_id` | `uuid` → `accounts.id` not null | índice |
| `slug` | `text` UNIQUE not null | usado em `slug.stanbase.com` |
| `name` | `text` not null | |
| `status` | `text` default `'active'` | `active`/`suspended`/`deleted` |
| `created_at` | `timestamptz` default `now()` | |

> `brand`, `domain` e tema detalhado pertencem a `design-system`/`admin-app`; aqui fica só o esqueleto.

**`org_users`** (estrutura mínima — vínculo usuário×org, base do RLS e do claim)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK | |
| `org_id` | `uuid` → `organizations.id` not null | índice |
| `user_id` | `uuid` → `auth.users.id` not null | índice |
| `role` | `text` not null | `owner`/`admin`/`operator` (enriquecido por `auth-rbac`) |
| `created_at` | `timestamptz` default `now()` | |
| | | UNIQUE(`org_id`,`user_id`) |

**`platform_billing_settings`** (do doc §25.3 — padrão Stanbase global, sem `org_id`)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | `int` PK = 1 (singleton, CHECK `id = 1`) | uma linha só |
| `base_commission_rate` | `numeric(6,4)` = `0.0799` | 7,99% |
| `installment_interest_rate_am` | `numeric(6,4)` = `0.0349` | 3,49% a.m. |
| `max_installments` | `int` = `12` | teto fixo |
| `psp_anticipation_rate_am` | `numeric(6,4)` nullable | preenchido após contrato Asaas |

> Aqui só a **estrutura e o seed**; a lógica de cálculo é de `payments-billing`. Fica na fundação porque é singleton de plataforma e várias migrations de outros domínios podem referenciá-lo.

**`audit_logs`** (do doc §25.6 — estrutura base, append-only)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | `bigint` GENERATED ALWAYS AS IDENTITY PK | |
| `org_id` | `uuid` nullable | nullable p/ ações de superadmin sem org |
| `actor` | `uuid`/`text` | user id, api key id ou `system` |
| `action` | `text` not null | ex.: `member.created` |
| `target` | `text` | tipo+id do alvo |
| `payload` | `jsonb` | diff/contexto |
| `at` | `timestamptz` default `now()` | índice `(org_id, at desc)` |

**`idempotency_keys`** (infra de Edge Functions — do princípio §21.1)
| Coluna | Tipo | Notas |
|---|---|---|
| `key` | `text` | a `Idempotency-Key` do header |
| `org_id` | `uuid` | escopo |
| `endpoint` | `text` | método+rota |
| `request_hash` | `text` | hash do body p/ detectar reuso indevido da mesma key com payload diferente |
| `response_status` | `int` nullable | preenchido ao concluir |
| `response_body` | `jsonb` nullable | resposta cacheada p/ replay |
| `status` | `text` | `in_progress`/`completed` |
| `created_at` | `timestamptz` default `now()` | TTL via job (ex.: 24–72h) |
| | | PK (`org_id`,`endpoint`,`key`) |

#### 2.2 Funções/helpers de schema (SQL)

- **`auth.org_id()`** → `STABLE` SQL que lê `org_id` do JWT: `(current_setting('request.jwt.claims', true)::jsonb ->> 'org_id')::uuid`. Base de toda policy.
- **`auth.user_role()`** → idem para `role`.
- **`auth.has_org_access(target_org uuid)`** → `EXISTS (SELECT 1 FROM org_users WHERE org_id = target_org AND user_id = auth.uid())`. Usado por superadmin/edge quando o claim sozinho não basta.
- **Macro/convenção `apply_org_rls(table_name)`** (gerada por migration helper) que cria as 4 policies padrão (select/insert/update/delete) com o predicado `org_id = auth.org_id()`.

#### 2.3 Política base de RLS (template que todo domínio herda)

```sql
-- aplicado a TODA tabela de domínio com org_id
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE ROW LEVEL SECURITY;

CREATE POLICY <t>_select ON <t> FOR SELECT
  USING (org_id = auth.org_id());
CREATE POLICY <t>_insert ON <t> FOR INSERT
  WITH CHECK (org_id = auth.org_id());
CREATE POLICY <t>_update ON <t> FOR UPDATE
  USING (org_id = auth.org_id()) WITH CHECK (org_id = auth.org_id());
CREATE POLICY <t>_delete ON <t> FOR DELETE
  USING (org_id = auth.org_id());
```

> *Edge cases das policies:* (1) **service role bypassa RLS** — por isso Edge Functions filtram `org_id` na query explicitamente, nunca confiam só na ausência de policy; (2) tabelas **globais** (`platform_billing_settings`) não têm `org_id` e usam política diferente (leitura para autenticados, escrita só superadmin/service); (3) a rota **pública** de verificação (`verify.stanbase.com`) lê com role anônima e precisa de policy específica que expõe **só o mínimo** (resolvida via Edge Function/view, não acesso direto à tabela `members`).

#### 2.4 Índices e constraints transversais

- Índice em **`org_id`** em toda tabela de domínio (predicado de RLS roda em todo acesso).
- `gen_random_uuid()` (pgcrypto/pgsodium) como default de PK uuid; padronizar para não misturar com `uuid_generate_v4`.
- `created_at`/`updated_at` `timestamptz` em **UTC** com trigger `set_updated_at()` reaproveitável.
- Extensões habilitadas em migration inicial: `pgcrypto`, `pg_cron`, `pgmq`, `pgvector`, `pg_net` (para HTTP em jobs, se usado).

---

### 3. API & Edge Functions

A fundação entrega **padrões e scaffolding**, não endpoints de negócio. Mas define o esqueleto da API `/v1` e os jobs de plataforma.

#### 3.1 Esqueleto de API (entregue pela fundação)

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/v1/health` | Liveness/readiness (DB ping, versão, ambiente). |
| `GET` | `/v1/docs` | Swagger UI público renderizando `openapi.yaml`. |
| `GET` | `/v1/openapi.json` | Spec OpenAPI 3.1 servida (fonte p/ SDK/MCP externos). |

> Endpoints de negócio (`/v1/members`, `/v1/subscriptions`, etc., §21.2) pertencem aos respectivos domínios. A fundação cria o **roteador, o middleware e os contratos transversais** que todos eles usam.

#### 3.2 Estrutura padrão de uma Edge Function

```
functions/
├── _shared/                  # libs compartilhadas (NÃO é function deployável)
│   ├── supabase.ts           # factory de client (service vs. user-scoped)
│   ├── auth.ts               # parse de JWT/API key → { orgId, role, actor }
│   ├── errors.ts             # AppError + códigos + envelope
│   ├── validation.ts         # wrapper de schema (zod/valibot)
│   ├── idempotency.ts        # middleware de Idempotency-Key
│   ├── ratelimit.ts          # token-bucket por credencial/IP
│   ├── logger.ts             # log estruturado JSON + request_id
│   ├── response.ts           # ok()/created()/paginated()/error()
│   └── cors.ts
├── v1-router/                # function única que roteia /v1/* (ou 1 fn por recurso)
├── webhooks-asaas/           # webhook de entrada (verificação de assinatura)
├── passport-issue/           # gera pkpass / Google Wallet JWT (segredo!)
└── jobs/                     # acionados por pg_cron/pgmq
```

**Decisão de arquitetura (edge case):** Edge Functions do Supabase têm cold start e limite de tamanho. Opções: (a) **uma function monolítica `v1-router`** que faz roteamento interno — menos cold starts, deploy único, mais simples para versionar `/v1`; (b) **uma function por recurso** — isola falhas, deploys independentes, mas mais cold starts e duplicação de middleware. **Recomendação:** começar com `v1-router` monolítica + middleware compartilhado de `_shared`, e extrair functions dedicadas só para cargas pesadas/isoladas (passport, webhooks, jobs IA). Reavaliar quando latência/tamanho doer.

#### 3.3 Contratos transversais (todos definidos pela fundação)

- **Envelope de erro** (§21.1): `{ "error": { "code": "string", "message": "human", "details": {...}, "request_id": "..." } }`. Códigos canônicos: `unauthorized`, `forbidden`, `not_found`, `validation_failed`, `rate_limited`, `idempotency_conflict`, `conflict`, `internal`. HTTP status mapeado por código.
- **Sucesso:** objeto direto para single, `{ "data": [...], "next_cursor": "..." }` para listas (cursor, §21.1).
- **Validação de input:** todo handler valida body/query/params com schema (zod-like) **antes** de tocar o banco; falha → `validation_failed` com `details` por campo. Schemas derivam do OpenAPI quando possível.
- **Idempotência:** middleware obrigatório em POSTs financeiros (assinatura, ticket, gift pago). Fluxo: lê `Idempotency-Key` → busca em `idempotency_keys` (por `org_id`+`endpoint`+`key`) → se `completed` e mesmo `request_hash`, **replay** da resposta cacheada; se `in_progress`, retorna `409 idempotency_conflict`; se key reusada com `request_hash` diferente, `422`. Sem a key em endpoint que exige → `400`.
- **Logging:** uma linha JSON por request com `request_id`, `org_id`, `actor`, `route`, `status`, `latency_ms`, `error_code?`. Nunca logar PII/segredos. `request_id` propagado no header de resposta (`x-request-id`).
- **Rate limiting:** token-bucket por API key (e por IP na rota pública), com `429 rate_limited` e headers `Retry-After`/`RateLimit-*`.
- **Auth resolver:** ordem API key → OAuth client-cred → JWT. Resolve `orgId` da **credencial**, nunca do body.

#### 3.4 Jobs/cron de plataforma (entregues pela fundação)

| Job | Trigger | Descrição |
|---|---|---|
| `idempotency-gc` | `pg_cron` diário | Expira chaves de idempotência antigas. |
| `dlq-monitor` | `pg_cron` a cada N min | Alerta sobre mensagens paradas na DLQ do `pgmq`. |
| `audit-retention` | `pg_cron` | Política de retenção/particionamento de `audit_logs`. |
| `health-canary` | `pg_cron` | Ping sintético que alimenta a status page. |

> A **infra de filas** (`pgmq`: criar filas, padrão de enqueue/consume, DLQ, retry com backoff) e o **padrão de worker** (Edge Function consumindo via `pg_cron` ou Realtime) são entregues aqui como biblioteca, e os domínios (campanhas, push de passes, sync de integrações) só publicam/consomem.

---

### 4. Telas/Front

A fundação **não** tem telas de produto, mas estabelece os **shells de aplicação** e a infraestrutura de front que os domínios preenchem.

- **Shell do `apps/admin`:** layout com **seletor de org** no topo (troca de `org_id` → re-emite JWT → recarrega contexto), navegação dos 14 módulos (§10.1) como rotas-stub, `QueryClientProvider` (TanStack Query), provider de Supabase client (singleton com refresh de sessão), boundary de erro global, e o `ThemeProvider` que lê tokens da org.
- **Shell do `apps/member`:** shell temável (white-label) com `ThemeProvider` por org (resolve org pelo subdomínio/domínio), provider de auth social, e roteador das telas de membro como stubs.
- **Shell do `apps/superadmin`:** layout multi-tenant sem RLS de org (usa role de superadmin), lista de orgs, troca de contexto, feature flags.
- **Provider de dados:** wrapper `useSupabase()` tipado com `database.types.ts`; hooks base (`useOrg()`, `useSession()`, `useRole()`). Garante que **todo** acesso a dados do front passa pelo client RLS, não pela API `/v1`.
- **Tratamento de sessão:** refresh silencioso, logout em 401, e o fluxo de **troca de org** (re-login leve que troca o claim).

> Telas reais (dashboard, CRM, tiers, checkout, área do membro) são dos domínios `admin-app`, `member-app`, `superadmin` e os de negócio. A fundação só garante que os shells existem, são temáveis e estão plugados no client correto.

---

### 5. Integrações externas

A fundação **integra com a própria plataforma Supabase** e prepara o terreno para as demais, sem implementar nenhuma integração de negócio.

- **Supabase Postgres** — banco, RLS, extensões (`pgvector`, `pgmq`, `pg_cron`, `pgcrypto`, `pg_net`).
- **Supabase Auth** — provedor de identidade base; o **Custom Access Token Hook** que injeta `org_id`/`role`/`account_id` nos claims é configurado aqui (a lógica de papéis é de `auth-rbac`, mas o hook é infra de fundação).
- **Supabase Storage** — buckets base (logos/tema, mídias, passes) com policies por `org_id`; convenção de naming `org/<org_id>/...`.
- **Supabase Realtime** — habilitação e padrão de canais por `org_id` (status de validação ao vivo, contadores).
- **Provedor de CI/CD** (GitHub Actions ou equivalente) — pipeline que orquestra lint/test/typegen/deploy.
- **OpenAPI/Swagger toolchain** — `openapi-typescript`, gerador de SDK, Swagger UI.
- **Secret manager** — segredos do projeto (service role, certificado Apple PassKit, JWT do Google Wallet, chaves Asaas, chave LLM) vivem como secrets de Edge Function/projeto, nunca no repo. A fundação define a **convenção** e o `.env.example`.

> Asaas, Apple/Google Wallet, Discord, LLM, etc. são **consumidos** pelos domínios respectivos; a fundação só garante o padrão seguro de armazenar credenciais e o `connections` cifrado (§25.6) como tabela base.

---

### 6. Épicos & tarefas

#### Épico A — Monorepo & tooling base
- A1. Inicializar monorepo (workspaces pnpm/turbo) com `apps/{admin,member,superadmin}`, `functions/`, `packages/{sdk-js,ui,types,mcp-server}`, `supabase/`, `openapi/`. **(M)**
- A2. Configurar TS base compartilhado (`tsconfig.base.json`), paths, ESLint + Prettier, e regra de import boundaries (front não importa `service role`; `sdk-js` não importa `database.types`). **(M)**
- A3. Setup Vite + React 18 + TanStack Query + React Router como template comum dos 3 apps. **(M)**
- A4. Convenções de commit/branch + Husky/lint-staged + Conventional Commits. **(S)**
- A5. `.env.example` + documento de convenção de segredos por ambiente. **(S)**

#### Épico B — Supabase: projeto, schema base, extensões
- B1. Criar projetos Supabase **dev/staging/prod** separados; linkar CLI; documentar refs. **(M)**
- B2. Migration inicial: extensões (`pgcrypto`, `pgvector`, `pgmq`, `pg_cron`, `pg_net`), funções utilitárias (`set_updated_at`, `gen_random_uuid` default). **(S)**
- B3. Migration: `accounts`, `organizations`, `org_users` (estrutura mínima) + índices + constraints. **(M)**
- B4. Migration: `platform_billing_settings` (singleton + seed 7,99% / 3,49% / 12×) e `audit_logs` (append-only, particionável). **(M)**
- B5. Migration: `idempotency_keys` e `connections` (base cifrada). **(S)**
- B6. Buckets de Storage (tema/mídia/passes) + policies por `org_id`. **(M)**

#### Épico C — RLS multi-tenant
- C1. Funções `auth.org_id()`, `auth.user_role()`, `auth.has_org_access()`. **(S)**
- C2. Helper/macro `apply_org_rls()` que gera as 4 policies padrão. **(M)**
- C3. Aplicar RLS (`ENABLE`+`FORCE`+policies) em `organizations`/`org_users` e definir policies das tabelas globais. **(M)**
- C4. **Custom Access Token Hook** de Auth injetando `org_id`/`account_id`/`role`; fluxo de troca de org re-emitindo JWT. **(L)**
- C5. **Suíte de testes de RLS** (pgTAP ou testes via 2 sessions): provar que org A não lê/escreve dados de org B; provar que service role bypassa e que Edge filtra; provar rota pública mínima. **(L)**
- C6. Lint estrutural no CI: falhar se existir tabela com `org_id` sem RLS forçada. **(M)**

#### Épico D — Padrões de Edge Functions (`_shared`)
- D1. Factory de client (`supabase.ts`): user-scoped (anon+JWT) vs service. **(S)**
- D2. `auth.ts`: resolver API key/OAuth/JWT → `{ orgId, role, actor }`. **(L)**
- D3. `errors.ts` + `response.ts`: `AppError`, códigos canônicos, envelope, cursor pagination. **(M)**
- D4. `validation.ts`: wrapper de schema + mapeamento de erro por campo. **(M)**
- D5. `idempotency.ts`: middleware completo (replay/conflict/hash). **(L)**
- D6. `ratelimit.ts`: token-bucket por credencial/IP. **(M)**
- D7. `logger.ts`: log estruturado + `request_id` + redaction de PII/segredos. **(M)**
- D8. `v1-router` esqueleto + `/v1/health`, `/v1/docs`, `/v1/openapi.json`. **(M)**
- D9. CORS + headers de segurança padrão. **(S)**

#### Épico E — Geração de tipos & contrato
- E1. Pipeline `supabase gen types` → `packages/types/database.types.ts` + check de drift no CI. **(M)**
- E2. `openapi.yaml` 3.1 inicial (info, servers, security schemes, error envelope, paginação, `/health`). **(M)**
- E3. `openapi-typescript` → `packages/types/api.types.ts`. **(S)**
- E4. Gerador de `packages/sdk-js` a partir do OpenAPI (cliente tipado + auth). **(L)**
- E5. Gerador de `packages/mcp-server` (cada operação → tool MCP, mesmo escopo de auth). **(L)**
- E6. Mapeadores `Row → DTO` de referência em `_shared` (exemplo canônico). **(M)**

#### Épico F — Infra de filas/jobs
- F1. Biblioteca `pgmq` (criar fila, enqueue, consume, DLQ, retry/backoff). **(M)**
- F2. Padrão de worker (Edge Function consumindo via `pg_cron`). **(M)**
- F3. Jobs base: `idempotency-gc`, `dlq-monitor`, `audit-retention`, `health-canary`. **(M)**

#### Épico G — CI/CD & ambientes
- G1. Pipeline CI: install → lint → typecheck → typegen drift check → testes RLS → migration dry-run → build apps. **(L)**
- G2. CD: deploy automático de migrations + functions em **staging** no merge; **prod** com aprovação manual/tag. **(L)**
- G3. Geração e publicação de Swagger UI / SDK / MCP no CI. **(M)**
- G4. Seeds reprodutíveis (`supabase/seed`) p/ dev/staging (org demo, billing settings). **(M)**
- G5. Status page / health canary + alertas básicos. **(M)**

#### Épico H — Convenções & documentação de engenharia
- H1. `CONTRIBUTING.md`: naming (`snake_case` DB/API, `camelCase` TS), versionamento `/v1` e SemVer dos packages, padrão de migration (expand/contract). **(S)**
- H2. ADRs (Architecture Decision Records) para decisões já tomadas (Asaas, Member ID, 1 membership/org, dois caminhos de dados). **(S)**
- H3. Template de Edge Function + template de migration. **(S)**

**Esforço agregado do domínio: XL.**

---

### 7. Dependências

A fundação é a **raiz** — quase ninguém vem antes dela. Mas tem acoplamentos:

- **`auth-rbac`** — *relação bidirecional.* A fundação cria a estrutura mínima de `org_users` e o Custom Access Token Hook; `auth-rbac` define os papéis/permissões reais que populam o claim. A fundação precisa de **pelo menos** o conceito de "qual org está ativa e qual o role" para o RLS/claim funcionarem — por isso as duas frentes andam quase juntas, mas o **esqueleto** nasce aqui.
- **`design-system`** — os shells de front consomem tokens/ThemeProvider de `design-system`; pode-se entregar a fundação com tokens placeholder e plugar depois.
- **Nenhuma outra dependência de entrada.** Todos os demais domínios (`member-identity`, `crm`, `tiers-perks`, `payments-billing`, `passport`, `public-api`, `webhooks`, `mcp`, `ai-layer`, etc.) **dependem da fundação** (migrations, RLS, padrões de Edge Function, geração de tipos, CI). Ela é pré-requisito universal.

> Em termos práticos de cronograma: **fundação + auth-rbac** formam o bloco 0 que destrava todo o resto.

---

### 8. Riscos & decisões técnicas

**Decisões técnicas tomadas**
1. **Dois caminhos de dados** (app interno via `supabase-js`+RLS; público via Edge `/v1`) — do doc §6.2. Imutável.
2. **`org_id` nos claims do JWT** via Custom Access Token Hook; troca de org re-emite token.
3. **RLS com `FORCE`** em toda tabela de domínio; Edge Functions com service role **sempre filtram `org_id` explicitamente** (cinto e suspensório).
4. **OpenAPI como fonte única** do contrato público → SDK/MCP/tipos gerados; **schema do banco ≠ DTO público**.
5. **Roll-forward** de migrations (expand/contract), sem down em prod.
6. **`v1-router` monolítica** + `_shared` no início; extrair functions pesadas sob demanda.

**Riscos & edge cases**
- **Vazamento cross-org** — o risco existencial. Mitigação: testes de RLS obrigatórios no CI (C5), filtro explícito de `org_id` em toda Edge query, code review focado, e o lint estrutural (C6). *Edge case:* uma `VIEW`/`SECURITY DEFINER function` mal escrita pode bypassar RLS — auditar toda função `SECURITY DEFINER`.
- **Service role exposta** — se vazar, ignora RLS por completo. Mitigação: só em secrets de Edge, nunca no front/repo, rotação documentada.
- **Drift de tipos** — alguém altera schema/OpenAPI e esquece de regenerar → bugs sutis. Mitigação: check de drift que **falha o build** (E1).
- **Claim de org desatualizado** — usuário trocou de org mas o JWT antigo ainda tem `org_id` velho até expirar → pode ver/agir na org errada por segundos. Mitigação: re-emitir token na troca e usar TTL curto de access token.
- **Migration backward-incompatible** — deploy de código novo + schema novo em ordem errada derruba prod. Mitigação: padrão expand/contract obrigatório, CI roda migration contra cópia do schema de prod.
- **Cold start de Edge Functions** na rota pública de validação (latência na portaria). Mitigação: function dedicada e leve para `verify`, cache de leitura, considerar manter quente.
- **`pgmq`/`pg_cron` em projeto gerenciado** — limites de concorrência e visibilidade da DLQ. Mitigação: `dlq-monitor` + alertas; desenhar jobs idempotentes (podem reexecutar).
- **Singleton `platform_billing_settings`** — risco de múltiplas linhas ou edição acidental. Mitigação: CHECK `id=1`, escrita só por superadmin/service.
- **Storage cross-org** — bucket compartilhado com path por org exige policy correta; URL adivinhável vaza mídia. Mitigação: signed URLs + policy por `org_id` no path.
- **Rota pública sem token e enumeração de IDs** — embora o ID seja não-sequencial e o segredo seja o token (§9.3), a leitura pública precisa de rate-limit anti-enumeração na própria Edge Function.
- **Idempotência com payload divergente** — mesma key, body diferente: tem que ser `422`, não replay silencioso (senão mascara bug do cliente).

---

### 9. Escopo MVP vs. depois

**No MVP (necessário para a Fase 0/§29 e destravar Fase 1):**
- Monorepo com os apps/packages/pastas (Épico A).
- Projetos Supabase dev/staging/prod + extensões + schema base (`accounts`/`organizations`/`org_users`/`platform_billing_settings`/`audit_logs`/`idempotency_keys`) (Épico B).
- RLS multi-tenant: helpers, política base, Custom Access Token Hook, **suíte de testes de RLS** (Épico C — completo; é o item mais crítico do MVP).
- `_shared` de Edge Functions: client factory, auth resolver, errors/envelope, validação, logging, idempotência, rate-limit; `v1-router` + `/health` + `/docs` + `/openapi.json` (Épico D).
- Geração DB→TS com check de drift; `openapi.yaml` inicial + tipos da API (E1–E3). Mapeador Row→DTO de referência (E6).
- CI/CD com lint/typecheck/RLS tests/migration dry-run + deploy staging automático e prod manual (G1–G2); seeds (G4).
- Convenções documentadas + ADRs (Épico H).

**Depois do MVP:**
- Geração completa de `sdk-js` (E4) e `mcp-server` (E5) — só fazem sentido quando a API pública tiver superfície real (Fase 4 do doc). No MVP basta o **contrato e Swagger UI**.
- Infra de filas robusta com DLQ/retry e jobs de plataforma além do mínimo (Épico F além do health canary) — entra quando campanhas/push de passes/sync existirem (Fase 2).
- Status page completa, particionamento/retention avançado de `audit_logs`, observabilidade plena (parte vai para `observability-qa`).
- Extração de Edge Functions monolíticas em dedicadas (otimização sob demanda).
- Camada PSP-agnóstica formalizada (pertence a `payments-billing`; a fundação só não pode impedir).
