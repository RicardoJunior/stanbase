## 19. Framework de Integrações

> Domínio-plataforma que dá à Stanbase a capacidade de **conectar a org a qualquer serviço externo** de forma uniforme, segura e auditável. Não é "uma integração com o Discord" — é o **substrato genérico** (Connection + Connector + Mapping + Webhook-in + Reconcile) sobre o qual TODAS as integrações concretas rodam: conteúdo (Twitch/YouTube/Vimeo), eventos (Sympla/Ingresse), identidade (Google/Apple/X), nicho (Steam/Riot/APIs do nicho), canais (Discord/Telegram/WhatsApp), pagamentos (Asaas) e wallet (Apple/Google). A postura de produto é: **"não vê sua ferramenta? a gente conecta pra você"** — o catálogo é extensível e há um caminho explícito para connectors sob demanda.
>
> Fonte de verdade: `STANBASE.md` §20 (integrações e §20.1 framework), §6 (stack: pgmq/pg_cron/pgvector, Edge Functions), §25.6 (`connections` cifrada), §22 (webhooks in/out), §26 (segredos cifrados, RLS, LGPD), §27 (observabilidade de syncs). Este domínio **executa** os syncs que `tiers-perks` (§09) apenas enfileira (contrato `entitlement_sync_jobs`), e fornece a `payments-billing` (§10) o padrão de Connection cifrada para a subconta Asaas.
>
> **Decisões imutáveis herdadas:** PSP = Asaas; segredos nunca chegam ao front (Vault/secret manager); RLS por `org_id`; API-first (tudo via `/v1`); Edge Functions TS/Deno; pgmq para filas, pg_cron para jobs. Connection é **por org** (não por Conta) — cada base tem suas próprias credenciais e mapeamentos.

---

### 19.1 Como funciona

#### 19.1.1 As cinco peças do framework (vocabulário)

O framework separa **definição** (o que existe, padronizado, mesmo para todos) de **instância** (o que a org conectou, com seus dados):

| Peça | É | Escopo | Volume |
|---|---|---|---|
| **Connector (catálogo)** | Definição padronizada de um provider: tipo de auth (OAuth2/API key/bot token/webhook-only), endpoints, capacidades, eventos que emite, esquema de config. **Código + linha em `connectors`.** | Global (plataforma) | Dezenas |
| **Connection** | Instância: a org X conectou o provider Y, com tokens cifrados e config. **1+ por (org × provider).** | Por org | Centenas |
| **Mapping** | Regra configurável que liga um conceito Stanbase a um recurso externo (tier→cargo Discord, perk→playlist YouTube). | Por connection | Milhares |
| **Inbound webhook** | Evento que chega do provider (pagamento, alguém saiu do servidor Discord) → verificado por assinatura → roteado. | Por connection | Alto |
| **Sync / Reconcile** | Aplicar a intenção (grant/revoke) no provider e periodicamente comparar estado desejado × real corrigindo drift. | Por connection | Alto |

> **Princípio de design:** o domínio **não conhece regra de negócio de membership** — ele recebe intenções (`{provider, action, member, external_ref}`) e as materializa no provider, OU recebe eventos do provider e os normaliza em eventos internos. Quem decide "esse membro merece o cargo" é `tiers-perks`; quem decide "esse pagamento ativa a assinatura" é `payments-billing`. O framework é o **encanamento confiável** entre os dois mundos.

#### 19.1.2 Taxonomia de connectors (capabilities)

Cada connector declara um conjunto de **capabilities** — isso determina quais peças do framework ele usa e quais telas/mapeamentos aparecem:

| Capability | Significa | Exemplos |
|---|---|---|
| `identity` | Login social / verificação de identidade (consome Auth) | Google, Apple, X |
| `niche_verify` | Conectar conta externa e ler atributo de prova (gamertag, horas de jogo, modelo) | Steam, Riot, APIs do nicho |
| `channel_sync` | Conceder/revogar acesso a canal/cargo/grupo | Discord (role), Telegram (group), WhatsApp (grupo) |
| `content_access` | Liberar/revogar acesso a conteúdo gated | YouTube (membership level), Twitch (sub), Vimeo |
| `event_import` | Importar/sincronizar eventos e ingressos | Sympla, Ingresse |
| `payments` | Cobrança, split, payout | Asaas |
| `wallet` | Emissão/atualização de passe | Apple Wallet, Google Wallet |
| `automation` | Triggers/actions genéricos | Zapier, Make, webhooks de saída |

> Um connector pode ter **múltiplas capabilities** (ex.: Discord = `identity` + `channel_sync`; Twitch = `identity` + `content_access`). O catálogo é a fonte da verdade de "o que sabemos fazer".

#### 19.1.3 Tipos de auth e como cada um guarda credencial

| Auth type | Fluxo | O que guardamos (cifrado) | Quem usa |
|---|---|---|---|
| **OAuth2 authorization code** | Org/admin autoriza no provider; recebemos `access_token` + `refresh_token` | `access_token`, `refresh_token`, `expires_at`, `scope` | Discord (bot+user), Google, YouTube, Twitch |
| **OAuth2 client-credentials** | Server-to-server, sem usuário | `access_token` curto, renovado on-demand | APIs de nicho server-side |
| **API key / bot token** | Org cola uma chave/token gerado no painel do provider | `api_key` opaca | Asaas, Telegram bot, alguns nicho |
| **OpenID Connect (identity)** | Login do membro (não da org) | nada persistido além do vínculo de identidade (consome Auth §06) | Google/Apple/X login |
| **Webhook-only** | Só recebe eventos, sem credencial outbound | `signing_secret` para verificar HMAC | provider que só notifica |
| **Connect-on-demand** | Connector ainda não existe → solicitação | nenhuma (estado de pedido) | "a gente conecta pra você" |

> **Segredos crus nunca em coluna em claro.** `connections.credentials` é cifrado (Supabase Vault / pgsodium ou referência a secret manager — convenção da fundação §25.6). O front recebe apenas **status e metadados** (provider, scopes, expira_em, conta externa vinculada), nunca o token.

#### 19.1.4 Máquina de estados — Connection

```
                     install (escolhe connector no catálogo)
                              │
                              ▼
            ┌──────────► pending_auth ──authorize──► connected ──────────┐
            │                 │ (timeout/cancelou)        │               │
            │                 ▼                           │ token_expired │ health_check fail
            │             failed_auth                     ▼               ▼
            │                                       refreshing       degraded
            │                                          │ ok             │ recovers
            │                                          └────────────────┤
            │                                                           ▼
   reauth (admin reconecta) ◄──── revoked_by_provider ◄──── connected ──┘
            │                          ▲                       │
            └──────────────────────────┘                       │ disable (admin/org)
                                                                ▼
                                                            disabled
```

Estados e regras concretas:

- **`pending_auth`** — connection criada, aguardando o admin completar OAuth (ou colar API key). Tem TTL (ex.: 30 min) no caso OAuth (o `state` expira). Timeout → `failed_auth`.
- **`connected`** — credencial válida, health-check passou. É o único estado em que syncs e webhooks-out rodam normalmente.
- **`refreshing`** — `access_token` expirou; o framework está trocando pelo `refresh_token`. **Estado transitório, não bloqueia leituras** — uma chamada que pega o token expirado dispara o refresh e re-tenta (ver §19.1.6).
- **`degraded`** — health-check ou chamadas reais começaram a falhar (provider fora do ar, rate-limit persistente, erro 5xx repetido). Syncs vão para a fila com backoff; o admin vê um banner "Integração instável". **Não revoga acessos do membro** (princípio: falha externa não tira direito — herdado de §09 §1.6).
- **`token_expired`** — refresh falhou (refresh_token também inválido/expirado). Precisa de reauth manual. Syncs ficam **enfileirados/pausados**, não descartados.
- **`revoked_by_provider`** — o provider invalidou o acesso (membro/admin desautorizou o app no Discord, key revogada no Asaas, OAuth app desinstalado). Detectado por 401/403 consistente ou por webhook do provider. Syncs pausam; admin é notificado para reconectar.
- **`disabled`** — org/admin desligou a integração de propósito. Mapeamentos preservados (para reativar depois), mas nenhum sync roda.

> **Transição crítica:** distinguir `degraded` (instabilidade temporária, auto-recupera) de `revoked_by_provider`/`token_expired` (precisa ação humana). Mapear errado = ou spammar o admin com falsos alarmes, ou deixar a integração morta em silêncio. Heurística: 401/403 consistente após refresh válido ⇒ revogação; 5xx/timeout/429 ⇒ degraded com retry.

#### 19.1.5 Máquina de estados — Sync Job (a unidade de trabalho de saída)

Sync job = "aplicar UMA intenção em UM provider para UM membro". Vive em pgmq + tabela de estado:

```
queued → processing → succeeded
            │
            ├→ retry_scheduled (falha transitória: 429/5xx/timeout) → processing
            │        │ (excedeu max_attempts)
            │        ▼
            ├──────► dead_letter (DLQ — precisa intervenção/reconcile)
            │
            └→ skipped (no-op: já estava no estado desejado / mapping ausente)
```

- **Idempotência:** cada job carrega `dedupe_key = hash(connection_id, member_external_id, target_external_ref, action)`. Reprocessar o mesmo job converge ao mesmo estado (atribuir cargo que já existe = `skipped`).
- **Backoff:** exponencial com jitter; respeita `Retry-After` em 429. `max_attempts` configurável por connector (ex.: 5).
- **DLQ:** após esgotar tentativas, vai para dead-letter com o erro; o **reconcile cron** (§19.1.9) é a rede de segurança que o reprocessa depois. Admin pode dar **replay manual**.
- **Falha não derruba direito:** se o sync falha, o `entitlement` (em §09) permanece `active`; só o `connection_sync_state` daquele provider fica `failed`. O membro tem o direito; o provider só ainda não refletiu.

#### 19.1.6 Fluxo passo a passo — conectar uma integração OAuth (ex.: Discord)

1. Admin abre **Integrações**, escolhe "Discord" no catálogo, clica **Conectar**.
2. Edge `POST /v1/integrations/discord/connect` cria `connection` (`pending_auth`), gera `state` (CSRF, ligado a `org_id` + `user_id`, com TTL), monta a **authorization URL** com os scopes mínimos necessários (`bot`, `guilds`, `guilds.members.read`).
3. Admin é redirecionado ao Discord, autoriza, Discord redireciona para `GET /v1/integrations/oauth/callback?code=&state=`.
4. Edge valida `state` (existe, não expirou, casa com a connection), troca `code` por `access_token`+`refresh_token` no token endpoint, **cifra e persiste** em `connections.credentials`, captura a conta externa vinculada (guild id, nome do servidor), roda **health-check** (lista guilds/cargos), seta `connected`.
5. UI mostra "Conectado a [Servidor X]" + abre a tela de **Mapeamentos** (tier → cargo).
6. A partir daí, qualquer `entitlement_sync_job` para esse provider é processável.

#### 19.1.7 Fluxo passo a passo — refresh de token expirado (sob demanda + proativo)

Dois caminhos, ambos necessários:

- **Sob demanda (lazy):** worker pega o token, percebe `expires_at <= now + skew` (skew ~60s), entra em `refreshing`, chama o refresh endpoint, atualiza credencial, **re-tenta a chamada original**. Se o refresh devolve 400/`invalid_grant` → `token_expired` (refresh morreu) → notifica admin + pausa fila.
- **Proativo (cron):** `connection-token-refresh-cron` varre connections com `expires_at` próximo (ex.: < 24h) e renova **antes** de qualquer job precisar — evita o primeiro job do dia falhar. Importante para providers com refresh_token rotativo (Google rotaciona o refresh_token a cada uso; precisa persistir o novo).
- **Lock de refresh:** dois workers não podem refrescar a mesma connection ao mesmo tempo (corrida que invalida o refresh_token rotativo). Usar advisory lock por `connection_id` ou `UPDATE ... WHERE status <> 'refreshing' RETURNING`.

#### 19.1.8 Fluxo passo a passo — webhook de entrada (verificação de assinatura)

Genérico, parametrizado por connector. Rota única `POST /v1/integrations/webhooks/{provider}/{connection_id?}`:

1. **Recebe o raw body** (não parsear antes de verificar — a assinatura é sobre os bytes crus).
2. **Identifica a connection** (por `connection_id` na rota, ou por header/payload do provider mapeado para uma connection).
3. **Verifica a assinatura** conforme o esquema do connector:
   - Asaas → token compartilhado em header (`asaas-access-token`) comparado em tempo constante.
   - Discord → Ed25519 (`X-Signature-Ed25519` + `X-Signature-Timestamp`) sobre `timestamp+body`.
   - HMAC genérico → `HMAC-SHA256(secret, body)` comparado em tempo constante; rejeita se timestamp fora da janela (anti-replay, ex.: ±5 min).
4. **Dedupe** pelo `event_id` do provider (tabela `inbound_events` com unique) — webhooks reentram; processar 1x.
5. **Persiste o evento cru** (`inbound_events`, status `received`) ANTES de processar — garante durabilidade e replay.
6. **Responde 2xx rápido** (provider exige resposta em poucos segundos) e processa **assíncrono** (enfileira em pgmq).
7. Worker normaliza o evento e o roteia ao domínio dono: pagamento → `payments-billing` (`resolveEntitlements`); "membro saiu do Discord" → marca drift para `reconcile`; "import de evento" → `events-tickets`.

> **Assinatura inválida ⇒ 401 e descarta** (não enfileira). **Connection não encontrada ⇒ 404.** **Replay (event_id repetido) ⇒ 200 idempotente** (já processado, não reprocessa).

#### 19.1.9 Fluxo passo a passo — reconciliação (a rede de segurança)

Webhooks **se perdem** e syncs **falham silenciosamente** (drift). O reconcile é a fonte da verdade periódica:

1. `integration-reconcile-cron` roda por connection (frequência por capability — ver Open Questions; sugestão: `channel_sync` a cada 1–6h, `payments` diário).
2. **Estado desejado** = entitlements `active` que mapeiam para aquele provider (de §09) + assinaturas ativas (de §10).
3. **Estado real** = lê do provider (membros do servidor + cargos no Discord; status de cobranças no Asaas).
4. **Diff e correção:**
   - desejado-mas-ausente → enfileira `grant` (ex.: membro deveria ter cargo e não tem — alguém removeu manualmente).
   - presente-mas-não-desejado → enfileira `revoke` (cargo concedido por nós que não deveria existir mais).
   - presente-e-desejado → no-op.
5. **Fonte da verdade é a Stanbase** (recomendação): em conflito, o estado da Stanbase manda. Exceto recursos não geridos por nós (cargos manuais que nunca mapeamos — não tocar; só reconciliar o que está sob mapeamento Stanbase).
6. Registra resultado em `reconcile_runs` (contadores: drift detectado, corrigido, falhas) para observabilidade (§27).

#### 19.1.10 Fluxo — "não vê sua ferramenta? a gente conecta"

A postura de produto vira um fluxo concreto, não só copy:

1. Catálogo tem entrada **"Solicitar integração"** (e busca; se o provider não está no catálogo, oferece o pedido).
2. Admin descreve a ferramenta (nome, URL, caso de uso) → `POST /v1/integrations/requests`.
3. Cria `connector_requests` (status `requested`), notifica o time Stanbase (superadmin), e o admin pode **votar/acompanhar** o status (`requested → evaluating → building → available → declined`).
4. Quando o connector entra no catálogo (`connectors.status=available`), os solicitantes são notificados e podem conectar.
5. Para o caso genérico imediato: **Webhooks de saída + Zapier/Make** (capability `automation`) cobrem "qualquer ferramenta com Zapier" sem esperar connector dedicado — é o fallback universal.

#### 19.1.11 Versionamento da API externa e credenciais por ambiente

- **Versão do provider:** cada connector declara a **versão da API externa** que suporta (`connectors.api_version`, ex.: Discord API v10, Asaas v3, Google Wallet v1). Chamadas fixam a versão (não "latest") para não quebrar quando o provider evolui.
- **Deprecação:** quando o provider anuncia sunset de uma versão, criamos um **novo connector/versão** e migramos connections gradualmente; o estado `degraded` + alerta de deprecação avisa o admin se a versão velha for desligada antes da migração.
- **Credenciais por ambiente:** OAuth apps e API keys são **diferentes por ambiente** (dev/staging/prod têm client_id/secret e webhooks distintos — §28.2). A connection guarda `environment` implícito pelo projeto Supabase; os **segredos de app** (client_id/secret do OAuth app da Stanbase) vivem em secrets de Edge por ambiente. **Nunca** usar credencial de prod em staging (redirect URIs e webhooks divergem; mistura quebra OAuth callback).

---

### 19.2 Modelo de dados

Todas as tabelas de instância carregam `org_id` e RLS por `org_id`. `connectors` é **global** (catálogo de plataforma, sem `org_id`, RLS só leitura para orgs).

#### 19.2.1 Catálogo (global)

**`connectors`** (catálogo de plataforma — fonte da verdade do "o que sabemos conectar")
| Coluna | Tipo | Nota |
|---|---|---|
| `id` | text PK | slug estável: `discord`, `asaas`, `youtube`, `steam`… |
| `name`, `description`, `icon_url` | text | exibição no catálogo |
| `capabilities` | text[] | `{identity, channel_sync, content_access, ...}` |
| `auth_type` | enum `connector_auth` | `oauth2_code\|oauth2_cc\|api_key\|oidc\|webhook_only\|connect_on_demand` |
| `auth_config` | jsonb | endpoints (authorize/token/refresh), scopes default, esquema de signature de webhook |
| `config_schema` | jsonb | JSON Schema da config da connection (valida input do admin) |
| `mapping_kinds` | text[] | tipos de mapping suportados: `tier_to_role`, `perk_to_playlist`, `tier_to_group`… |
| `emits_events` | text[] | eventos de webhook-in que o provider manda |
| `api_version` | text | versão fixada da API externa |
| `status` | enum | `available\|beta\|deprecated\|coming_soon` |
| `min_plan` / `is_free` | — | §20 diz **todas grátis**; campo reservado, default grátis |

#### 19.2.2 Connections e credenciais

**`connections`** (estende §25.6 — `id`, `org_id`, `provider`, `credentials` cifrado, `status`)
| Coluna | Tipo | Nota |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK | RLS |
| `connector_id` | text FK → `connectors.id` | |
| `display_name` | text | "Servidor FURIA", "Conta Asaas FURIA" |
| `status` | enum `connection_status` | `pending_auth\|connected\|refreshing\|degraded\|token_expired\|revoked_by_provider\|disabled\|failed_auth` |
| `credentials` | bytea / jsonb cifrado | tokens cifrados (Vault/pgsodium) — **nunca** em claro; ou `credentials_ref` se secret manager externo |
| `external_account` | jsonb | id/nome da conta externa (guild_id, asaas_account_id, channel_id) |
| `scopes` | text[] | escopos concedidos |
| `token_expires_at` | timestamptz null | p/ refresh proativo |
| `config` | jsonb | config validada contra `connector.config_schema` |
| `health` | jsonb | último health-check: `{ok, checked_at, latency_ms, error}` |
| `last_synced_at` | timestamptz null | |
| `created_by` | uuid | admin que conectou (audit) |
| `created_at`/`updated_at` | timestamptz | |

Constraints/índices:
- `UNIQUE (org_id, connector_id, external_account->>'id')` — evita conectar o mesmo servidor duas vezes; mas **permite** múltiplas connections do mesmo connector com contas externas distintas (ex.: dois servidores Discord — Open Question se 1 org pode ter N do mesmo provider).
- Índice `idx_conn_org_status (org_id, status)`.
- Índice parcial `idx_conn_refresh (token_expires_at) WHERE status='connected' AND token_expires_at IS NOT NULL` — cron de refresh proativo.

> **Segredo:** a coluna `credentials` é cifrada em repouso. Helper `loadCredentials(connection_id)` só roda em Edge Function (service role); decifra, devolve em memória, nunca loga. RLS impede o front de sequer ler a coluna (policy expõe view sem `credentials`).

#### 19.2.3 Mapeamentos

**`integration_mappings`** (configuração tier→cargo, perk→playlist etc.)
| Coluna | Tipo | Nota |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid | RLS |
| `connection_id` | uuid FK | |
| `kind` | enum `mapping_kind` | `tier_to_role`, `perk_to_playlist`, `tier_to_group`, `perk_to_content`, `niche_attr_to_perk`… |
| `source_type` | text | `tier` \| `perk` |
| `source_id` | uuid | tier_id ou perk_id (Stanbase side) |
| `target_external_ref` | text | role_id / playlist_id / group_id (provider side) |
| `target_label` | text | nome legível ("Cargo VIP") cacheado p/ UI |
| `direction` | enum | `outbound` (Stanbase→provider) \| `inbound` (provider→Stanbase) \| `both` |
| `status` | enum | `active\|paused\|broken` (broken = target_external_ref sumiu no provider) |

Constraints:
- `UNIQUE (connection_id, kind, source_id, target_external_ref)`.
- Índice `(connection_id, source_id)` para lookup rápido no resolver.
- `status='broken'` quando o reconcile detecta que o `target_external_ref` não existe mais no provider (cargo deletado no Discord) → admin precisa remapear.

#### 19.2.4 Execução: jobs, estado de sync, eventos de entrada

**`connection_sync_state`** (estado por intenção; estende o contrato de §09 `entitlement_sync_state`)
| `id`, `org_id`, `connection_id` FK, `member_id` null, `mapping_id` null, `action` (`grant`\|`revoke`\|`upsert`), `target_external_ref`, `dedupe_key` (unique), `status` (`queued\|processing\|succeeded\|retry_scheduled\|dead_letter\|skipped`), `attempts`, `next_attempt_at`, `last_error`, `updated_at` |
- `UNIQUE (dedupe_key)` — idempotência.
- Índice `(status, next_attempt_at)` para o worker pegar prontos.
- A **fila** de fato é pgmq (`integration_sync_q`); esta tabela é o **estado durável/auditável** espelhado.

**`inbound_events`** (webhooks recebidos — durabilidade + dedupe + replay)
| `id`, `org_id` null, `connector_id`, `connection_id` null, `provider_event_id` (unique por connector), `event_type`, `signature_valid` bool, `raw_payload` jsonb, `headers` jsonb, `status` (`received\|verified\|processing\|processed\|failed\|discarded`), `received_at`, `processed_at`, `error` |
- `UNIQUE (connector_id, provider_event_id)` — dedupe de reentrega.
- Índice `(status, received_at)` para retomar não processados.
- Retenção configurável (LGPD): payloads crus podem conter PII → TTL de expurgo (§26).

**`reconcile_runs`** (auditoria de reconciliação)
| `id`, `org_id`, `connection_id`, `started_at`, `finished_at`, `desired_count`, `actual_count`, `drift_detected`, `corrected`, `failed`, `status` (`running\|ok\|partial\|failed`), `summary` jsonb |

**`connector_requests`** ("a gente conecta pra você")
| `id`, `org_id`, `requested_by`, `tool_name`, `tool_url`, `use_case`, `status` (`requested\|evaluating\|building\|available\|declined`), `votes` int, `connector_id` null (preenche quando vira connector), `created_at` |

#### 19.2.5 Tabelas de outros domínios tocadas

- **`audit_logs`** (§25.6): toda conexão/desconexão/remapeamento/replay é auditada (`actor`, `action=connection.connected`, `target=connection_id`).
- **`entitlements` / `entitlement_sync_state`** (§09): este domínio é o **consumidor** das `entitlement_sync_jobs`; o `connection_sync_state` materializa o resultado por provider. Convergência de nomenclatura: §09 enfileira a intenção, §19 a executa.
- **`webhooks` / `webhook_deliveries`** (§22, webhooks de **saída**): a normalização de eventos de entrada pode **disparar** webhooks de saída da org (ex.: `member.left_discord`). São domínios irmãos: §22 é out, §19 é in (+ executa o adapter pattern de connectors).
- **Identidade de membro (§07/§06):** connectors `niche_verify`/`identity` gravam o vínculo da conta externa na identidade do membro (ver §19.5).

---

### 19.3 API & Edge Functions

#### 19.3.1 Endpoints `/v1` (REST pública — admin/headless; §21)

**Catálogo & connections**
```
GET    /v1/integrations/catalog                      # connectors disponíveis (capabilities, auth_type, status)
GET    /v1/integrations                              # connections da org (status, conta externa, health)
GET    /v1/integrations/{id}                         # detalhe de uma connection (sem credenciais)
POST   /v1/integrations/{provider}/connect           # inicia conexão: OAuth URL ou aceita api_key
GET    /v1/integrations/oauth/callback               # callback OAuth (state, code) -> troca token
POST   /v1/integrations/{id}/reauth                  # reconectar (token_expired/revoked)
POST   /v1/integrations/{id}/test                    # health-check on-demand
POST   /v1/integrations/{id}/disable                 # desliga (preserva mappings)
DELETE /v1/integrations/{id}                         # remove connection + revoga tokens no provider
```

**Mapeamentos**
```
GET    /v1/integrations/{id}/mappings                # listar mappings da connection
POST   /v1/integrations/{id}/mappings                # criar (tier->role, perk->playlist...)
PATCH  /v1/integrations/{id}/mappings/{mid}
DELETE /v1/integrations/{id}/mappings/{mid}
GET    /v1/integrations/{id}/targets?kind=role       # lista recursos externos (cargos/playlists) p/ o seletor
```

**Sync, reconcile, observabilidade**
```
POST   /v1/integrations/{id}/sync                    # força resync completo da connection (admin)
GET    /v1/integrations/{id}/sync-state              # jobs pendentes/falhos/DLQ
POST   /v1/integrations/sync-state/{jobId}/replay    # replay manual de job em dead_letter
POST   /v1/integrations/{id}/reconcile               # dispara reconcile on-demand
GET    /v1/integrations/{id}/reconcile-runs          # histórico de reconciliações
```

**Webhooks de entrada (não autenticados por JWT — autenticados por assinatura)**
```
POST   /v1/integrations/webhooks/{provider}/{connectionId?}   # ingest genérico (verifica assinatura)
```

**"A gente conecta pra você"**
```
GET    /v1/integrations/requests
POST   /v1/integrations/requests                     # solicitar connector novo
POST   /v1/integrations/requests/{id}/vote
```

#### 19.3.2 Edge Functions / Jobs internos

| Função | Tipo | Descrição |
|---|---|---|
| `integration-oauth-start` | função | Monta authorize URL, cria `state` (CSRF, TTL), connection `pending_auth`. |
| `integration-oauth-callback` | função | Valida `state`, troca code→tokens, cifra/persiste, health-check, `connected`. |
| `integration-sync-worker` | consumer pgmq | Consome `integration_sync_q`, resolve connector adapter, aplica grant/revoke, grava `connection_sync_state`, backoff/DLQ. |
| `integration-webhook-ingest` | função | Verifica assinatura, dedupe (`inbound_events`), persiste cru, responde 2xx, enfileira processamento. |
| `integration-webhook-processor` | consumer pgmq | Normaliza evento de entrada e roteia ao domínio dono. |
| `connection-token-refresh-cron` | pg_cron | Refresh proativo de tokens próximos de expirar (rotaciona refresh_token quando aplicável). |
| `integration-reconcile-cron` | pg_cron | Drift detection desejado×real por connection, enfileira correções, grava `reconcile_runs`. |
| `connection-health-cron` | pg_cron | Ping periódico leve; atualiza `health`; promove a `degraded`/desce de `degraded`. |
| `inbound-events-reaper` | pg_cron | Expurga `inbound_events` antigos (retenção/LGPD); reprocessa `received` presos. |
| `connector-adapter-registry` | módulo (não job) | Registro de adapters por `connector_id`: cada um implementa `authorize/refresh/applySync/listTargets/verifyWebhook/reconcile`. |

> **Adapter pattern (núcleo de código):** cada connector é uma implementação da interface `ConnectorAdapter`. O framework é genérico; o adapter encapsula o que muda por provider (endpoints, assinatura, mapeamento de erro→`degraded`/`revoked`). Adicionar um connector = adicionar um adapter + linha no catálogo, **sem** tocar o encanamento.

---

### 19.4 Telas / Front

#### 19.4.1 Admin (painel padronizado §10.1 → módulo "Integrações")

- **Catálogo de integrações:** grid por capability/categoria (Conteúdo, Eventos, Identidade, Nicho, Canais, Automação, Pagamentos, Wallet), cada card com ícone, status (`available`/`beta`/`coming_soon`) e CTA **Conectar**. Busca. Card final **"Não encontrou? Solicitar integração"**.
- **Detalhe da connection:** status com badge colorido (conectado/instável/expirado/revogado), conta externa vinculada, scopes, "última sincronização", botões **Testar**, **Reconciliar**, **Reconectar**, **Desligar**, **Remover**. Banner de ação quando `token_expired`/`revoked_by_provider` ("Reconecte para retomar a sincronização").
- **Editor de mapeamentos:** lista de mappings com seletor de recurso externo carregado ao vivo (`GET .../targets`) — ex.: dropdown "Tier VIP → [cargo do Discord]". Aviso quando um mapping fica `broken` (recurso sumiu no provider) com CTA remapear.
- **Painel de saúde / sync:** jobs pendentes, falhos e em DLQ; botão **replay**; histórico de `reconcile_runs` com drift detectado/corrigido. (Dogfooding do §27.)
- **Solicitações de integração:** lista das solicitações da org com status e contador de votos.
- **Wizard de conexão (modal):** OAuth abre popup/redirect; API key tem campo + link "onde encontro minha chave"; ao concluir, leva direto para mapeamentos (onboarding "configure em minutos").

#### 19.4.2 Membro (front hosted temável §24.2)

- **Conectar contas (perfil do membro):** o membro conecta **suas** contas de identidade/nicho (Google/Apple/X login; Steam/Riot gamertag) → destrava perks de nicho. Cards "Conectar Steam", status conectado/desconectado, atributo lido ("12.345 h em CS2"). É o lado `niche_verify`/`identity` do framework, na ótica do membro.
- **Estado de pré-requisito de perk:** se um perk exige conta conectada (entitlement `pending_requirement` §09), a área do membro mostra "Conecte sua conta Steam para liberar este benefício".

> **Componente SDK (§24.3):** `<ConnectAccount provider="steam"/>` para o modo headless/embed.

---

### 19.5 Integrações externas

O framework **é** a camada de integração; aqui o mapeamento concreto connector→serviço e como cada um encaixa nas peças:

| Connector | Capability | Auth | Webhook-in | Sync outbound | Notas |
|---|---|---|---|---|---|
| **Discord** | identity + channel_sync | OAuth2 (bot+user) | Ed25519 (interactions/gateway events) | atribui/remove role por tier | reconcile compara membros×cargos do guild |
| **Telegram** | channel_sync | bot token | webhook bot (secret token) | invite/kick de grupo/canal | grupo privado por tier |
| **WhatsApp** | channel_sync | API Oficial (Cloud API/BSP) | HMAC | add/remove grupo/comunidade | decisão de produto: **API Oficial** (§30) |
| **YouTube** | identity + content_access | OAuth2 (Google) | PubSubHubbub/HMAC | libera/revoga acesso a playlist/membership level | refresh_token rotativo (cuidado §19.1.7) |
| **Twitch** | identity + content_access | OAuth2 | EventSub (HMAC + timestamp) | acesso a sub-only/VOD | |
| **Vimeo** | content_access | OAuth2/API key | — | signed URL / domain privacy | |
| **Sympla / Ingresse** | event_import | API key/OAuth | webhook de vendas | importa eventos/ingressos → §14 | mapeia ingresso externo → pass |
| **Google / Apple / X** | identity | OIDC (consome Auth §06) | — | — | login social + verificação de fã |
| **Steam / Riot** | niche_verify | OAuth/OpenID/API key | — | lê atributo (horas, rank, modelo) → resolve `pending_requirement` | atributo alimenta perk de nicho §09 §1.12 |
| **Asaas** | payments | API key | token compartilhado (header) | split/payout (executado por §10) | §19 fornece o **padrão de Connection cifrada**; a lógica financeira é §10 |
| **Apple / Google Wallet** | wallet | cert/SA JWT | APNs/REST | emite/atualiza passe (executado por §08/§11) | §19 padroniza credencial/refresh; emissão é passport |
| **Zapier / Make** | automation | API key/OAuth | — | triggers/actions sobre a API §22 | **fallback universal** "qualquer ferramenta" |

> **Fronteira clara:** Asaas e Wallet **usam o padrão de Connection/credencial cifrada deste domínio**, mas a regra de negócio (split, juros, emissão de passe, push) vive em `payments-billing` (§10) e `passport` (§11). O framework não duplica essa lógica — fornece o encanamento (auth, refresh, health, webhook-in verificado).

---

### 19.6 Épicos & tarefas

#### Épico A — Catálogo & modelo de dados
- A1 (M) Migration `connectors` (catálogo global) + enums (`connector_auth`, capabilities) + seed inicial (Discord, Asaas, YouTube, Steam, Sympla…).
- A2 (M) Migration `connections` estendida (status, credentials cifrado, external_account, scopes, token_expires_at, config, health) + índices + RLS por org + view sem credenciais.
- A3 (S) Migration `integration_mappings` (kind, source/target, direction, status) + unique/índices.
- A4 (M) Migration `connection_sync_state` + `inbound_events` (dedupe unique) + `reconcile_runs` + `connector_requests`.
- A5 (M) Cifragem de `credentials` (Vault/pgsodium) + helper `loadCredentials`/`storeCredentials` (só Edge, nunca loga) + rotação.
- A6 (S) RLS + testes de isolamento; garantir que front nunca lê `credentials`.

#### Épico B — Adapter framework (núcleo de código)
- B1 (L) Interface `ConnectorAdapter` (`authorize/refresh/applySync/listTargets/verifyWebhook/reconcile/healthCheck`) + registry por `connector_id`.
- B2 (M) Máquina de estados da Connection (transições + guards) + mapeamento de erro→`degraded`/`token_expired`/`revoked_by_provider`.
- B3 (M) `connection-health-cron` + cálculo de `health` + promoção/rebaixa de `degraded`.

#### Épico C — OAuth & credenciais
- C1 (M) `integration-oauth-start`: authorize URL + `state` CSRF com TTL ligado a org/user.
- C2 (M) `integration-oauth-callback`: validação de state, troca code→tokens, cifra/persiste, captura conta externa, health-check.
- C3 (M) Refresh **sob demanda** (lazy) com re-tentativa da chamada original + lock anti-corrida.
- C4 (M) `connection-token-refresh-cron` proativo + tratamento de refresh_token **rotativo** (persistir o novo).
- C5 (S) Auth por **API key** (Asaas/Telegram): validação + cifragem.
- C6 (S) `reauth` (token_expired/revoked) + `disable` + `DELETE` com revogação de token no provider.

#### Épico D — Mapeamentos
- D1 (M) CRUD de `integration_mappings` + validação por `mapping_kind` suportado pelo connector.
- D2 (M) `GET .../targets`: lista recursos externos ao vivo (cargos/playlists/grupos) com cache curto.
- D3 (S) Detecção de mapping `broken` (target sumiu) no reconcile + sinal pra UI remapear.

#### Épico E — Sync outbound (executor de intenções)
- E1 (M) Fila pgmq `integration_sync_q` + `connection_sync_state` + `dedupe_key` idempotente.
- E2 (L) `integration-sync-worker`: consome, resolve adapter, grant/revoke, backoff/jitter, respeita `Retry-After`, DLQ.
- E3 (M) Consumir o contrato `entitlement_sync_jobs` de §09 (ponte tiers-perks → este worker).
- E4 (S) Ordem conceder-antes-revogar respeitada no upgrade (coordenação com §09 §1.6).
- E5 (S) Falha-parcial isolada: job falha não revoga entitlement; só `connection_sync_state=failed`.
- E6 (S) Replay manual de DLQ (`/sync-state/{jobId}/replay`).

#### Épico F — Webhooks de entrada
- F1 (M) Rota genérica `webhooks/{provider}/{connectionId?}` + leitura de raw body.
- F2 (M) Verificadores de assinatura por esquema: HMAC-SHA256 (tempo constante), Ed25519 (Discord), token compartilhado (Asaas) + anti-replay por timestamp.
- F3 (S) Dedupe por `provider_event_id` (`inbound_events` unique) + resposta 2xx rápida.
- F4 (M) `integration-webhook-processor`: normaliza e roteia ao domínio dono (payments/events/reconcile).
- F5 (S) `inbound-events-reaper` (retenção/LGPD) + reprocesso de presos.

#### Épico G — Reconciliação
- G1 (L) `integration-reconcile-cron` por capability: desejado×real, diff, enfileira correções, `reconcile_runs`.
- G2 (M) Política "Stanbase é fonte da verdade" + ignorar recursos não geridos (cargos manuais).
- G3 (S) Reconcile on-demand (`/reconcile`) + `GET reconcile-runs`.

#### Épico H — "A gente conecta pra você"
- H1 (S) `connector_requests` CRUD + voto + notificação ao superadmin.
- H2 (S) Estado do pedido (`requested→building→available`) + notificar solicitantes ao publicar.

#### Épico I — Telas
- I1 (M) Catálogo de integrações (grid por capability, status, CTA, busca, "solicitar").
- I2 (M) Detalhe da connection + ações (testar/reconectar/desligar/remover) + banners de estado.
- I3 (M) Editor de mapeamentos com seletor de targets ao vivo + aviso de broken.
- I4 (S) Painel de saúde/sync (DLQ, replay, reconcile runs).
- I5 (S) Front do membro: `<ConnectAccount>` (Steam/Riot/identidade) + estado de pré-requisito de perk.

#### Épico J — Observabilidade & segurança
- J1 (S) Métricas de sync (sucesso/falha/DLQ por connector), de webhook-in (válido/inválido/dedupe), reconcile drift → §27.
- J2 (S) Audit log de connect/disconnect/remap/replay/reauth.
- J3 (S) Alertas: connection `degraded`/`revoked` persistente, DLQ crescendo, refresh falhando.

---

### 19.7 Dependências

| Depende de | Por quê |
|---|---|
| **fundacao** | `connections` cifrada base (§25.6), RLS por org, pgmq/pg_cron, Vault/secret manager, Edge Functions, esqueleto `/v1`/OpenAPI, convenção de migrations. |
| **auth-rbac** | Permissão de admin para conectar/desconectar/remapear (ação sensível, escopo por org); reuso do padrão de escopo de org para credenciais; identidade social (Google/Apple/X) é capability `identity` que **consome** o Auth. |
| **tiers-perks** | Produz as intenções (`entitlement_sync_jobs`): este domínio **executa** os grants/revokes; mappings ligam tier/perk a recurso externo. Dependência bidirecional e crítica. |
| **member-identity** | Connectors `niche_verify`/`identity` gravam o vínculo da conta externa na identidade do membro; resolve `pending_requirement`. |
| **payments-billing** | Asaas usa o padrão de Connection cifrada + webhook-in verificado deste domínio; a lógica financeira (split/juros) vive lá. |
| **passport** | Apple/Google Wallet usam o padrão de credencial/refresh; emissão/push do passe vive lá. |
| **content-gating** | Connectors `content_access` (YouTube/Twitch/Vimeo) liberam/revogam VOD lendo entitlements. |
| **community-channels** | Connectors `channel_sync` (Discord/Telegram/WhatsApp) aplicam cargo/grupo. |
| **events-tickets** | Connectors `event_import` (Sympla/Ingresse) importam eventos/ingressos. |
| **webhooks** | Eventos de entrada normalizados podem disparar webhooks de **saída** (§22); domínios irmãos (in × out). |
| **superadmin** | Catálogo de connectors e fila de `connector_requests` são geridos pelo time Stanbase. |
| **security-lgpd** | Cifragem de credenciais, retenção de `inbound_events` com PII, DPA com sub-processadores. |
| **observability-qa** | Painel de saúde de syncs/webhooks/reconcile (§27). |
| **design-system / admin-app / member-app** | Catálogo, detalhe de connection, editor de mapeamentos, `<ConnectAccount>`. |

> Dependência mais crítica e bidirecional: **tiers-perks** (origem das intenções) — sem o framework, os syncs de §09 não saem do papel; sem §09, o framework não tem o que sincronizar de membership.

---

### 19.8 Riscos & decisões técnicas

1. **Token expira / refresh falha.** Refresh_token rotativo (Google) corrompe se dois workers refrescam em paralelo → invalida a sessão. Mitigação: lock por `connection_id`, persistir o novo refresh_token atomicamente, refresh proativo via cron, lazy refresh com re-tentativa. `invalid_grant` ⇒ `token_expired` + notifica admin (não descarta jobs).
2. **Revogação pelo provider.** Membro/admin desautoriza o app, key revogada. 401/403 **consistente após refresh válido** ⇒ `revoked_by_provider`. Distinguir de `degraded` (5xx/429) é o ponto mais delicado — errar gera falso alarme ou morte silenciosa. Heurística explícita + contadores de falha.
3. **Rate limit.** Providers limitam agressivamente (Discord, Google). Respeitar `Retry-After`, backoff com jitter, **agrupar** operações quando o provider suporta bulk, e enfileirar — nunca martelar. Reconcile pode gerar muitos jobs de uma vez → throttle por connection.
4. **Connector indisponível.** Provider fora do ar ⇒ `degraded`, jobs **enfileirados** (não perdidos), retry com backoff longo, reconcile recupera quando volta. **Falha externa nunca revoga direito do membro** (entitlement segue `active`).
5. **Versionamento da API externa.** Provider muda a API (sunset de versão) e quebra o connector. Fixar `api_version`, monitorar deprecações, criar novo connector/versão e migrar connections gradualmente. Alerta se a versão antiga for desligada antes da migração.
6. **Credenciais por ambiente.** OAuth app/redirect URI/webhook secret diferem por dev/staging/prod. Misturar quebra o callback. Segredos de app por ambiente (secrets de Edge), connection herda o ambiente do projeto Supabase. Testar OAuth em cada ambiente isoladamente.
7. **Verificação de assinatura mal feita = porta dos fundos.** Parsear antes de verificar, comparação não-constante (timing attack), aceitar sem timestamp (replay) — tudo crítico. Verificar sobre **raw body**, comparação em tempo constante, janela de timestamp, dedupe por `event_id`. Assinatura inválida ⇒ 401 + descarta.
8. **Drift (estado externo divergente).** Admin mexe no Discord manualmente; webhook se perde. Reconcile é a única defesa real. Decidir frequência por capability (custo de API vs. frescor) e que **Stanbase é fonte da verdade** — mas **não tocar** recursos fora dos mappings (cargos manuais alheios).
9. **Idempotência de webhook e de sync.** Providers reentregam; jobs reprocessam. `dedupe_key` (sync) e `provider_event_id` unique (webhook) são obrigatórios — sem eles, cargo concedido duas vezes/cobrança processada em duplicidade.
10. **PII em `inbound_events` (LGPD).** Payloads crus de webhook podem conter e-mail/nome. Retenção curta + expurgo (`inbound-events-reaper`), cifragem opcional do `raw_payload`, e DPA com cada sub-processador (§26).
11. **Resposta lenta de webhook = reentrega.** Providers exigem 2xx em segundos. Persistir cru + responder 2xx + processar assíncrono. Processar síncrono = timeouts e tempestade de reentregas.
12. **Múltiplas connections do mesmo provider.** 1 org com 2 servidores Discord? O modelo permite (unique inclui `external_account`), mas mappings e UI ficam ambíguos. **Decisão de produto** (Open Question) — recomendação: permitir, mas mapping é sempre por connection.
13. **Ordem grant-antes-revoke no upgrade** (herdado §09): janela sem acesso se invertido. O worker respeita a ordem que §09 enfileira.
14. **Connector na postura "a gente conecta" cria expectativa.** Sem SLA, vira dívida. Mitigação: Zapier/automation como fallback universal imediato; `connector_requests` com status transparente; priorização por votos.

---

### 19.9 Escopo MVP vs. depois

#### MVP (alinhado a §29 Fase 2 — "Integrações canais + conteúdo + eventos")
- **Núcleo do framework:** `connectors` (catálogo) + `connections` cifrada + adapter pattern + máquina de estados da Connection.
- **OAuth2 code + API key** com cifragem (Vault), refresh lazy + proativo, lock anti-corrida.
- **Mappings** tier→cargo (Discord) e perk→conteúdo (YouTube), com seletor de targets ao vivo.
- **Sync worker** (pgmq) consumindo o contrato `entitlement_sync_jobs` de §09: grant/revoke, backoff, DLQ, falha-parcial isolada, replay manual.
- **Webhook-in genérico** com verificação de assinatura (HMAC + Ed25519 Discord + token Asaas), dedupe, persistência crua, 2xx rápido + processamento assíncrono.
- **Reconcile básico** (channel_sync diário/horário) com `reconcile_runs`.
- **Connectors MVP:** **Discord** (channel_sync), **YouTube/Twitch** (content_access), **Sympla/Ingresse** (event_import), **identidade Google/Apple/X** (consome Auth), e o **padrão de Connection** que Asaas (§10) e Wallet (§11) reusam.
- **Catálogo + detalhe de connection + editor de mappings + "solicitar integração"** (telas).
- Observabilidade básica de sync/webhook (§27) + audit log.

#### Depois (Fases 3+)
- **Connectors de nicho** (`niche_verify`): Steam/Riot/APIs do nicho + resolução de `pending_requirement` (§09 §1.12) + `<ConnectAccount>` no front do membro.
- **WhatsApp** (API Oficial — aprovação de templates/BSP, §30) e Telegram completos.
- **Reconcile sofisticado** (por capability, throttle, dashboard de drift) + alertas avançados.
- **Múltiplas connections do mesmo provider** com UI desambiguada.
- **Versionamento/migração assistida** de connectors quando provider muda API.
- **Zapier/Make app oficial** publicado (capability `automation`) + fila de `connector_requests` operada com priorização por votos.
- **Bulk operations** e otimização de rate-limit por provider.
- **Vimeo** e connectors de conteúdo adicionais.
