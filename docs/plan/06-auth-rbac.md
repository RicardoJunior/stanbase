## 06. Auth, Contas, Orgs & RBAC

> Domínio de identidade do **operador** (não do membro): autenticação de usuários da plataforma, a hierarquia **Conta → N Orgs (bases)**, controle de acesso baseado em papéis (RBAC) com permissões granulares por módulo, convites de equipe, seletor/troca de contexto de org, e as políticas de **RLS** que garantem isolamento total entre orgs.
>
> Este domínio é a **espinha dorsal de segurança** da plataforma. Tudo o que qualquer outro domínio faz no banco passa por uma checagem de `org_id` + papel que nasce aqui. Erro aqui = vazamento entre tenants.
>
> **Escopo deste documento:** o lado *operador/staff* (Conta, Org, Owner/Admin/Operator). A identidade do **membro/fã** (Member ID, login social do membro no front temável, passport) é tratada no domínio `member-identity`. Há sobreposição deliberada de Supabase Auth — esclarecida em §1.9 ("a mesma pessoa pode ser membro de uma org e staff de outra").

---

### 1. Como funciona

#### 1.1 Conceitos e fronteiras

- **`auth.users`** (Supabase Auth) — uma linha global por **pessoa física autenticável** (e-mail único). Owner, admin, operator e membro são **todos** `auth.users`. O papel não vive aqui; vive no vínculo com a org.
- **Account (Conta)** — a "conta do dono/operador". Possui **N orgs (bases)**. Tem exatamente **um `owner_user_id`** (o dono da conta). É a unidade de **billing da plataforma** (não confundir com o financeiro de cada org). Criada no primeiro signup de um operador.
- **Organization (Org / base / tenant)** — a unidade de **isolamento de dados** e de **1 membership**. Pertence a uma Account (`account_id`). Toda tabela de domínio carrega `org_id`.
- **`org_users`** — o **vínculo N:N** entre `auth.users` e `organizations`, carregando `role` (owner/admin/operator) e `permissions` (jsonb granular). Uma pessoa pode ter vínculos em várias orgs, com papéis diferentes em cada.
- **`account_users`** — vínculo entre `auth.users` e `accounts`. Quem administra a Conta inteira (billing, criar/arquivar orgs). No MVP normalmente só o owner da conta; modelado para crescer.

> **Distinção crítica owner-de-conta vs owner-de-org.** O `owner` em `org_users` é o papel máximo *dentro de uma org*. O `owner_user_id` em `accounts` é quem controla a *conta* (cria orgs, vê billing consolidado). No fluxo padrão (1 pessoa, 1 conta, N orgs) é a mesma pessoa. Mas modelamos separado porque **transferência de posse de uma org** e **transferência de posse da conta** são operações distintas (§1.7).

#### 1.2 Métodos de autenticação (operador)

Supabase Auth com:

1. **E-mail OTP (magic code de 6 dígitos)** — método primário recomendado para operadores. Sem senha. Fluxo: digita e-mail → recebe código → valida → sessão.
2. **OAuth Google** — `signInWithOAuth({ provider: 'google' })`.
3. **OAuth Apple** — exige Sign in with Apple (relay de e-mail privado tratado em §8.1).
4. **OAuth X (Twitter)** — habilitado; usado mais como verificação de fã no front do membro, mas disponível também no operador.
5. **(Opcional, fora do MVP) e-mail + senha** — só se algum operador exigir; OTP cobre o caso.

> **Decisão de produto a confirmar (ver §8):** se o admin permite **somente OTP + OAuth** (sem senha) — recomendação: sim, simplifica e é mais seguro.

#### 1.3 Máquina de estados — usuário operador

```
                    ┌──────────────┐
   signup/invite ─► │  INVITED      │  (existe convite pendente, sem auth.user ainda OU
                    │  / PENDING    │   auth.user existe mas vínculo org pendente)
                    └──────┬───────┘
                           │ aceita convite + autentica (OTP/OAuth)
                           ▼
                    ┌──────────────┐
                    │  ACTIVE       │  vínculo org_users.status = active
                    └──────┬───────┘
              suspend │     │ revoke / remove
                      ▼     ▼
              ┌───────────┐ ┌───────────┐
              │ SUSPENDED │ │  REVOKED  │ (vínculo deletado/inativado;
              └─────┬─────┘ └───────────┘  auth.user permanece p/ outras orgs)
                    │ reactivate
                    └──► ACTIVE
```

Estados do **vínculo** (`org_users.status`): `pending` (convite enviado, ainda não aceito) → `active` → `suspended` (acesso temporariamente bloqueado, claims não emitem) → `revoked` (removido).

Estados da **org** (`organizations.status`): `active` → `suspended` (pela Stanbase, ex.: inadimplência de billing) → `archived` (soft delete pelo owner). Org `suspended`/`archived` = ninguém entra exceto super-admin.

#### 1.4 Fluxo: signup de novo operador + criação da primeira org

1. Pessoa acessa `app.stanbase.com` → escolhe "Criar conta".
2. Autentica via OTP ou OAuth → cria/recupera `auth.users`.
3. Edge Function `auth-bootstrap` roda no primeiro login (idempotente): verifica se a pessoa já tem `account_users`. Se **não**:
   - Cria `accounts` (`owner_user_id` = user).
   - Cria `account_users` (role `owner`).
   - **Não** cria org automaticamente — leva ao wizard de criação de org.
4. Wizard de org (onboarding "monte seu membership em um dia"): nome da base, slug (`org.stanbase.com`), vertical/template, marca básica (logo/cor).
5. Edge Function `org-create`: cria `organizations` (status `active`) + `org_users` (este user, role `owner`, todas as permissões) + dispara seed inicial (tiers de exemplo do template do vertical, opcional).
6. Claims do JWT recalculados → sessão agora tem essa org como contexto ativo.

#### 1.5 Fluxo: login com múltiplas orgs e seletor de contexto

1. Login (OTP/OAuth) → sessão Supabase emitida.
2. Front consulta `GET /v1/me` → retorna usuário + **lista de orgs** acessíveis (de `org_users` active) com papel e permissões resumidas em cada + a `account` dona.
3. **Seleção de org ativa:**
   - Se 1 org → entra direto.
   - Se N orgs → mostra **seletor de org** (tela ou dropdown no topo). Última org usada persistida em `user_preferences.last_org_id` e em cookie/localStorage.
   - Se 0 orgs (pessoa só foi convidada mas todas revogadas, ou conta sem org) → tela vazia/onboarding.
4. Org escolhida → front chama `POST /v1/context/switch { org_id }` → Edge Function valida vínculo ativo → **reescreve claims** (ver §1.6) → devolve novo access token com `active_org_id` e `permissions` daquela org.
5. Todas as chamadas subsequentes (Supabase JS direto com RLS **e** API /v1) carregam esse token.

> **Edge case (várias orgs):** o seletor deve mostrar marca/logo de cada org para evitar que o operador opere na org errada. **Indicador visual permanente** do contexto ativo (cor/nome no topbar) é obrigatório — operar na org errada é um dos erros mais perigosos.

#### 1.6 Claims do JWT e troca de contexto — a parte mais delicada

O Supabase Auth emite o JWT base. Precisamos enriquecê-lo com o **contexto de org** e permissões para o RLS funcionar performaticamente (sem subquery a `org_users` em toda policy).

**Estratégia (Custom Access Token Hook do Supabase Auth):**

- Hook (Postgres function `custom_access_token_hook`) injeta no JWT, **a cada emissão/refresh**, os claims:
  ```jsonc
  {
    "app_metadata": {
      "active_org_id": "uuid",          // org de contexto atual
      "active_role": "owner|admin|operator",
      "account_id": "uuid",
      "org_ids": ["uuid", "uuid"],      // todas as orgs ativas (p/ validação rápida)
      "perms": { "members": ["read","write"], "billing": ["read"], ... } // resumo da org ativa
    }
  }
  ```
- A **org ativa** é persistida em `user_preferences.active_org_id`. O hook lê dali ao montar o token. `POST /v1/context/switch` apenas atualiza `user_preferences.active_org_id` e força um **refresh do token** (re-emissão).

**Por que não colocar todas as permissões de todas as orgs no token?** Tamanho do JWT (cookie/header) e vazamento. Colocamos só o resumo da **org ativa** + lista de `org_ids`. RLS usa `active_org_id`.

**Trade-off de latência de revogação:** JWT é stateless; uma permissão revogada só some do token no próximo refresh (TTL access token = 1h recomendado, refresh rotativo). Para revogação **imediata** de casos sensíveis (operator de porta, owner removido), ver §1.8 + §8 (decisão sobre access token TTL e tabela de checagem live para ações financeiras).

> **Decisão técnica:** RLS lê `active_org_id` do claim (caminho rápido) **mas** operações sensíveis (financeiro, exclusão LGPD, gestão de equipe) revalidam **ao vivo** contra `org_users.status = active` na Edge Function antes de executar. Defesa em profundidade.

#### 1.7 Papéis e permissões granulares (RBAC)

**Três papéis-base** (de `org_users.role`), por org:

| Papel | Padrão de acesso | Pode |
|---|---|---|
| **owner** | Total na org | Tudo, incluindo gestão de equipe, billing da org, transferir posse, arquivar org. **1 owner obrigatório por org** (invariante). |
| **admin** | Granular (default: tudo menos billing sensível e transferência) | Gerir membros, tiers, conteúdo, eventos, comunicação, integrações — conforme `permissions`. |
| **operator** | **Escopo mínimo** | Por padrão **só** validação/check-in/portaria. Não vê CRM completo, financeiro, configurações. |

**Permissões granulares por módulo** (`org_users.permissions` jsonb) — sobrepõem o default do papel. Módulos espelham a navegação do admin (§10.1 do doc):

```
members, tiers_perks, revenue_billing, events_tickets, content,
community_channels, communication, hall_of_fame, ai, integrations,
validation_checkin, developers, settings, team
```

Cada módulo → conjunto de ações: `read`, `write`, `delete`, `manage` (admin do módulo), mais ações especiais por módulo (ex.: `revenue_billing.refund`, `members.export`, `members.anonymize`, `validation_checkin.scan`).

**Modelo de resolução de permissão (ordem):**
1. Se `role = owner` → `allow` tudo (curto-circuito).
2. Senão, consulta `permissions[module]` → se contém a ação → `allow`.
3. Senão → `deny`.

> **Operator de porta com escopo restrito (edge case central):** o operator default recebe `permissions = { validation_checkin: ["scan","read"] }` e **nada mais**. Adicionalmente, um operator pode ser **escopado a um evento específico** (`org_users.scope` jsonb: `{ event_ids: [...] }`) — ver §1.10. RLS e a Edge Function de check-in respeitam esse escopo.

**Permissões customizadas / "cargos" salvos:** no MVP, permissões são editadas por usuário (checkboxes). **Pós-MVP:** templates de papel (`role_templates` por org) reutilizáveis. Decisão em §8.

#### 1.8 Convites de equipe e onboarding de staff

**Fluxo de convite:**

1. Owner/admin (com `team.manage`) abre Configurações → Equipe → "Convidar".
2. Informa e-mail + papel + permissões (ou template) + escopo opcional (evento).
3. Edge Function `team-invite`:
   - Verifica se já existe `auth.user` com aquele e-mail.
   - Cria `org_invites` (token aleatório seguro, `expires_at` = 7 dias, `status = pending`, papel/permissões/escopo snapshot).
   - Cria/atualiza `org_users` com `status = pending` (se o user já existe) — ou aguarda o aceite criar.
   - Envia e-mail com link `app.stanbase.com/invite/{token}`.
4. Convidado clica:
   - **Já tem conta Stanbase** (membro de outra org, ou staff de outra) → autentica → aceita → `org_users.status = active`. **Não cria nova Account** (ele já pertence à própria conta, ou a nenhuma — ver §1.9).
   - **Não tem conta** → autentica (OTP/OAuth) cria `auth.user`. Aceitar convite **não cria Account própria** — ele é staff, não dono. Fica vinculado só via `org_users`.
5. Aceite consome o convite (`org_invites.status = accepted`, registra `accepted_user_id`).

**Edge cases do convite:**
- Convite expirado → tela "expirado, peça reenvio". `team-invite-resend`.
- E-mail do convite ≠ e-mail com que autenticou (OAuth) → **bloqueia aceite** e mostra aviso (anti-sequestro de convite). Decisão em §8 (recomendação: travar por padrão, permitir override pelo admin).
- Reenvio de convite a quem já é membro ativo → no-op com aviso.
- Convidar e-mail que já tem vínculo ativo nessa org → erro "já faz parte da equipe".
- Revogar convite pendente → `org_invites.status = revoked`, link morto.

#### 1.9 Pessoa que é **membro de uma org** e **staff de outra** (edge case central)

Uma pessoa (ex.: `ana@email.com`) pode ser:
- **Membro** (fã) da Org A → tem `members` row em A, login no front temável de A.
- **Operator/staff** da Org B → tem `org_users` row em B.

**Modelagem:** ambos apontam para o **mesmo `auth.users.id`** (e-mail único global no Supabase Auth). O que difere é o **tipo de vínculo**:
- `members.user_id` → identidade de membro.
- `org_users.user_id` → identidade de staff.

**Regras:**
- Não há conflito: o app de **membro** (`member.stanbase.com` / domínio da org) e o app de **admin** (`app.stanbase.com`) são front-ends distintos. O JWT é o mesmo `auth.user`, mas o **contexto** (claims) é resolvido pelo app que está sendo usado.
- `GET /v1/me` distingue: retorna `member_of: [orgs onde é membro]` e `staff_of: [orgs onde tem org_users]`.
- **Risco:** a mesma pessoa não deve, por engano, ver dados de staff dentro do app de membro nem vice-versa. RLS separa por tabela; o front separa por aplicação. **Nunca** mesclar contextos no mesmo token.
- Uma pessoa pode até ser **staff e membro da MESMA org** (ex.: o owner também quer ser membro do próprio clube). Permitido: `org_users` row + `members` row coexistem para o mesmo `user_id` + `org_id`. São direitos ortogonais.

#### 1.10 Operator de porta — escopo restrito (detalhe)

- Recebe **só** validação/check-in. Acesso a um app/rota enxuta (não o admin completo).
- Pode ser **escopado a evento(s)** via `org_users.scope = { event_ids: [...] }`. Sem escopo = todos os eventos da org.
- **Sessão de operador pode ser curta e/ou device-bound** para portaria (turno termina = acesso some). Decisão em §8: TTL curto + possibilidade de "encerrar todas as sessões de operadores" pós-evento.
- Operator **não** vê PII além do necessário no scan (alinhado com §9.2 do doc: staff autenticado vê o necessário p/ check-in). Operator nunca exporta base, nunca vê financeiro.
- **Revogação imediata** de operator pós-evento é requisito (ver §1.11).

#### 1.11 Revogação de acesso (edge case central)

**Cenários e comportamento:**

1. **Remover staff de uma org** → `org_users.status = revoked` (mantém histórico/audit) ou delete. Próximo refresh de token → claims sem essa org. Para **imediato**: Edge Function `team-revoke` também chama `auth.admin.signOut(user, scope)` revogando refresh tokens **se** o user não tiver outras orgs ativas; se tiver, só invalida o contexto daquela org e força re-switch.
2. **Suspender (temporário)** → `status = suspended`; claims não emitem para essa org até reativar.
3. **Owner removido / saiu** → **proibido** se for o único owner. Deve **transferir posse antes** (§1.7). Invariante de banco: trigger impede deletar/rebaixar o último owner ativo de uma org.
4. **Revogar todos os operadores pós-evento** → ação em massa `team-revoke-operators?event_id=` que suspende/revoga operators escopados ao evento.
5. **Conta/Org inadimplente (billing da plataforma)** → super-admin suspende org → todos os vínculos param de emitir claims; banner de "org suspensa".
6. **Pessoa pede exclusão LGPD do `auth.user`** sendo staff de orgs → bloquear até desvincular de orgs onde é owner (transferir) ; anonimização preserva audit logs financeiros (ver domínio `security-lgpd`).

**Garantia de tempo real:** revogação de **operator/portaria** e de **acesso a financeiro** não pode esperar 1h de TTL. Por isso ações dessas Edge Functions revalidam vínculo ao vivo (§1.6). Para o resto, o TTL curto + refresh rotativo é aceitável.

#### 1.12 Transferência de posse de org (edge case central)

1. Owner atual (Configurações → Equipe → "Transferir posse") escolhe um **admin existente e ativo** da org (não pode transferir para fora da equipe).
2. Edge Function `org-transfer-ownership`:
   - Exige **reautenticação** (step-up: novo OTP) do owner atual.
   - Em transação: novo user vira `role = owner`; owner antigo vira `role = admin` (ou sai, opção dele) — **mantendo sempre ≥1 owner**.
   - Audita.
   - Opcional: aceite do destinatário (two-step) — decisão em §8 (recomendação: aceite obrigatório para evitar transferência surpresa).
3. **Atenção:** transferir posse da **org** ≠ transferir a **org de Conta**. Mover uma org para outra Account (ex.: vender uma base) é operação separada (`org-move-account`, pós-MVP) e mexe em billing.

#### 1.13 Sessão / JWT

- **Access token TTL:** 1h (recomendado). **Refresh token:** rotativo, revogável.
- **Reuso de refresh detectado** → Supabase revoga a família (proteção contra roubo de token).
- **Step-up auth** (reautenticação OTP) exigido para: transferência de posse, exclusão de org, mudança de método de pagamento da org, exclusão/anonimização LGPD em massa, geração de API key com escopo financeiro.
- **Logout em todos os dispositivos** disponível ao próprio user e ao owner para qualquer staff.

---

### 2. Modelo de dados

> Todas as tabelas de domínio carregam `org_id` (exceto `accounts`, `account_users`, `auth.users`, `user_preferences`, e tabelas de plataforma). RLS em todas.

#### 2.1 Tabelas novas / tocadas

**`accounts`** (existe no doc §25.1 — detalhada aqui)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `name` | text | nome da conta |
| `owner_user_id` | uuid FK→auth.users | dono da conta |
| `billing_ref` | text | ref do billing da plataforma (futuro) |
| `status` | text | `active`/`suspended` |
| `created_at` | timestamptz | |

**`account_users`** (nova)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `account_id` | uuid FK→accounts | |
| `user_id` | uuid FK→auth.users | |
| `role` | text | `owner`/`manager` (account-level) |
| `created_at` | timestamptz | |
| | | UNIQUE(`account_id`,`user_id`) |

**`organizations`** (existe §25.1 — colunas relevantes a este domínio)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `account_id` | uuid FK→accounts | NOT NULL |
| `slug` | text | UNIQUE global; subdomínio `slug.stanbase.com` |
| `name`, `brand`(jsonb), `domain` | | marca/tema |
| `status` | text | `active`/`suspended`/`archived` |
| `created_at` | timestamptz | |

**`org_users`** (existe §25.1 — expandida)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK→organizations | |
| `user_id` | uuid FK→auth.users | |
| `role` | text | enum `owner`/`admin`/`operator` |
| `permissions` | jsonb | `{ module: [actions] }`; ignorado se role=owner |
| `scope` | jsonb | ex.: `{ event_ids: [...] }` p/ operator |
| `status` | text | `pending`/`active`/`suspended`/`revoked` |
| `invited_by` | uuid FK→auth.users | |
| `created_at`, `updated_at` | timestamptz | |
| | | **UNIQUE(`org_id`,`user_id`)** |
| | | INDEX(`user_id`) p/ "minhas orgs"; INDEX(`org_id`,`status`) |

**`org_invites`** (nova)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK→organizations | |
| `email` | citext | normalizado lowercase |
| `role` | text | snapshot |
| `permissions` | jsonb | snapshot |
| `scope` | jsonb | snapshot |
| `token_hash` | text | hash do token (nunca o token cru) |
| `status` | text | `pending`/`accepted`/`revoked`/`expired` |
| `invited_by` | uuid FK→auth.users | |
| `accepted_user_id` | uuid FK→auth.users | null até aceite |
| `expires_at` | timestamptz | default now()+7d |
| `created_at` | timestamptz | |
| | | INDEX(`org_id`,`status`); INDEX(`email`); UNIQUE parcial(`org_id`,`email`) WHERE status='pending' |

**`user_preferences`** (nova)
| Coluna | Tipo | Notas |
|---|---|---|
| `user_id` | uuid PK FK→auth.users | |
| `active_org_id` | uuid FK→organizations | org de contexto p/ o claim hook |
| `last_org_id` | uuid | UX do seletor |
| `locale` | text | `pt-BR`/`en-US`/`es` |
| `updated_at` | timestamptz | |

**`role_templates`** (nova — pós-MVP)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK | |
| `name` | text | ex.: "Gestor de conteúdo" |
| `permissions` | jsonb | |

**`audit_logs`** (existe §25.6 — este domínio é grande produtor)
- `org_id` (nullable p/ ações de conta), `actor` (user_id), `action` (`team.invited`, `team.role_changed`, `org.ownership_transferred`, `auth.context_switched`, `team.revoked`...), `target`, `payload` jsonb, `at`, `ip`.

#### 2.2 Constraints / invariantes (triggers)

- **`org_users`**: trigger `BEFORE DELETE/UPDATE` impede remover/rebaixar o **último owner ativo** de uma org (`raise exception`).
- **`organizations`**: trigger garante que ao criar org, exista ≥1 `org_users` owner (criado na mesma transação por `org-create`).
- **`org_invites`**: job (pg_cron) marca `expired` os pendentes vencidos diariamente.
- **`accounts`**: 1 `owner_user_id` obrigatório.
- `role` validado por CHECK/enum; `status` por CHECK/enum.

#### 2.3 RLS — políticas-chave

Funções auxiliares (em `auth` schema, `SECURITY DEFINER`):
- `auth.active_org_id()` → lê claim `app_metadata.active_org_id`.
- `auth.has_perm(module text, action text)` → owner=true; senão consulta claim `perms`.
- `auth.is_org_member(org uuid)` → org ∈ claim `org_ids`.

Padrão de política em tabela de domínio `X`:
```sql
-- SELECT
USING ( org_id = auth.active_org_id() AND auth.has_perm('<module>','read') )
-- INSERT/UPDATE/DELETE
WITH CHECK ( org_id = auth.active_org_id() AND auth.has_perm('<module>','write') )
```
- `org_users`: SELECT permitido a quem é staff da org (`auth.is_org_member(org_id)` + `team.read`); escrita só com `team.manage`.
- `accounts`/`account_users`: visível ao owner/manager da conta.
- Super-admin (Stanbase Staff): bypass via role de serviço / policy dedicada — tratado no domínio `superadmin`.

> **Defesa em profundidade:** mesmo com claim, operações financeiras/LGPD revalidam `org_users.status='active'` ao vivo na Edge Function (não confiam só no JWT).

---

### 3. API & Edge Functions

**Endpoints REST `/v1`** (alinhados ao §21 do doc; este domínio adiciona auth/contexto/equipe):

```
GET    /v1/me                          # usuário + orgs (staff_of), contas, perms da org ativa, member_of
POST   /v1/auth/otp/start              # inicia OTP (e-mail) — wrapper p/ rate limit/auditoria
POST   /v1/auth/otp/verify             # valida código → sessão
GET    /v1/auth/oauth/{provider}/url   # url de início OAuth (google/apple/x)
POST   /v1/context/switch              # troca org ativa → re-emite token com novos claims
GET    /v1/accounts/{id}               # detalhe da conta (owner/manager)
GET    /v1/accounts/{id}/orgs          # orgs da conta
POST   /v1/orgs                        # cria org (wizard) → cria owner org_users
GET    /v1/orgs/{id}                   # detalhe org (settings)
PATCH  /v1/orgs/{id}                   # marca/tema/domínio/status
POST   /v1/orgs/{id}/archive           # arquiva (soft delete) — step-up auth
POST   /v1/orgs/{id}/transfer-ownership# transfere posse — step-up + aceite
GET    /v1/orgs/{id}/team              # lista staff (org_users)
POST   /v1/orgs/{id}/team/invite       # cria convite + envia e-mail
POST   /v1/orgs/{id}/team/invite/{iid}/resend
POST   /v1/orgs/{id}/team/invite/{iid}/revoke
PATCH  /v1/orgs/{id}/team/{userId}     # muda papel/permissões/escopo
POST   /v1/orgs/{id}/team/{userId}/suspend
POST   /v1/orgs/{id}/team/{userId}/reactivate
DELETE /v1/orgs/{id}/team/{userId}     # revoga acesso
POST   /v1/orgs/{id}/team/revoke-operators  # ?event_id= — revoga operadores em massa
GET    /v1/invites/{token}             # detalhes do convite (público, sem auth — só nome org/papel)
POST   /v1/invites/{token}/accept      # aceita convite (autenticado)
```

**Edge Functions / Jobs:**

| Function/Job | Tipo | Descrição |
|---|---|---|
| `custom_access_token_hook` | Auth hook (SQL/Edge) | injeta claims (active_org_id, role, perms, org_ids) no JWT a cada emissão/refresh |
| `auth-bootstrap` | Edge (on first login) | cria Account + account_users + user_preferences idempotentemente |
| `org-create` | Edge | cria org + owner org_users + seed template (transação) |
| `context-switch` | Edge | valida vínculo, atualiza `user_preferences.active_org_id`, força refresh |
| `team-invite` / `-resend` / `-revoke` | Edge | gestão de convites + envio de e-mail |
| `invite-accept` | Edge | valida token/e-mail, cria/ativa org_users, consome convite |
| `team-revoke` | Edge | revoga vínculo + signOut condicional (refresh token) |
| `org-transfer-ownership` | Edge | step-up auth, troca papéis em transação, mantém invariante owner |
| `expire-invites` | Cron (pg_cron) | marca convites vencidos como `expired` (diário) |
| `cleanup-operator-sessions` | Cron/Edge | revoga sessões de operadores escopados a eventos passados |

---

### 4. Telas / Front

**App admin (`app.stanbase.com` — `apps/admin`):**

- **Tela de login** — botões OAuth (Google/Apple/X) + campo de e-mail OTP. Estados: enviar código → inserir 6 dígitos → erro/reenvio (cooldown).
- **Seletor de org** (pós-login, se N orgs) — grid de cards com logo/cor/nome de cada org + papel; busca; "Criar nova base". Acessível também via dropdown no **topbar** (troca rápida de contexto, com `POST /context/switch`).
- **Indicador de contexto no topbar** — logo + nome + cor da org ativa, sempre visível (evita operar na org errada). Badge do papel.
- **Wizard de criação de org** — passos: nome/slug → vertical/template → marca básica → pronto.
- **Configurações → Equipe** — tabela de staff (nome, e-mail, papel, status, último acesso, escopo); ações: convidar, editar papel/permissões (matriz de checkboxes por módulo×ação), suspender, reativar, revogar, transferir posse, revogar operadores em massa. Lista de convites pendentes (reenviar/revogar).
- **Editor de permissões** — matriz módulo × ações com presets por papel; aviso ao reduzir owner; bloqueio do "último owner".
- **Tela de transferência de posse** — seleção de admin destino, reautenticação OTP, confirmação.
- **Tela de aceite de convite** (`/invite/{token}`) — mostra org/papel; botão "Entrar com Google/Apple/X" ou OTP; trata expirado/e-mail divergente.
- **Banner de org suspensa/arquivada** — bloqueia operação.

**Componentes-chave:** `<OrgSwitcher/>`, `<ContextBadge/>`, `<PermissionMatrix/>`, `<TeamTable/>`, `<InviteDialog/>`, `<StepUpAuthModal/>`, `<OtpInput/>`, `<OAuthButtons/>`.

**App operador/portaria** (subset, possivelmente dentro do `member`/dedicado): login OTP/OAuth → entra direto na rota de validação/check-in (sem seletor completo se só tem escopo operator); UI mínima.

---

### 5. Integrações externas

| Serviço | Como integra |
|---|---|
| **Supabase Auth** | Provedor de identidade central: OTP por e-mail, OAuth Google/Apple/X, JWT, refresh rotativo, Custom Access Token Hook, `auth.admin` (signOut, gestão de sessão). |
| **Google OAuth** | Console Google Cloud: OAuth client (web). Escopo básico (email, profile). |
| **Apple Sign in** | Apple Developer: Service ID, key. Tratar **relay de e-mail privado** (`@privaterelay.appleid.com`) e o fato de Apple só enviar nome no primeiro consentimento. |
| **X (Twitter) OAuth** | App no X Developer Portal (OAuth 2.0). |
| **Provedor de e-mail transacional** | Envio de OTP e convites (SMTP do Supabase ou provedor dedicado — Resend/Postmark, a confirmar no domínio `communication`). Deliverability é crítica (OTP/convite que não chega = bloqueio). |
| **KMS / Secret Manager** | Cifrar segredos OAuth e tokens; nunca no front. |

---

### 6. Épicos & tarefas

#### Épico A — Fundação de identidade & multi-tenant (base de tudo)
- A1. Configurar Supabase Auth: OTP e-mail + OAuth Google/Apple/X (apps/keys nos provedores) — **M**
- A2. Schema: `accounts`, `account_users`, `org_users` (expandir), `org_invites`, `user_preferences`, `role_templates` (estrutura) — **M**
- A3. Triggers/invariantes: último owner, criação de org com owner, enums status/role — **M**
- A4. Funções `auth.active_org_id()`, `auth.has_perm()`, `auth.is_org_member()` — **S**
- A5. Custom Access Token Hook injetando claims (active_org_id, role, perms, org_ids) — **L** (delicado, testar bem)
- A6. Políticas RLS padrão por org + helper macros aplicadas às tabelas núcleo — **L**
- A7. Testes de RLS multi-tenant (isolamento: org A não lê org B; operator não lê CRM) — **L**

#### Épico B — Conta, orgs e contexto
- B1. `auth-bootstrap` (primeiro login → Account) idempotente — **M**
- B2. `org-create` + wizard (front) + seed de template por vertical — **L**
- B3. `GET /v1/me` (orgs, contas, perms, member_of/staff_of) — **M**
- B4. `context-switch` (Edge) + re-emissão de token + `user_preferences.active_org_id` — **M**
- B5. `<OrgSwitcher/>` + `<ContextBadge/>` + persistência de última org — **M**
- B6. Indicador de contexto permanente + guarda anti-org-errada — **S**

#### Épico C — RBAC & permissões granulares
- C1. Modelo de permissões (módulos×ações) + resolução owner/admin/operator — **M**
- C2. `<PermissionMatrix/>` editor + presets por papel — **M**
- C3. Enforcement de permissão na API /v1 (middleware) + revalidação live em ações sensíveis — **M**
- C4. Escopo de operator por evento (`scope`) + enforcement em check-in — **M**
- C5. (pós-MVP) `role_templates` reutilizáveis — **M**

#### Épico D — Convites & onboarding de staff
- D1. `team-invite`/`-resend`/`-revoke` + e-mail de convite — **M**
- D2. `invite-accept` (valida token/e-mail, ativa vínculo, sem criar Account) — **M**
- D3. Telas: Equipe, InviteDialog, aceite `/invite/{token}` (expirado/e-mail divergente) — **L**
- D4. `expire-invites` cron — **S**

#### Épico E — Revogação, suspensão, transferência
- E1. `team-revoke`/suspend/reactivate + signOut condicional — **M**
- E2. `org-transfer-ownership` (step-up + aceite + invariante owner) — **L**
- E3. `revoke-operators` em massa por evento + `cleanup-operator-sessions` cron — **M**
- E4. Step-up auth modal (reautenticação OTP) reutilizável — **M**
- E5. Suspensão de org por billing (gancho p/ superadmin) + banners — **S**

#### Épico F — Auditoria & segurança
- F1. `audit_logs` para todas as ações deste domínio (invite, role change, transfer, revoke, switch) — **M**
- F2. Rate limiting em OTP/login/invite-accept + anti-enumeração — **M**
- F3. Tratamento de e-mail relay Apple + merge de identidades por e-mail — **M**

---

### 7. Dependências

| Depende de | Por quê |
|---|---|
| **fundacao** | Monorepo, projetos Supabase, migrations/CI de RLS, esqueleto da API /v1 e do design system. Este domínio é o **segundo a sair** (logo após fundação) porque tudo depende de auth+RLS. |
| **design-system** | Telas de login/equipe/seletor usam tokens e componentes base. |

**É dependência de (quem precisa deste domínio):** praticamente **todos** — `member-identity`, `crm`, `tiers-perks`, `payments-billing`, `events-tickets`, `verification-checkin`, `content-gating`, `community-channels`, `communication`, `admin-app`, `public-api`, `mcp`, `security-lgpd`, `superadmin`. Sem `org_id` + claims + RLS daqui, nenhum outro pode persistir dados isolados com segurança.

**Acoplamentos a esclarecer:**
- `member-identity` compartilha `auth.users` mas com vínculo `members` (não `org_users`). Precisa alinhar quem cria `auth.user` em cada fluxo (§1.9).
- `public-api`/`mcp` reusam o mesmo modelo de escopo de org e permissões para API keys/OAuth client-credentials.
- `payments-billing` consome `accounts` (billing da plataforma) e a invariante de owner.
- `superadmin` define o bypass de RLS e a suspensão de orgs.

---

### 8. Riscos & decisões técnicas

**Riscos:**
1. **Vazamento entre tenants via RLS mal feita** — risco máximo. Mitigação: testes automatizados de isolamento no CI (Épico A7), policies geradas por macro padronizada, revisão obrigatória.
2. **Claim desatualizado vs revogação** — JWT stateless: permissão revogada persiste até refresh. Mitigação: TTL curto (1h) + revalidação live em ações sensíveis + signOut condicional. **Risco residual aceito** para ações não sensíveis.
3. **Operar na org errada** (várias orgs) — erro humano caro. Mitigação: indicador de contexto permanente, confirmação em ações destrutivas, cor por org.
4. **Custom Access Token Hook é ponto único de falha** — se o hook erra, ninguém loga ou claims ficam errados. Mitigação: hook simples, idempotente, com fallback seguro (sem org ativa → acesso mínimo, não acesso total) e testes.
5. **Apple relay e identidades duplicadas** — mesma pessoa logando ora com Google (e-mail real) ora com Apple (relay) cria dois `auth.users`. Mitigação: e-mail como chave de merge quando possível; aviso ao usuário; documentar limite.
6. **Sequestro de convite** (e-mail divergente) — travar por padrão.
7. **Último owner órfão** — invariante de banco impede; UX deve guiar à transferência antes de sair.
8. **Operator de porta com sessão viva pós-evento** — risco de acesso indevido. Mitigação: revogação em massa + cron de cleanup + TTL curto p/ operadores.

**Decisões técnicas tomadas:**
- Claims via Custom Access Token Hook (não tabela de sessão custom).
- `active_org_id` persistido em `user_preferences` (server-side) — fonte de verdade do contexto, não só o front.
- RLS lê claim (rápido) + revalidação live em ações sensíveis (defesa em profundidade).
- Convites guardam **snapshot** de papel/permissões (mudança posterior do default não altera convite pendente).
- Staff (org_users) **nunca** cria Account própria; só owner-de-conta tem Account.

---

### 9. Escopo MVP vs. depois

**MVP (entra na Fase 0/1 do roadmap — é pré-requisito do membership):**
- Supabase Auth: OTP e-mail + OAuth Google/Apple/X.
- Account → N orgs; `auth-bootstrap`; `org-create` + wizard básico.
- `org_users` com 3 papéis + permissões granulares por módulo.
- Custom Access Token Hook + claims + RLS multi-tenant testada.
- Seletor de org + `context-switch` + indicador de contexto.
- Convites de equipe (invite/accept/resend/revoke) + onboarding de staff.
- Operator de porta com escopo restrito (papel mínimo; escopo por evento pode ser simples).
- Revogação/suspensão de staff; invariante de último owner; transferência de posse (versão básica).
- `audit_logs` das ações de auth/RBAC; rate limiting de OTP/login.
- i18n base (pt-BR, en-US, es) na infra de auth (mensagens) — conforme decisão do doc §30.5.

**Depois (pós-MVP):**
- `role_templates` (cargos salvos reutilizáveis).
- Step-up auth completo em todas as ações sensíveis (MVP cobre as críticas).
- Mover org entre Accounts (`org-move-account`) — venda/migração de base.
- `account_users` com múltiplos managers (além do owner) e papéis a nível de conta.
- Sessões device-bound para portaria; políticas avançadas de sessão.
- SSO/SAML para contas enterprise; login com senha (se demandado).
- Merge assistido de identidades duplicadas (Apple relay vs Google).
- 2FA/MFA além do OTP (TOTP app) para owners.

---

> **Resumo:** este é o domínio fundacional de segurança. Deve ser construído logo após a fundação e antes de qualquer domínio que persista dados. O maior risco é isolamento de tenant (RLS) e a maior sutileza é a gestão de contexto/claims na troca de org e na revogação em tempo real.
