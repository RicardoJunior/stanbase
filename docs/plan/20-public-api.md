## 20. API REST Pública & OpenAPI/Swagger

> Domínio que transforma a Stanbase em **plataforma**: a camada REST `/v1` em Edge Functions que parceiros, integradores e o modo headless consomem, com **OpenAPI 3.1 como fonte única da verdade** do contrato. Tudo o que o front hosted faz é possível pela API — **paridade total** (§5.2 do doc). Este domínio define o **contrato público estável** (DTOs limpos, desacoplados do schema interno), as **credenciais de máquina** (API key server-to-server, OAuth2 client-credentials para parceiros) além do JWT de usuário, **paginação por cursor**, **idempotência**, **envelope de erro consistente**, **versionamento e deprecação**, **rate limiting/rotação de chave**, e o **sandbox/test mode**. A partir do OpenAPI gera-se Swagger UI (`/v1/docs`), o **SDK JS** e o **MCP** (domínios irmãos `mcp` e webhooks).
>
> Fontes de verdade no doc: §21 (API REST + OpenAPI), §5 (modos de operação / API-first by default), §6.2 (por que Edge e não PostgREST cru), §25.6 (`api_keys`, `audit_logs`), §26 (segurança/rate limit/idempotência), §28 (geração de SDK/MCP/Swagger no CI).
>
> **Fronteira com a Fundação (§05):** a fundação **já entrega** a infra transversal das Edge Functions — `_shared` (auth resolver, errors/envelope, validação, idempotência, rate-limit, logger), o `v1-router`, `/v1/health`, `/v1/docs`, `/v1/openapi.json`, e os geradores OpenAPI→SDK/MCP/tipos. Este domínio **não reimplementa** isso; ele **define a disciplina de contrato público** (DTOs, versionamento, deprecação), **implementa as credenciais de máquina** (API keys e OAuth client-credentials — o JWT de usuário vem de `auth-rbac`), o **test mode/sandbox**, o **console de desenvolvedores**, e **costura** os endpoints de negócio dos outros domínios num catálogo OpenAPI coerente. Quando este doc cita "a fundação faz X", X é pré-requisito, não escopo aqui.

---

### 1. Como funciona

#### 1.1 Princípio central — API-first by default e paridade total

O doc (§5, §6.2) é categórico: *"o front hosted é só o primeiro cliente da mesma API pública. Nada do produto vive escondido fora da API."* Na prática isso gera **duas regras de ouro** que este domínio precisa fazer valer:

1. **Paridade de capacidades, não de implementação.** Toda **capacidade de negócio** que o front hosted oferece (assinar tier, emitir passport, criar segmento, validar membro, listar transações) **deve** ter endpoint `/v1` equivalente. O que o front faz via `supabase-js`+RLS, o terceiro faz via `/v1`+credencial. A paridade é medida por **caso de uso**, não por chamada 1:1.
2. **Mas o front interno NÃO consome `/v1` para seus próprios dados** (regra de ouro da fundação §05 1.1): ele usa `supabase-js`+RLS por latência. A API `/v1` é para **terceiros/headless/MCP**. O "dogfooding" acontece onde expor uma capacidade pública faz sentido (ex.: o admin chama `/v1/passport/issue` porque precisa do segredo do certificado, não porque é obrigado a passar pela API para tudo).

> **Edge case de paridade (gate de release):** sempre que um domínio de negócio adiciona uma capacidade nova no front, há o risco de ela **não** ganhar endpoint público — quebrando a promessa de headless. Mitigação: um **checklist de paridade** no CI (§8) e o `openapi.yaml` como artefato obrigatório de cada PR de domínio que toca capacidade de membro.

#### 1.2 Anatomia de uma requisição `/v1` (o pipeline, fim a fim)

Toda requisição pública passa pelo mesmo pipeline determinístico (montado sobre o `_shared` da fundação, orquestrado pelo `v1-router`):

```
[1] CORS / preflight
   ↓
[2] Resolve credencial  (ordem: Authorization: Bearer sk_… → API key
                                 | Bearer <jwt OAuth client-cred>
                                 | Bearer <jwt usuário Supabase>)
   ↓ → { credential_type, key_id|client_id|user_id, org_id, scopes, mode(live|test) }
[3] Rate limit por credencial (token-bucket) → 429 + RateLimit-* headers
   ↓
[4] Versão/deprecação: lê /v1 do path; injeta Sunset/Deprecation headers se aplicável
   ↓
[5] Resolve mode (live|test) da credencial → escolhe schema/conexão de dados
   ↓
[6] Autoriza escopo: a operação exige scope X? a credencial tem? → 403 forbidden
   ↓
[7] Idempotência (se POST financeiro): lê Idempotency-Key → replay | conflict | segue
   ↓
[8] Valida body/query/params contra schema derivado do OpenAPI → 422 validation_failed
   ↓
[9] Handler de negócio: query com SERVICE ROLE filtrando org_id EXPLICITAMENTE
       (nunca confia no body; nunca confia só na ausência de RLS)
   ↓
[10] Mapeia Row(s) internas → DTO público (snake_case, sem colunas internas)
   ↓
[11] Resposta: objeto direto (single) | { data:[…], next_cursor } (lista)
        + x-request-id + headers de rate limit + headers de deprecação
   ↓
[12] Log estruturado (request_id, org_id, actor, route, status, latency, mode)
        + audit_log se mutação
```

> **Por que service role e não o JWT do usuário no caminho público?** Porque API key e OAuth client-credentials **não têm** JWT de usuário com `org_id` no claim. A Edge Function resolve `org_id` da **credencial** e usa service role, **filtrando `org_id` na própria query** (defesa em profundidade — a fundação §05 2.3 já alerta que service role **bypassa** RLS). Para o caso de **JWT de usuário** chamando `/v1` (modo híbrido/SDK no browser), o RLS ainda protege, mas o handler **continua** filtrando explicitamente para uniformizar o código.

#### 1.3 As três credenciais — quando usar cada uma

| Credencial | Quem usa | Formato | `org_id` vem de | Escopo |
|---|---|---|---|---|
| **API key** (server-to-server) | Backend do dono/parceiro, scripts, Zapier, n8n | `sk_live_…` / `sk_test_…` (secreta) | A própria chave (pertence a **1 org**) | `scopes` da chave (subconjunto das permissões) |
| **OAuth2 client-credentials** | **Parceiros** que operam sobre **várias orgs** (agência, integrador, marketplace) | `client_id` + `client_secret` → `access_token` (Bearer, curto) | O token traz `org_id` **autorizado** (grant por org) | `scopes` do grant |
| **JWT de usuário** (Supabase Auth) | App próprio do dono (modo híbrido), SDK no browser logado, MCP do copilot | `Bearer <supabase jwt>` | Claim `active_org_id` (de `auth-rbac` §06) | Permissões do usuário naquela org |

> **Decisão de design (edge case multi-org):** a **API key pertence sempre a uma única org** (simples, o caso 90%). Quando um **parceiro precisa operar N orgs de N donos diferentes**, ele **não** colhe N API keys — usa **OAuth client-credentials** com um **grant por org** (cada dono autoriza o parceiro na sua org via tela de "Apps conectados"). Assim a revogação é por dono, por org, sem o parceiro guardar segredos de terceiros. Ver §1.8.

#### 1.4 API keys — ciclo de vida e máquina de estados

```
        create
  ──────────────►  ACTIVE  ──────────────────────────────►  (uso normal)
                    │  │
        rotate ─────┘  └──── revoke ──────►  REVOKED  (irreversível; 401 imediato)
            │
            ▼
     ACTIVE (nova) + old → GRACE (TTL configurável, ex.: 24h–7d) → EXPIRED
```

Regras concretas:

- **Geração:** a chave crua (`sk_live_<32+ bytes base62>`) é **exibida UMA vez** na criação e **nunca** mais. Armazenamos apenas o **hash** (`sha256`, ou argon2id se quisermos resistir a leak de tabela) + um **prefixo/last4** (`sk_live_…a1B2`) para o dono identificar a chave na lista. O segredo nunca trafega de volta nem aparece em log (redaction obrigatória no `logger` da fundação).
- **Prefixo declara o mode:** `sk_live_…` opera em dados **reais**; `sk_test_…` opera no **sandbox** (§1.9). O mode é imutável por chave (uma chave nasce live **ou** test).
- **Escopos:** a chave carrega `scopes` (array). Escopos espelham módulos×ações do RBAC (`members:read`, `members:write`, `subscriptions:write`, `passport:issue`, `transactions:read`, `webhooks:manage`, …). O dono **não pode** conceder a uma chave escopo que ele próprio não tem (a criação valida contra as permissões do criador). Princípio do menor privilégio.
- **Rotação (rotate):** cria uma **nova** chave e coloca a antiga em **GRACE** com `expires_at` (janela para o cliente trocar o segredo sem downtime). Durante o grace, **ambas** funcionam; ao expirar, a antiga vira `revoked`. Rotação é a operação recomendada vs. revoke-e-recria (evita janela sem chave válida).
- **Revogação:** imediata e irreversível. Próxima request com a chave → `401 unauthorized`. Como a checagem é por **hash em tabela** (não JWT stateless), a revogação é **instantânea** (vantagem sobre o JWT de usuário, que espera o TTL — §06 1.6). Para performance, cache curto (ex.: 30–60s) do lookup de chave, **invalidado** no revoke/rotate via Realtime/notify.
- **`last_used_at` e metadados de uso:** atualizados de forma **assíncrona** (não bloquear a request; enfileirar update ou usar `pg_cron` agregando do log) para não escrever no hot path a cada chamada.
- **Limite de chaves por org** (anti-abuso/organização): ex.: 50 ativas; configurável por superadmin.
- **Step-up auth** (de `auth-rbac` §06 1.13) é exigido para **criar/rotacionar chave com escopo financeiro** (`subscriptions:write`, `transactions:*`, `payouts:read`).

#### 1.5 Paginação por cursor (única forma suportada)

- **Apenas cursor** (`?limit=&cursor=`), **nunca** offset (offset degrada e é instável sob escrita concorrente). Padrão do doc §21.1.
- **Cursor é opaco e assinado/codificado:** base64url de `{ "k": <chave de ordenação>, "v": <valor>, "d": "next|prev", "f": <hash dos filtros> }`. O `f` (hash dos filtros aplicados) garante que **não dá para reusar um cursor com um conjunto de filtros diferente** (erro `invalid_cursor`).
- **Ordenação estável:** sempre por uma chave **única e monotônica** — recomendado `(created_at, id)` ou `id` se for ULID/uuid v7 ordenável. Empate em `created_at` resolvido pelo `id` (tie-breaker), senão o cursor "pula" linhas.
- **Resposta:** `{ "data": [...], "next_cursor": "…" | null, "has_more": true|false }`. `next_cursor: null` ⇒ fim. **Não retornamos `total`** por padrão (count é caro em multi-tenant); se um endpoint precisar, é opt-in via `?include=count` e documentado como potencialmente lento.
- **`limit`:** default 25, máximo 100 (clamp; pedir 1000 retorna 100, não erro). Documentado no OpenAPI.
- **Edge case — dado deletado/mudado entre páginas:** cursor keyset tolera inserções/remoções sem duplicar nem pular itens já vistos (diferente de offset). Itens **novos** que entram antes do cursor não aparecem (consistência "snapshot-ish"), o que é aceitável e documentado.

#### 1.6 Idempotência (`Idempotency-Key`) — contrato público

A **mecânica** (tabela `idempotency_keys`, replay/conflict/hash) vem da fundação (§05 2.1, 3.3). Este domínio define **o contrato público e onde é obrigatório/opcional**:

- **Obrigatório** (request sem `Idempotency-Key` → `400 idempotency_key_required`) em POSTs que **movem dinheiro ou criam recurso cobrável**: `POST /v1/subscriptions`, `POST /v1/events/{id}/tickets` (venda), `POST /v1/gifts` (presente pago), `POST /v1/subscriptions/{id}/change-tier` (com proração cobrável).
- **Recomendado/aceito** (idempotência se o cliente enviar a key, senão segue) em demais POSTs de criação (`/v1/members`, `/v1/segments`, `/v1/content`, `/v1/messages`) para o cliente poder fazer retry seguro.
- **Janela de validade:** a key é válida por **24h** (TTL, GC pela fundação). Mesma key + mesmo `request_hash` dentro da janela → **replay** da resposta (mesmo status, mesmo body, header `Idempotency-Replayed: true`). Mesma key + body **diferente** → `422 idempotency_conflict` (mascarar bug do cliente é proibido). Key ainda `in_progress` (request gêmea concorrente) → `409 idempotency_conflict` com `Retry-After`.
- **Escopo da key:** `(org_id, endpoint, key)` — a mesma string de key em endpoints diferentes ou orgs diferentes são independentes. O cliente é responsável por gerar keys únicas (uuid recomendado).
- **Interação com PSP (edge case crítico):** em `POST /v1/subscriptions`, a Edge cria a cobrança no Asaas. O **`Idempotency-Key`** do cliente **não** é o mesmo que a idempotência do Asaas — geramos uma **chave de idempotência derivada e estável** para o Asaas a partir da nossa (`hash(org_id|key)`), de modo que um retry da mesma request `/v1` **não** crie cobrança duplicada no PSP. Sem isso, um timeout no nosso lado + retry do cliente = cobrança dupla. (Detalhe pertence a `payments-billing`, mas o **contrato** de idempotência é exigido aqui.)

#### 1.7 Envelope de erro, versionamento e DTOs

- **Envelope de erro** (fonte: fundação §05 3.3, contrato público aqui): todo erro retorna
  ```json
  { "error": { "code": "validation_failed", "message": "…", "details": { "field": ["…"] }, "request_id": "req_…", "doc_url": "https://docs.stanbase.com/errors/validation_failed" } }
  ```
  Códigos canônicos estáveis (parte do contrato, versionados): `unauthorized`, `forbidden`, `not_found`, `validation_failed`, `idempotency_key_required`, `idempotency_conflict`, `conflict`, `rate_limited`, `invalid_cursor`, `unsupported_version`, `deprecated`, `insufficient_scope`, `org_suspended`, `mode_mismatch`, `internal`. HTTP status mapeado por código. **Adicionar código novo é não-breaking; mudar/remover um existente é breaking.**
- **Versionamento (`/v1` no path):** mudança **breaking** só em nova major (`/v2`). Definição operacional de breaking (parte do contrato, no CONTRIBUTING): remover campo/endpoint, renomear campo, mudar tipo, tornar opcional→obrigatório no request, mudar enum removendo valor, mudar semântica de um campo. **Não-breaking** (permitido em `/v1`): adicionar endpoint, adicionar campo opcional no request, adicionar campo na resposta, adicionar valor de enum **se o cliente foi instruído a tolerar enums desconhecidos** (documentado), adicionar header.
- **DTOs ≠ schema interno (regra dura, §06 2 da fundação reforça):** os tipos do banco (`database.types.ts`, colunas internas) **jamais** vazam para `sdk-js`/OpenAPI. As Edge Functions fazem `Row → DTO`. Exemplos do que **não** sai no DTO público: `psp_ref` cru, `auth_token` do passe, `hash` de api key, colunas de score interno em bruto, `account_id` (a menos que relevante), campos de auditoria interna. O DTO expõe o **Member ID de 8 chars** como identificador público, não o uuid interno (`members.id`) — ver §1.10.
- **Datas/formato:** JSON, `snake_case`, ISO-8601 UTC com `Z`, valores monetários em **centavos inteiros** + `currency` (evita float; ex.: `{ "amount": 6000, "currency": "BRL" }` = R$ 60,00) — decisão a confirmar (§8).

#### 1.8 OAuth2 client-credentials para parceiros (e o "Connected Apps")

Para parceiros que integram **múltiplas orgs** (uma agência que gere 30 clubes, um app de marketplace), API key por org não escala. Fluxo:

1. **Registro do parceiro** (feito pela Stanbase / superadmin no MVP, self-service depois): cria um **`oauth_client`** com `client_id`, `client_secret` (hash), `redirect_uris` (se usar authorization-code no futuro), `allowed_scopes`, `name`, `logo`.
2. **Autorização por org (grant):** cada **dono de org** autoriza o parceiro em **Configurações → Apps conectados** → escolhe escopos → cria `oauth_grants(client_id, org_id, scopes, status)`. Isso é o consentimento do dono; sem ele, o parceiro **não** acessa aquela org.
3. **Token:** `POST /v1/oauth/token` (grant_type=`client_credentials`, `client_id`, `client_secret`, `scope`, **`org_id`** alvo) → retorna `access_token` (JWT curto, ex.: 15–60min, assinado pela Stanbase) cujo claim traz `org_id` + `scopes` ∩ (allowed ∩ grant). Sem grant ativo para aquele `org_id` → `403`.
4. **Uso:** `Authorization: Bearer <access_token>` nas chamadas `/v1`. O resolver (§1.2) trata como credencial de máquina escopada à org do token.
5. **Revogação:** o **dono** revoga o grant (corta o parceiro só na sua org); a **Stanbase** revoga o client inteiro (corta em todas as orgs). Tokens já emitidos morrem no TTL (curto) — para corte imediato, lista de `jti` revogados consultada no hot path (cache curto).

> **Por que client-credentials e não authorization-code no MVP?** Porque o caso é **server-to-server entre o backend do parceiro e a Stanbase**, sem usuário humano no loop em runtime (o consentimento do dono é prévio, na tela de Apps conectados). Authorization-code (com tela de login do usuário final) entra **pós-MVP** se surgir o caso "app de terceiro que loga em nome do membro".

#### 1.9 Sandbox / Test mode (edge case central)

O modo de teste é **requisito de DX** para parceiros desenvolverem sem mexer em dados/dinheiro reais.

- **Determinado pela credencial:** `sk_test_…` e tokens OAuth emitidos com `mode=test` ⇒ **test mode**. `sk_live_…` ⇒ **live**. Nunca por header (evita "esquecer" e tocar produção). Uma request com chave test em endpoint que só faz sentido live (ou vice-versa) e dados cruzados → `mode_mismatch`.
- **Isolamento de dados — decisão (§8):** duas opções: **(a)** schema/projeto Supabase separado para sandbox (isolamento físico, mais simples de raciocinar, custo de infra duplicada); **(b)** coluna `mode` (`live`/`test`) em todas as tabelas de domínio + filtro automático no resolver e nas policies (sem infra extra, mas exige disciplina em TODA query e RLS). **Recomendação:** (b) — `mode` na credencial e nas tabelas, com o resolver injetando o filtro, porque mantém a mesma base de código e evita drift de schema entre dois bancos; o risco (vazar test↔live) é mitigado pelo mesmo rigor do `org_id`.
- **PSP em sandbox:** test mode usa o **ambiente sandbox do Asaas** (chaves de API sandbox) — nenhuma cobrança real, cartões de teste, webhooks de teste. Live usa produção. A camada PSP-agnóstica (de `payments-billing`) seleciona o ambiente pelo `mode`.
- **Wallet/Passport em sandbox:** passes test **não** usam o certificado de produção (ou usam um Pass Type ID de teste); QR aponta para `verify` em modo test. Evita carteirinhas "de mentira" circulando como reais.
- **Webhooks em test:** endpoints registrados podem ser marcados `mode=test`; eventos de sandbox só disparam para esses. (Detalhe no domínio `webhooks`.)
- **Limpeza:** dados de sandbox podem ser **resetados** pelo dono ("limpar dados de teste") e/ou expirados por job. Sandbox tem **rate limits e quotas próprios** (mais frouxos para dev, mas ainda limitados).

#### 1.10 Resolução de recursos pelo Member ID público (edge case)

O identificador público de membro nas rotas (`/v1/members/{memberId}`) é o **Member ID de 8 chars** (§7 do doc), **não** o uuid interno. Implicações:

- Normalização: o resolver faz **upper-case + remove separadores** (`b7k2-m9x4` → `B7K2M9X4`) antes do lookup (o doc §7.5 manda armazenar normalizado).
- O Member ID é **único global**, mas o acesso é **escopado pela credencial**: `GET /v1/members/B7K2M9X4` só retorna se aquele membro pertence à **org da credencial**; senão `404 not_found` (não `403`, para **não vazar a existência** do ID em outra org — anti-enumeração cross-org).
- Outros recursos (subscriptions, tickets, events) usam **uuid público** (uuid v7/ULID) no path, não o id interno sequencial — não há id sequencial adivinhável exposto.

---

### 2. Modelo de dados

> Tabelas de **plataforma de API** (algumas sem `org_id` quando são globais de parceiro; a maioria com `org_id` + RLS). A fundação já criou `api_keys` (estrutura base, §25.6) e `idempotency_keys`; aqui detalhamos e adicionamos o resto.

#### 2.1 Tabelas novas / tocadas

**`api_keys`** (existe §25.6 — detalhada/expandida aqui)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | id público da chave (`key_…`) p/ referenciar sem expor segredo |
| `org_id` | uuid FK→organizations NOT NULL | a chave pertence a 1 org |
| `name` | text | rótulo dado pelo dono ("Zapier produção") |
| `key_hash` | text NOT NULL | sha256/argon2id do segredo; **nunca** o segredo cru |
| `prefix` | text | `sk_live`/`sk_test` |
| `last4` | text | últimos 4 chars p/ identificação na UI |
| `mode` | text | `live`/`test` (CHECK); imutável |
| `scopes` | text[] | ex.: `{members:read, subscriptions:write}` |
| `status` | text | `active`/`grace`/`revoked` (CHECK) |
| `created_by` | uuid FK→auth.users | quem criou (auditoria) |
| `expires_at` | timestamptz null | preenchido quando entra em `grace` (rotação) |
| `last_used_at` | timestamptz null | atualizado **assíncrono** |
| `rotated_to` | uuid null FK→api_keys | aponta p/ a chave que a substituiu |
| `created_at` | timestamptz | |
| | | INDEX(`org_id`,`status`); **UNIQUE(`key_hash`)**; INDEX(`key_hash`) p/ lookup rápido |

**`oauth_clients`** (nova — parceiros)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `client_id` | text UNIQUE | público |
| `client_secret_hash` | text | hash do secret |
| `name`, `logo_url` | text | exibidos na tela de consentimento do dono |
| `allowed_scopes` | text[] | teto de escopos que o client pode pedir |
| `redirect_uris` | text[] | reservado p/ authorization-code futuro |
| `status` | text | `active`/`suspended`/`revoked` |
| `owner_partner` | text/uuid | identificação do parceiro (interno) |
| `created_at` | timestamptz | |

> Sem `org_id` — é global (de parceiro, gerido pela Stanbase/superadmin).

**`oauth_grants`** (nova — consentimento dono×parceiro, por org)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `client_id` | text FK→oauth_clients | |
| `org_id` | uuid FK→organizations NOT NULL | a org que autorizou |
| `scopes` | text[] | escopos concedidos (⊆ allowed) |
| `status` | text | `active`/`revoked` |
| `granted_by` | uuid FK→auth.users | owner/admin que autorizou |
| `created_at`, `revoked_at` | timestamptz | |
| | | UNIQUE(`client_id`,`org_id`); INDEX(`org_id`,`status`) — RLS por `org_id` |

**`oauth_tokens`** (nova — opcional; só se quisermos revogação imediata por `jti`)
| Coluna | Tipo | Notas |
|---|---|---|
| `jti` | text PK | id do token emitido |
| `client_id` | text | |
| `org_id` | uuid | |
| `scopes` | text[] | |
| `expires_at` | timestamptz | |
| `revoked` | bool default false | corte imediato |

> Alternativa sem tabela: tokens stateless + denylist curta em cache. Decisão em §8.

**`api_request_logs`** (nova — auditoria/observabilidade de API; particionada por tempo)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | bigint IDENTITY PK | |
| `request_id` | text | `req_…` correlaciona com logs estruturados |
| `org_id` | uuid null | |
| `credential_type` | text | `api_key`/`oauth`/`jwt` |
| `credential_id` | text | `key_…`/`client_id`/`user_id` |
| `mode` | text | `live`/`test` |
| `method`, `route` | text | `route` é o **template** (`/v1/members/{memberId}`), não a URL com PII |
| `status` | int | HTTP |
| `latency_ms` | int | |
| `error_code` | text null | |
| `api_version` | text | `v1` |
| `idempotency_key` | text null | |
| `at` | timestamptz | INDEX(`org_id`,`at desc`); INDEX(`credential_id`,`at desc`) |

> **Não** logar body/PII aqui (LGPD); só metadados. Retenção/particionamento via job (alinhado com `observability-qa`).

**`rate_limit_policies`** (nova — limites por credencial/plano)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `scope_type` | text | `global`/`org`/`api_key`/`oauth_client`/`mode` |
| `scope_ref` | text null | id do alvo (null = default) |
| `rpm` | int | requests por minuto |
| `burst` | int | tamanho do balde |
| `daily_quota` | int null | teto diário opcional |
| | | usado pelo token-bucket da fundação; default global + overrides |

**`rate_limit_counters`** — preferir **não** tabela; usar contador em memória/Realtime ou `pg`-based leve. (Decisão em §8: store do rate limit.)

**`api_deprecations`** (nova — registro do que está depreciado)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `target` | text | `endpoint:/v1/foo` ou `field:/v1/members.bar` ou `version:v1` |
| `deprecated_at` | timestamptz | injeta header `Deprecation` |
| `sunset_at` | timestamptz null | injeta header `Sunset`; após, `410 gone`/`deprecated` |
| `replacement` | text null | doc_url/endpoint sucessor |
| `notes` | text | |

**`platform_billing_settings` / `connections` / `audit_logs`** — já existem (fundação/§25.6); este domínio **lê** e **escreve audit** (`api_key.created`, `api_key.rotated`, `api_key.revoked`, `oauth.grant_created`, `oauth.grant_revoked`).

#### 2.2 Constraints / invariantes

- `api_keys`: CHECK em `mode ∈ {live,test}`, `status ∈ {active,grace,revoked}`; `prefix` coerente com `mode`. Não permitir mudar `mode` (imutável após insert — trigger).
- `oauth_grants`: UNIQUE(`client_id`,`org_id`) — um grant por par; reautorizar atualiza scopes.
- Trigger: ao `rotate`, a chave antiga **deve** receber `expires_at` e `status='grace'` na mesma transação; a nova recebe `status='active'` e `rotated_to` referência reversa.
- RLS: `api_keys`, `oauth_grants` filtram por `org_id` (dono só vê suas chaves/grants). `oauth_clients` é global (só superadmin escreve; donos leem o `name/logo` no fluxo de consentimento via Edge, não direto).

#### 2.3 Índices quentes

- `api_keys(key_hash)` — lookup em **todo** request com API key (caminho crítico; manter quente + cache).
- `oauth_grants(client_id, org_id)` WHERE `status='active'` — validação de grant por request.
- `api_request_logs(org_id, at desc)` e `(credential_id, at desc)` — dashboards de uso.
- `idempotency_keys` PK `(org_id, endpoint, key)` (fundação).

---

### 3. API & Edge Functions

> Os endpoints de **negócio** (`/v1/members`, `/v1/subscriptions`, `/v1/passport/*`, `/v1/events/*`, etc., listados no §21.2 do doc) **pertencem aos respectivos domínios** — este domínio **não** os reimplementa, mas **os agrega no OpenAPI**, garante que seguem os contratos transversais (envelope, cursor, idempotência, DTO) e **valida a paridade**. Os endpoints **próprios deste domínio** são os de **gestão de credenciais, OAuth, descoberta e meta**.

#### 3.1 Endpoints próprios deste domínio (`/v1`)

```
# Descoberta / meta (públicos, sem auth de negócio)
GET    /v1/docs                         # Swagger UI (fundação entrega o shell; aqui o spec real)
GET    /v1/openapi.json                 # OpenAPI 3.1 servido (fonte p/ SDK/MCP externos)
GET    /v1/health                       # liveness/readiness (fundação)
GET    /v1/versions                     # versões suportadas, deprecadas, sunset dates

# API keys (gestão pelo dono; auth = JWT usuário com escopo developers:manage)
GET    /v1/api-keys                      # lista chaves da org (sem segredo; prefix+last4+scopes+status)
POST   /v1/api-keys                      # cria chave (retorna segredo UMA vez) — step-up se escopo financeiro
POST   /v1/api-keys/{id}/rotate          # rotaciona (nova chave + grace na antiga)
POST   /v1/api-keys/{id}/revoke          # revoga imediato
GET    /v1/api-keys/{id}/usage           # métricas de uso (req, erros, último uso)

# OAuth client-credentials (parceiros)
POST   /v1/oauth/token                   # grant_type=client_credentials → access_token (escopado a org)
POST   /v1/oauth/revoke                  # revoga token/grant (RFC 7009-like)
GET    /v1/oauth/.well-known/...         # metadados OAuth (discovery)

# Apps conectados (consentimento do dono a um parceiro) — auth = JWT usuário
GET    /v1/connected-apps                # parceiros autorizados na org (grants)
POST   /v1/connected-apps/{clientId}/authorize   # cria/atualiza grant (escopos)
POST   /v1/connected-apps/{clientId}/revoke      # revoga grant nessa org

# Identidade da credencial (introspecção)
GET    /v1/whoami                        # devolve org_id, mode, scopes, credential_type da credencial atual
```

> `GET /v1/me` (usuário + orgs) é de `auth-rbac`. `GET /v1/whoami` aqui é o equivalente **para credencial de máquina** (API key/OAuth): "quem sou eu, qual org, quais escopos, qual mode" — essencial para o parceiro depurar.

#### 3.2 Edge Functions / componentes

| Function/componente | Tipo | Descrição |
|---|---|---|
| `v1-router` (estende o da fundação) | Edge | monta o pipeline §1.2; despacha p/ handlers de domínio; aplica versão/deprecação/mode |
| `auth-resolver` (estende `_shared/auth.ts`) | Edge lib | resolve API key (hash lookup + cache) / OAuth token (verify jwt + grant) / JWT usuário → `{org_id, scopes, mode, actor}` |
| `scope-guard` | Edge lib | dado `requiredScope`, valida contra `scopes` da credencial → `insufficient_scope` |
| `dto-mapper` (lib por domínio) | lib | `Row → DTO público`; cada domínio registra seus mapeadores; testes garantem que campos internos não vazam |
| `oauth-token` | Edge | emite access_token client-credentials (valida client_secret + grant) |
| `apikey-service` | Edge | create/rotate/revoke + geração CSPRNG + hash + grace scheduling |
| `cursor` (lib) | Edge lib | encode/decode/validate cursor opaco com hash de filtros |
| `deprecation-mw` | Edge lib | injeta headers `Deprecation`/`Sunset`/`Link`; bloqueia após sunset |
| `mode-filter` | Edge lib | injeta filtro `mode` em queries/policies (sandbox isolation) |
| `openapi-bundler` | build/CI | costura os fragmentos OpenAPI de cada domínio num `openapi.yaml` único, valida (spectral), gera SDK/MCP/tipos |

#### 3.3 Jobs / cron

| Job | Trigger | Descrição |
|---|---|---|
| `apikey-grace-expire` | pg_cron (frequente) | expira chaves em `grace` vencidas → `revoked` |
| `apikey-lastused-flush` | pg_cron (min) | agrega `last_used_at` do log → `api_keys` (tira do hot path) |
| `oauth-token-gc` | pg_cron | limpa `oauth_tokens` expirados (se usarmos a tabela) |
| `api-logs-retention` | pg_cron | particiona/expira `api_request_logs` (LGPD/observability) |
| `sandbox-reset` | pg_cron/manual | limpa dados `mode=test` antigos por org |
| `deprecation-notifier` | pg_cron | avisa (e-mail/webhook) donos que usam endpoint/campo perto do sunset |
| `usage-quota-rollup` | pg_cron | agrega uso por chave/org p/ quotas e relatório de DX |

---

### 4. Telas / Front

> Telas no **app admin** (`apps/admin`), módulo **"Desenvolvedores"** (§10.1 nº13). Não há tela de membro neste domínio (é infra). O **Swagger UI** é uma tela pública servida em `/v1/docs`.

**Módulo Desenvolvedores (admin):**

- **Visão geral / Onboarding de API** — cartão "modo Headless": link para docs, base URL (`api.stanbase.com/v1`), botão "Criar primeira chave", toggle **Live ⟷ Test** visível (e cor distinta para test, evitando confundir).
- **API Keys** — tabela (nome, prefix+last4, mode, escopos, status, criado por, último uso). Ações: **Criar** (modal com nome + seleção de escopos via matriz + escolha live/test → exibe o segredo **uma vez** com aviso "copie agora, não será mostrado de novo" + botão copiar), **Rotacionar** (modal explicando a janela de grace), **Revogar** (confirmação + aviso de impacto imediato), **Ver uso** (gráfico de requests/erros). Step-up auth (modal de `auth-rbac`) ao criar/rotacionar chave com escopo financeiro.
- **Apps conectados (OAuth)** — lista de parceiros autorizados na org (logo, nome, escopos, data). Ações: autorizar (tela de consentimento mostrando o que o parceiro poderá fazer), ajustar escopos, **revogar** (corta o parceiro só nesta org).
- **Webhooks** — (pertence ao domínio `webhooks`, mas vive no mesmo módulo) registro de endpoints, eventos assinados, segredo, log de entregas/replay.
- **Documentação / OpenAPI** — embute/linka o **Swagger UI** (`/v1/docs`), botão "Baixar OpenAPI", links para SDK e MCP (domínios irmãos).
- **Test mode banner** — quando o toggle está em **Test**, banner persistente "Você está vendo recursos de TESTE" para o dono não confundir chaves/dados.

**Swagger UI público (`/v1/docs`):**
- Renderiza o `openapi.json` versionado; **"Try it out"** habilitado, mas configurado para **sandbox por padrão** (pré-preenche servidor de test e orienta usar `sk_test_…`), evitando que alguém dispare uma cobrança real explorando a doc.
- Esquemas de auth documentados (API key, OAuth, JWT); exemplos de erro/cursor/idempotência.

**Componentes-chave:** `<ApiKeyTable/>`, `<CreateApiKeyDialog/>` (com `<ScopeMatrix/>`), `<SecretRevealOnce/>`, `<RotateKeyDialog/>`, `<ConnectedAppsList/>`, `<OAuthConsentScreen/>`, `<ModeToggle/>` (live/test), `<UsageChart/>`, `<SwaggerEmbed/>`.

---

### 5. Integrações externas

| Serviço | Como integra |
|---|---|
| **OpenAPI / Swagger toolchain** | `openapi.yaml` 3.1 é a fonte da verdade; `spectral` (lint do spec) no CI; Swagger UI servido em `/v1/docs`; `openapi-typescript` → tipos; gerador de SDK e de MCP (a fundação entrega os geradores; aqui mantemos o spec). |
| **Asaas (sandbox vs prod)** | O **mode** da credencial seleciona ambiente Asaas (sandbox para `sk_test_`, produção para `sk_live_`). Camada PSP-agnóstica de `payments-billing` faz a troca; idempotência derivada para não duplicar cobrança em retry. |
| **Zapier / Make / n8n** | Consomem a API com **API key** (server-to-server). O app oficial Zapier (domínio `webhooks`) usa estes mesmos endpoints + auth. |
| **Apple/Google Wallet (sandbox)** | Test mode usa Pass Type ID/credenciais de teste para não emitir passes reais (alinhado com `passport`). |
| **Supabase Auth** | Origem do **JWT de usuário** (terceira credencial); o resolver valida a assinatura/claims (`active_org_id`, `perms`) emitidos por `auth-rbac`. |
| **Provedor de e-mail** | `deprecation-notifier` e avisos de criação/rotação/revogação de chave (segurança) usam o provedor transacional (domínio `communication`). |

---

### 6. Épicos & tarefas

#### Épico A — Contrato público & OpenAPI como fonte da verdade
- A1. Estrutura `openapi/` com **fragmentos por domínio** + `openapi-bundler` que costura num `openapi.yaml` 3.1 único, valida com **spectral** (regras: todo path tem auth, todo 4xx usa o envelope, toda lista é cursor-paginada). **(L)**
- A2. Definir e documentar no spec os **componentes transversais**: `Error`, `CursorPage<T>`, parâmetros `limit`/`cursor`, headers (`Idempotency-Key`, `RateLimit-*`, `Deprecation`/`Sunset`, `x-request-id`), security schemes (apiKey/oauth2/bearerJWT). **(M)**
- A3. **Convenção de DTO**: padrão de `dto-mapper` por recurso, com **teste de "vazamento"** (snapshot do DTO falha se aparecer campo interno proibido). **(M)**
- A4. **Definição operacional de breaking change** + linter de diff de OpenAPI no CI (`oasdiff`): PR que introduz breaking em `/v1` **falha**. **(L)**
- A5. **Checklist/gate de paridade**: lista das capacidades do front hosted ↔ endpoints `/v1`; CI alerta capacidade sem cobertura. **(M)**
- A6. Servir `openapi.json` + Swagger UI real em `/v1/docs` com "Try it out" defaultando para sandbox. **(M)**
- A7. `GET /v1/versions` + registro `api_deprecations` + `deprecation-mw` (headers Deprecation/Sunset, 410 após sunset). **(M)**

#### Épico B — API keys (server-to-server)
- B1. Migration `api_keys` expandida (mode, scopes, status, grace, rotated_to, hash, prefix, last4) + RLS + índices + invariantes (mode imutável). **(M)**
- B2. `apikey-service`: criação CSPRNG → hash → exibe segredo uma vez; validação de escopo ⊆ permissões do criador; step-up p/ escopo financeiro. **(L)**
- B3. **Rotação** com janela de grace + `apikey-grace-expire` cron; **revogação** imediata com invalidação de cache. **(M)**
- B4. Lookup de chave no resolver: hash + **cache curto** com invalidação via Realtime/notify; `last_used_at` assíncrono (`apikey-lastused-flush`). **(M)**
- B5. Endpoints `/v1/api-keys*` (list/create/rotate/revoke/usage) + audit logs. **(M)**
- B6. Telas: `<ApiKeyTable/>`, `<CreateApiKeyDialog/>` + `<ScopeMatrix/>`, `<SecretRevealOnce/>`, `<RotateKeyDialog/>`, `<UsageChart/>`. **(L)**

#### Épico C — OAuth2 client-credentials & Apps conectados
- C1. Migrations `oauth_clients`, `oauth_grants` (+ `oauth_tokens` se opção stateful) + RLS por org no grant. **(M)**
- C2. `POST /v1/oauth/token` (client-credentials, valida secret + grant, emite JWT escopado a org, TTL curto). **(L)**
- C3. Revogação: `/v1/oauth/revoke` + denylist `jti` (cache) para corte imediato; revogação por dono (grant) e por Stanbase (client). **(M)**
- C4. Apps conectados (admin): `<ConnectedAppsList/>` + `<OAuthConsentScreen/>` + endpoints authorize/revoke. **(M)**
- C5. Registro de `oauth_clients` por superadmin (MVP) + base p/ self-service de parceiro (pós-MVP). **(S)**

#### Épico D — Resolver, escopos, multi-tenant, whoami
- D1. `auth-resolver` unificado (ordem apiKey→oauth→jwt), deriva `{org_id, scopes, mode, actor, credential_type}` **da credencial**, nunca do body. **(L)**
- D2. `scope-guard` middleware por endpoint (`insufficient_scope`) + mapa escopo↔módulo×ação. **(M)**
- D3. `GET /v1/whoami` (introspecção da credencial) + `mode_mismatch` guard. **(S)**
- D4. Resolução de recurso por **Member ID** (normalização upper/sem separador) + 404 cross-org anti-enumeração. **(M)**

#### Épico E — Paginação por cursor (lib transversal)
- E1. Lib `cursor`: encode/decode opaco, hash de filtros (`invalid_cursor` em mismatch), tie-breaker `(created_at,id)`. **(M)**
- E2. Helper `paginate()` reutilizável (keyset, clamp de `limit`, `has_more`, `next_cursor`); adotado por **todos** os endpoints de lista. **(M)**
- E3. Documentar no OpenAPI o `CursorPage<T>` e `?include=count` opt-in. **(S)**

#### Épico F — Sandbox / Test mode
- F1. Decidir e implementar isolamento (recomendado: coluna `mode` em tabelas de domínio + filtro no resolver/policies). Migrations + `mode-filter` lib. **(L)**
- F2. Seleção de ambiente **Asaas sandbox** por mode (gancho em `payments-billing`); **Wallet** de teste (gancho em `passport`). **(M)**
- F3. `<ModeToggle/>` no admin + banner de test + `sandbox-reset` job + quotas próprias de sandbox. **(M)**

#### Épico G — Rate limiting, quotas, observabilidade de API
- G1. `rate_limit_policies` + token-bucket por credencial/IP/mode (sobre o `_shared/ratelimit` da fundação) + headers `RateLimit-*`/`Retry-After`. **(M)**
- G2. Store de contadores (decisão §8) + `daily_quota` + `usage-quota-rollup`. **(M)**
- G3. `api_request_logs` (sem PII) + dashboards de uso por chave/org + alertas de erro/latência (com `observability-qa`). **(M)**
- G4. `deprecation-notifier`: detectar donos usando endpoint/campo perto do sunset e avisar. **(M)**

#### Épico H — Geração de SDK & MCP a partir do OpenAPI (cola com domínios irmãos)
- H1. Validar que o `sdk-js` gerado (fundação) cobre as 3 auths + cursor + idempotência + erros tipados; smoke test do SDK contra sandbox. **(M)**
- H2. Validar que o `mcp-server` gerado mapeia cada operação→tool com o mesmo escopo/auth (handoff p/ domínio `mcp`). **(M)**
- H3. Publicar SDK/MCP/Swagger no CI a cada release não-breaking; changelog gerado do diff de OpenAPI. **(M)**

**Esforço agregado do domínio: L** (alto, mas grande parte da infra transversal nasce na **fundação**; aqui é contrato + credenciais + sandbox + console).

---

### 7. Dependências

| Depende de | Por quê |
|---|---|
| **fundacao** | Entrega o esqueleto `/v1`, `_shared` (errors/envelope, validação, idempotência base, rate-limit, logger), `v1-router`, `/health`/`/docs`/`/openapi.json`, geradores OpenAPI→SDK/MCP/tipos, e a regra "DTO ≠ schema interno". Sem isso não há onde plugar. **Bloqueante.** |
| **auth-rbac** | A **terceira credencial** (JWT de usuário) e os claims (`active_org_id`, `perms`, `org_ids`) vêm daqui; o modelo de escopos da API espelha módulos×ações do RBAC; step-up auth para chave financeira. **Bloqueante.** |
| **payments-billing** | Idempotência e sandbox dependem da seleção de ambiente Asaas (live/sandbox) e da idempotência derivada do PSP; endpoints `/v1/subscriptions|transactions|payouts` são deste domínio mas precisam estar coerentes com o contrato. |
| **member-identity** | Resolução de `/{memberId}` pelo Member ID de 8 chars (normalização, unicidade, anti-enumeração cross-org). |
| **design-system** | Telas do módulo Desenvolvedores (tabelas, modais, matriz de escopos) usam tokens/componentes. |
| **(consome) todos os domínios de negócio** | crm, tiers-perks, passport, events-tickets, content-gating, community-channels, communication, hall-of-fame, ai-layer expõem **seus** endpoints `/v1` seguindo os contratos transversais definidos aqui. Este domínio **agrega e disciplina**, não implementa o negócio deles. |

**É dependência de:** `webhooks` (reusa auth/escopo/eventos e o app Zapier sobre a API), `mcp` (gera tools do mesmo OpenAPI com o mesmo escopo), `admin-app` (módulo Desenvolvedores), e qualquer parceiro/headless. `integrations-framework` se beneficia mas não bloqueia.

> **Posição no cronograma:** a **disciplina de contrato** (Épico A) e a **convenção de DTO/cursor/erro** devem existir **desde o início** (são padrão que todo domínio de negócio segue ao expor endpoints). Mas o **conjunto completo** (API keys, OAuth, sandbox, console) é da **Fase 4** do roadmap (§29 "Plataforma para devs"). Ou seja: o **contrato** é MVP-cedo; a **plataforma de devs completa** é pós-MVP.

---

### 8. Riscos & decisões técnicas

**Decisões técnicas tomadas:**
1. **OpenAPI 3.1 é fonte única**; SDK/MCP/tipos/Swagger derivam dele; diff de spec no CI bloqueia breaking em `/v1`.
2. **DTO público ≠ schema interno** (mapeadores + teste anti-vazamento). Member ID público nas rotas, uuid interno nunca exposto.
3. **Três credenciais** (API key / OAuth client-credentials / JWT) com `org_id` derivado **sempre** da credencial; service role no caminho público **sempre** filtra `org_id`.
4. **API key = 1 org**; multi-org de parceiro via **OAuth client-credentials + grant por org** (consentimento do dono).
5. **Paginação só por cursor** (keyset), sem offset; sem `total` por padrão.
6. **Idempotência obrigatória** em POSTs financeiros, com idempotência **derivada** repassada ao Asaas (anti-cobrança-dupla).
7. **Mode (live/test) determinado pela credencial**, nunca por header.
8. **Revogação de API key é imediata** (hash em tabela), diferente do JWT de usuário (TTL).

**Riscos & edge cases:**
- **Acoplar contrato ao schema** (vazar coluna interna no DTO) → perde liberdade de evoluir o banco e pode vazar dado. Mitigação: teste anti-vazamento (A3), revisão.
- **Breaking change silencioso** em `/v1` (renomear campo "sem querer") → quebra integrações de terceiros. Mitigação: `oasdiff` no CI (A4), changelog, versionamento.
- **Quebra de paridade** (capacidade do front sem endpoint) → promessa headless falsa. Mitigação: gate de paridade (A5).
- **Cobrança duplicada por retry** sem idempotência derivada no PSP → membro cobrado 2×. Mitigação: §1.6 (chave derivada estável).
- **Vazar dados test↔live** (se optarmos por coluna `mode` em vez de banco separado) → dado de teste em produção ou vice-versa. Mitigação: filtro de mode no resolver e nas policies, com o **mesmo rigor do `org_id`**; testes. (Decisão de isolamento: §8 abaixo / openQuestions.)
- **Segredo de API key vazado em log** → comprometimento. Mitigação: só hash no banco, redaction no logger, alerta de uso anômalo, rotação fácil.
- **Cursor reusado com filtros diferentes** → resultados incoerentes/vazamento. Mitigação: hash dos filtros no cursor (`invalid_cursor`).
- **Enumeração de Member ID cross-org** → 404 (não 403) para não confirmar existência; rate limit anti-enumeração na rota.
- **Cold start de Edge no hot path** (lookup de chave a cada request) → latência. Mitigação: cache curto do lookup invalidado em revoke/rotate.
- **Rate limit distribuído** entre instâncias de Edge Function → contador inconsistente. Mitigação: store central leve (decisão §8) e tolerância a pequena imprecisão (fail-open vs fail-closed: **fail-open** com teto absoluto para não derrubar clientes legítimos por glitch de contador).
- **OAuth token de longa vida sem revogação imediata** → parceiro revogado ainda acessa. Mitigação: TTL curto + denylist `jti` no hot path (decisão stateless vs stateful).
- **`Idempotency-Key` reusada com payload diferente** → deve ser `422`, nunca replay silencioso (mascara bug).
- **"Try it out" do Swagger disparando ação real** → cobrança/efeito colateral por exploração da doc. Mitigação: default sandbox + aviso.

---

### 9. Escopo MVP vs. depois

**No MVP** (o suficiente para destravar headless básico e manter disciplina de contrato desde cedo — parte é Fase 0/1, o grosso da plataforma de devs é Fase 4 do §29):
- **Disciplina de contrato desde o início** (deve nascer com os primeiros endpoints de negócio): OpenAPI 3.1 como fonte da verdade, envelope de erro, **paginação por cursor**, convenção de **DTO ≠ schema**, idempotência nos POSTs financeiros, versionamento `/v1`. (Épico A parcial: A1–A3, A6; cursor E1–E2.)
- **API keys** server-to-server com escopos, criação/rotação/revogação, lookup eficiente, audit. (Épico B.) — é o mínimo para um dono/parceiro integrar headless.
- **Resolver das credenciais** (API key + JWT de usuário) e `scope-guard`; `whoami`. (Épico D, sem OAuth ainda.)
- **Rate limiting básico** por chave/IP + `api_request_logs` mínimo. (G1, G3 parcial.)
- **Swagger UI** em `/v1/docs` com sandbox default. (A6.)

**Depois do MVP** (Fase 4 — plataforma para devs completa):
- **OAuth2 client-credentials + Apps conectados** (parceiros multi-org) — Épico C. (No MVP, parceiro usa API key da própria org.)
- **Sandbox/Test mode** completo (coluna `mode` em tudo, Asaas sandbox, Wallet de teste, reset) — Épico F. (No MVP pode-se viver sem sandbox formal usando uma org de testes; mas é forte candidato a entrar cedo pela DX.)
- **Quotas/planos de rate limit, dashboards de uso ricos, deprecation-notifier** — G2, G4.
- **Diff de OpenAPI no CI + gate de paridade + changelog automático** — A4, A5, H3.
- **Geração/publicação de SDK e MCP** validadas e versionadas — Épico H (acopla com domínios `mcp`/`webhooks` na Fase 4).
- **Authorization-code OAuth** (app de terceiro em nome do membro), self-service de registro de parceiro, planos de quota por tier de parceria.

> **Resumo:** a parte **barata e obrigatória cedo** é a *disciplina de contrato* (OpenAPI, DTO, cursor, erro, idempotência, `/v1`) — ela precisa existir junto com os primeiros endpoints para não gerar dívida. A *plataforma de desenvolvedores completa* (OAuth de parceiro, sandbox formal, console rico, SDK/MCP publicados) é o pacote da **Fase 4**.
