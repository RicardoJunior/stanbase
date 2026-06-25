## 15. Comunidade & Canais

> **Domínio:** levar o estado de membership (tier ativo / entitlement) para fora da Stanbase, dentro dos canais onde a comunidade realmente vive — **Discord** (cargos por tier via bot/OAuth), **Telegram** (entrada/saída de grupos por tier) e **WhatsApp** (grupos/comunidades via API Oficial). O dono configura um **mapa "tier → cargo/grupo"**; a Stanbase mantém o acesso **continuamente sincronizado** (mudou tier → cargo na hora; cancelou → remove) + uma **reconciliação periódica** que corrige drift.
> **Fontes de verdade no STANBASE.md:** §16 (Comunidade e canais), §12.2/§12.3 (perk `channel`, entitlements), §20 + §20.1 (framework de integrações: Connection por org, mapeamentos, webhooks-in + reconcile), §25.5 (`channels`, `connections`), §26 (segredos cifrados, LGPD), §30 item 3 (WhatsApp = **API Oficial sempre**, decidido).
> **Decisões imutáveis aplicáveis:** **1 membership por org** → 1 tier ativo por membro por org (o mapa tier→cargo nunca precisa "somar" vários tiers do mesmo membro); várias bases = várias orgs (cada org tem sua própria Connection Discord/Telegram/WhatsApp); WhatsApp **API Oficial** (Cloud API/BSP), nunca não-oficial; segredos de integração **cifrados**, nunca no front.
> **Relação com tiers-perks:** este domínio é o **executor** do perk `type='channel'`. Quem decide *quem tem direito* é o resolver de entitlements (§09). Este domínio **não decide acesso** — ele **materializa** o entitlement de canal no provider externo. A fronteira é: tiers-perks **enfileira intenções** (`entitlement_sync_jobs` com `provider ∈ {discord, telegram, whatsapp}`); este domínio **consome e aplica**.

---

### 1. Como funciona

#### 1.1 Separação de responsabilidades (a fronteira que evita acoplamento)

- **tiers-perks (§09)** é dono do *direito*: "membro X tem entitlement de canal (perk `channel`) ativo/revogado". Produz **deltas** (`grant`/`revoke`) numa fila.
- **community-channels (este domínio)** é dono da *materialização*: pega o delta, descobre **qual cargo/grupo** corresponde àquele perk naquela Connection, chama a API do provider, grava o resultado e mantém o estado real ↔ desejado convergente.
- **integrations-framework** fornece a **infra comum**: `connections` (OAuth/token cifrado, refresh, status), o catálogo de connectors, o worker/DLQ genérico, o webhook-in router. Este domínio **implementa os três connectors concretos** (Discord/Telegram/WhatsApp) sobre essa infra.

> **Por que essa fronteira importa:** se Discord cai, o membro **não perde o direito** (o entitlement segue `active`); só o `channel_link` daquele provider fica `failed` e entra em retry/reconcile. O acesso ao conteúdo gated, passport etc. continua intacto. Falha de canal externo nunca rebaixa o membership.

#### 1.2 O artefato central: `channel_link` (o vínculo membro × canal externo)

Para cada par (membro, perk de canal aplicável ao tier dele), existe **no máximo um** `channel_link` por provider — a linha que representa "este membro deveria estar com o cargo R / no grupo G". É o espelho local do estado externo. Estados (máquina de estados abaixo) e a reconciliação operam sobre `channel_link`, não sobre o entitlement diretamente.

#### 1.3 Mapa "tier → cargo/grupo" (configuração do admin)

Configurado como `config` do perk `channel` (§09 §2.3) **e/ou** como linhas de `channel_mappings` (forma normalizada, recomendada — ver §2). Cada mapping diz:

```
(connection_id, provider) + (alvo: tier_id OU perk_id) → recurso externo
  • Discord:  role_id  (dentro de um guild_id específico da connection)
  • Telegram: chat_id   (grupo/canal; modo invite-link OU add-direto)
  • WhatsApp: group_id / community_id (via API Oficial)
```

Regras concretas do mapa:
- Um tier pode mapear para **N recursos** (ex.: tier "VIP" → cargo Discord `@VIP` + grupo Telegram "VIPs" + cargo Discord `@Apoiador` herdado). Um recurso pode ser alvo de **N tiers** (ex.: cargo `@Membro` vale para todos os tiers pagos).
- **Acúmulo por hierarquia (decisão de produto — ver Open Questions):** se "VIP" deve *também* receber os cargos de "Membro", o admin define isso explicitamente no mapa (mapping aditivo) — a Stanbase **não infere hierarquia** de `tiers.position` por padrão. Recomendação: oferecer toggle "tiers superiores herdam cargos dos inferiores" que expande o mapa no resolver.
- **Múltiplos servidores Discord (multi-guild):** uma Connection Discord = **um bot token**, mas pode ter **N guilds** onde o bot está. Cada mapping carrega `guild_id`. Um tier pode dar cargo no Guild A e no Guild B. O sync itera por todos os mappings daquele tier, em todos os guilds.
- **Múltiplos canais por provider:** Telegram/WhatsApp idem — um tier pode dar acesso a vários grupos.

#### 1.4 Vínculo de conta externa do membro (identity linking) — o pré-requisito de tudo

Para atribuir um cargo no Discord eu preciso saber **qual usuário Discord** é aquele membro. Isso exige um **vínculo explícito** membro ↔ conta externa, armazenado em `member_channel_identities`:

| Provider | Como o membro vincula | Identificador externo guardado |
|---|---|---|
| **Discord** | OAuth2 (`identify guilds.join`) na área do membro → "Conectar Discord" | `discord_user_id` (snowflake) + `discord_username` |
| **Telegram** | Login Widget / deep-link `t.me/<bot>?start=<nonce>` → membro fala com o bot → bot captura `telegram_user_id` | `telegram_user_id` + `username` |
| **WhatsApp** | número de telefone do `member_profiles.phone` (E.164), confirmado (idealmente via opt-in/template) | `wa_phone` (E.164) |

> **Edge case central — conta não vinculada:** se o membro tem direito a um canal mas **não vinculou** a conta daquele provider, o `channel_link` nasce `pending_link` (não é `failed`). A UI do membro mostra um CTA persistente "Conecte seu Discord para receber seu cargo de VIP". Nada falha; o entitlement segue ativo; assim que vincular, o resolver/sync materializa o cargo. **Não** tratar conta-não-vinculada como erro de sync.

#### 1.5 Discord — entrada do membro no servidor (3 cenários)

Atribuir um cargo exige que o usuário **já seja membro do guild**. Três cenários:

1. **Membro já está no guild** (caso comum em comunidades existentes): bot só faz `PUT /guilds/{guild}/members/{user}/roles/{role}` (add role). Direto.
2. **Membro vinculou Discord mas não está no guild:** usar o escopo OAuth **`guilds.join`** → `PUT /guilds/{guild}/members/{user}` com `access_token` para **adicionar o usuário ao servidor já com o(s) cargo(s)**. Requer que o membro tenha autorizado `guilds.join` no OAuth e que o bot tenha permissão `CREATE_INSTANT_INVITE`/`MANAGE_MEMBERS`.
3. **Membro não quer/não pode entrar automaticamente:** fallback para **invite link** (gera convite e mostra; ao entrar, um evento `GUILD_MEMBER_ADD` dispara a aplicação do cargo). Necessário quando `guilds.join` não foi concedido.

#### 1.6 Máquina de estados — `channel_link`

```
                      (entitlement channel ativo + mapping existe)
                                     │
                                     ▼
        conta vinculada? ──NÃO──► pending_link ──(membro vincula)──┐
                                     │ (CTA na área do membro)      │
                                     SIM                            │
                                     ▼                              ▼
                              ┌── queued ───(worker pega)──► syncing ──ok──► active
                              │     ▲                            │
   (delta grant)─────────────┘     │ retry/backoff              │ erro recuperável
                                    └────────────────────────────┤ (rate limit, 5xx)
                                                                  │ erro permanente
                                                                  ▼
                                                               failed ──(reconcile/retry)──► queued
   (delta revoke / cancelou / downgrade)
                                     │
                                     ▼
                              revoking ──ok──► removed  (cargo removido / saiu do grupo)
                                     │
                                     └─erro──► failed_revoke ──(reconcile)──► revoking

   estados terminais especiais:
     • left_manually  — membro saiu do Discord/grupo por conta própria (detectado por evento ou reconcile)
     • banned         — membro foi banido do guild/grupo (não dá pra re-adicionar; vira terminal sinalizado)
     • unlinked       — membro desvinculou a conta externa
```

Detalhe de cada estado:
- `pending_link` — tem direito, falta vincular conta. **Não é erro.** Aguarda ação do membro.
- `queued` — delta enfileirado, aguardando worker.
- `syncing` / `revoking` — chamada à API em andamento (lock lógico para idempotência).
- `active` — cargo/grupo aplicado e confirmado.
- `removed` — acesso retirado com sucesso (downgrade/cancel). Terminal "saudável".
- `failed` / `failed_revoke` — erro ao aplicar/remover; entra em retry e é alvo do reconcile.
- `left_manually` — membro **saiu sozinho** do servidor/grupo embora tenha direito. Ver §1.9.
- `banned` — membro **banido** pelo dono/mods no provider. Ver §1.10.
- `unlinked` — membro removeu o vínculo OAuth/conta. Volta para `pending_link` se ainda tiver direito.

#### 1.7 Fluxo: mudou de tier → cargos na hora (sincronização contínua / push)

Disparado por `member.tier_changed` (vindo do resolver de entitlements de §09, que por sua vez vem do webhook Asaas / change-tier):

1. Resolver de entitlements computa o **diff de perks de canal**: perks `channel` ganhos vs perdidos.
2. Para cada delta, enfileira `entitlement_sync_jobs {member_id, perk_id, action, provider}` (já existe em §09) — **mas para canais, este domínio expande** o perk → conjunto de `channel_mappings` concretos (cargo/grupo) e cria/atualiza `channel_link` por recurso.
3. **Ordem fixa: conceder-antes-revogar** (herdado de §09 §1.6) — primeiro adiciona cargos do tier novo, depois remove os do tier antigo. Evita janela onde o VIP recém-promovido fica sem nenhum cargo.
4. Worker consome, resolve a conta externa do membro (`member_channel_identities`):
   - **Sem vínculo** → `channel_link = pending_link`, fim (sem erro).
   - **Com vínculo** → chama a API (Discord add role / Telegram add ou invite / WhatsApp add participant), grava `active` ou `failed`.
5. Registra em `interactions` (timeline CRM): "entrou no canal X" / "saiu do canal Y" (§11.2 "entradas em canais").
6. Passport não é afetado por canais (é afetado por tier, domínio §11), mas a mudança de tier que originou tudo já disparou o push lá.

> **Latência-alvo:** "na hora" = segundos. O worker é acionado por enqueue (pgmq) + trigger, não por cron. Cron é só reconcile/backstop.

#### 1.8 Fluxo: cancelou / expirou → remove acesso

Disparado por `member.churned` / `subscription.payment_failed` (após grace, §13.4) / downgrade que remove o perk:
1. Resolver revoga o entitlement de canal → delta `revoke`.
2. Worker entra em `revoking`: Discord remove role (`DELETE .../roles/{role}`); Telegram `banChatMember` + `unbanChatMember` (kick "limpo" sem ban permanente) ou revoga invite-link de uso único; WhatsApp `removeParticipant`.
3. **Grace period respeitado:** a remoção só dispara quando o entitlement de fato vai a `suspended`/`revoked` (a política de grace vive em billing/§09). Este domínio **não** implementa grace próprio — ele reage ao estado do entitlement. Se o membro está em `suspended` (inadimplente em grace), o produto decide se já remove ou aguarda (Open Questions).
4. `channel_link → removed`. Registra na timeline.

> **Telegram kick sem ban:** usar `banChatMember` seguido imediatamente de `unbanChatMember` remove o usuário **sem** bloqueá-lo para sempre — assim ele pode voltar se reassinar. Banir de verdade impediria re-entrada. Importante distinguir kick-por-downgrade (reversível) de ban-por-conduta (do dono, irreversível pela Stanbase).

#### 1.9 Edge case: membro sai do Discord/grupo manualmente (tem direito mas não está lá)

- Detectado por **evento** (Discord `GUILD_MEMBER_REMOVE` via Gateway/webhook) **ou** pelo **reconcile** (membro com entitlement `active` mas ausente do guild/grupo).
- Estado vira `left_manually` (não `removed` — `removed` é só quando *nós* removemos).
- **Política (decisão de produto — Open Questions):**
  - (a) **Não re-adicionar automaticamente** (recomendado): respeitar a vontade do membro de sair; mostrar na área do membro "Você saiu do Discord. Reentrar?" com botão. Re-adicionar à força gera UX hostil e loop com quem quer sair.
  - (b) Re-adicionar no próximo reconcile (mais agressivo) — só se a org marcar o canal como "obrigatório".
- Reconcile **não** fica re-tentando infinitamente em `left_manually`; marca o estado e para, registrando na timeline.

#### 1.10 Edge case: conta banida no provider

- Membro pago é **banido** pelo dono/mods no Discord/grupo (conduta).
- Tentar add role → API retorna erro (Discord: usuário banido não pode ser re-adicionado; `guilds.join` falha). Estado `channel_link = banned` (terminal sinalizado).
- **Regra:** a Stanbase **não desfaz ban** do dono (a moderação é soberana do dono). Mas o membro **continua pagando e tendo o direito** — então isto é um **conflito** que precisa de visibilidade: alerta no admin ("membro pagante B7K2M9X4 está banido do seu Discord — revisar"). Decisão de produto: manter cobrança? cancelar? (Open Questions, blocking parcial).
- Não re-tentar em loop: `banned` é terminal até intervenção humana (desbanir no Discord ou cancelar membership).

#### 1.11 Edge case: rate limits da API

Cada provider tem limites distintos — o worker precisa respeitá-los **globalmente por Connection**, não só por job:
- **Discord:** rate limits por rota (bucket) + **global** (50 req/s por bot) + header `Retry-After` em 429. Operações de role têm limites severos; **mudança de massa** (ex.: reconcile de 5.000 membros, ou org reconfigura mapa) deve ser **throttled e em lote**. Há limite de **250 cargos por guild** (afeta design do mapa).
- **Telegram Bot API:** ~30 msg/s global, limites por chat; `migrate_to_chat_id` quando grupo vira supergrupo (precisa re-resolver `chat_id`).
- **WhatsApp Cloud API:** limites por número/tier de mensageria + **janela de 24h** para mensagens livres (fora dela só templates aprovados) — relevante se notificarmos o membro; gestão de grupo tem limites próprios.

Mitigação concreta:
- **Token bucket por (connection, provider)** no worker; ao receber 429, respeitar `Retry-After`, re-enfileirar com backoff exponencial + jitter.
- **Coalescing:** se vários deltas do mesmo membro chegam juntos (ex.: upgrade que troca 3 cargos), agrupar numa única passada por guild.
- **Reconcile e mudanças de mapa em massa** rodam em **modo lento** (rate-limited, baixa prioridade) numa fila separada da sincronização em tempo real (que tem prioridade). Não deixar um reconcile de 10k membros sufocar o sync ao vivo de um upgrade.

#### 1.12 Reconciliação periódica (o backstop contra drift)

`pg_cron` agenda um job de reconcile por Connection (frequência configurável, ex.: a cada 6–24h, ou on-demand):
1. **Snapshot do estado desejado:** todos os membros com entitlement de canal `active` × `channel_mappings` → conjunto "deveria estar".
2. **Snapshot do estado real:** lista membros/cargos no provider (Discord: list guild members + roles; Telegram: limitado — bots não listam membros de grupos grandes facilmente → reconcile parcial/event-driven; WhatsApp: list participants).
3. **Diff e correção:**
   - Tem direito, não está → **add** (a menos que `left_manually`/`banned`).
   - Não tem direito, está → **remove** (cargo "vazado" de quem cancelou enquanto sync estava fora).
   - Está com cargo errado (ex.: ainda `@Membro` depois de virar `@VIP`) → ajusta.
4. **Stanbase é a fonte da verdade** (decisão recomendada): em conflito, o estado da Stanbase manda — exceto bans (soberania do dono) e saídas manuais (vontade do membro), que são respeitados.
5. Reconcile é **idempotente** e **rate-limited** (§1.11).

> **Limitação do Telegram:** a Bot API não permite listar membros de um grupo/supergrupo arbitrariamente (só admins limitados). Logo, o reconcile do Telegram é mais **event-driven** (reage a join/leave via updates) e o "estado real" é menos consultável que o do Discord. Documentar como risco (§8).

#### 1.13 Edge case: falha de sync (parcial, total, provider fora)

- **Falha parcial** (Discord ok, Telegram 5xx): cada `channel_link` tem status independente; só o que falhou entra em retry/DLQ. Entitlement permanece `active`.
- **Provider totalmente fora:** circuit breaker por Connection → para de bater, marca Connection `degraded`, alerta admin, e o reconcile recupera quando voltar.
- **DLQ:** após N tentativas, `channel_link → failed` e vai para dead-letter com o erro; visível no admin ("3 membros não receberam cargo — ver detalhe"). Replay manual disponível.
- **Token expirado/revogado** (Connection perdeu auth, ex.: bot removido do guild, OAuth revogado): Connection → `needs_reauth`; todos os syncs daquele provider pausam com aviso claro no admin, sem floodar DLQ com erros 401.

#### 1.14 Resumo de regras de negócio concretas

- 1 tier ativo por membro → o estado desejado de canais é sempre determinístico (não há "qual dos meus tiers vale?").
- Conceder-antes-revogar sempre.
- Conta não vinculada = `pending_link`, nunca erro.
- Saída manual ≠ remoção pela Stanbase; ban ≠ downgrade.
- Stanbase é fonte da verdade, exceto ban (dono) e saída manual (membro).
- Falha de provider externo nunca rebaixa entitlement/membership.
- WhatsApp **só** via API Oficial.
- Sync ao vivo tem prioridade sobre reconcile/migração em massa.

---

### 2. Modelo de dados

Todas as tabelas carregam `org_id` e RLS por `org_id`. Reaproveita `connections` (§25.6) e `channels` (§25.5) do framework de integrações; estende o que falta.

#### 2.1 `connections` (reuso de §25.6 — uma por org × provider)
| Coluna | Tipo | Nota |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK | RLS |
| `provider` | enum | `discord\|telegram\|whatsapp` (entre outros) |
| `credentials` | jsonb **cifrado** | bot token, OAuth client secret, WhatsApp system-user token, phone_number_id, etc. (§26 — nunca no front) |
| `external_account_ref` | text | guild_id principal / bot username / WABA id |
| `status` | enum | `active\|degraded\|needs_reauth\|disabled` |
| `last_reconciled_at` | timestamptz | |
| `meta` | jsonb | escopos OAuth concedidos, permissões do bot, lista de guilds |

#### 2.2 `channel_resources` (nova — recursos externos descobertos/configuráveis)
Um cargo/grupo/comunidade concreto dentro de uma Connection. Permite o admin escolher de uma lista (descoberta via API) em vez de digitar IDs.
| Coluna | Tipo | Nota |
|---|---|---|
| `id` | uuid PK | |
| `org_id`, `connection_id` | uuid FK | |
| `provider` | enum | redundante p/ índice |
| `kind` | enum | `discord_role\|telegram_group\|telegram_channel\|whatsapp_group\|whatsapp_community` |
| `external_id` | text | role_id / chat_id / group_id |
| `guild_id` | text null | só Discord (multi-guild) |
| `name` | text | nome legível (cache; sincronizado da API) |
| `metadata` | jsonb | posição do cargo, cor, se é managed, contagem de membros |
| `status` | enum | `available\|missing` (sumiu no provider) |
- Índice `(connection_id, kind)`, UNIQUE `(connection_id, kind, external_id)`.

#### 2.3 `channel_mappings` (nova — o mapa tier/perk → recurso)
| Coluna | Tipo | Nota |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK | |
| `connection_id` | uuid FK | |
| `target_type` | enum | `tier\|perk` (geralmente via perk `channel`, mas permitir mapear tier direto) |
| `target_id` | uuid | tier_id ou perk_id |
| `channel_resource_id` | uuid FK | o cargo/grupo |
| `mode` | enum | `additive` (acumula) / `exclusive` — ver herança §1.3 |
| `auto_add_to_server` | bool | usar `guilds.join` p/ Discord, ou só add-role se já está |
| `status` | enum | `active\|paused` |
- UNIQUE `(target_type, target_id, channel_resource_id)`. Índices em `target_id` e `connection_id`.

#### 2.4 `member_channel_identities` (nova — vínculo conta externa do membro)
| Coluna | Tipo | Nota |
|---|---|---|
| `id` | uuid PK | |
| `org_id`, `member_id` | uuid FK | |
| `provider` | enum | `discord\|telegram\|whatsapp` |
| `external_user_id` | text | discord snowflake / telegram user_id / wa_phone (E.164) |
| `external_username` | text null | display |
| `oauth_tokens` | jsonb **cifrado** null | Discord access/refresh (p/ `guilds.join`), escopos concedidos |
| `linked_at` | timestamptz | |
| `status` | enum | `linked\|unlinked\|invalid` (token revogado) |
- UNIQUE `(org_id, member_id, provider)` — um vínculo por provider por membro/org.
- UNIQUE parcial `(provider, external_user_id) WHERE status='linked'` por org — evita duas pessoas reivindicando a mesma conta Discord na mesma org.

#### 2.5 `channel_links` (nova — o espelho membro × recurso × estado)
| Coluna | Tipo | Nota |
|---|---|---|
| `id` | uuid PK | |
| `org_id`, `member_id` | uuid FK | |
| `connection_id`, `channel_resource_id` | uuid FK | |
| `provider`, `kind` | enum | redundante p/ filtro |
| `entitlement_id` | uuid FK null | origem (perk channel); null se mapeado por tier direto |
| `desired` | enum | `present\|absent` (estado que *deveria* ser) |
| `state` | enum | `pending_link\|queued\|syncing\|active\|revoking\|removed\|failed\|failed_revoke\|left_manually\|banned\|unlinked` |
| `attempts` | int default 0 | |
| `last_attempt_at`, `last_synced_at` | timestamptz | |
| `error` | jsonb null | último erro (código provider, retry_after) |
| `external_state_seen_at` | timestamptz null | última confirmação via reconcile/evento |
- UNIQUE `(member_id, channel_resource_id)` — chave natural idempotente (1 link por membro×recurso).
- Índice parcial `idx_links_pending` em `(provider) WHERE state IN ('queued','failed','failed_revoke','pending_link')` — fila de trabalho do worker/reconcile.
- Índice `(connection_id, state)` para dashboards.

#### 2.6 `channel_sync_jobs` (fila pgmq — específica de canais ou reuso de `entitlement_sync_jobs`)
Recomendação: **reusar** `entitlement_sync_jobs` de §09 como entrada, e este domínio expande para `channel_links`. Internamente, usar **duas filas pgmq**: `channel_sync_realtime` (prioridade, deltas ao vivo) e `channel_sync_bulk` (reconcile/remap em massa, rate-limited). Mensagem: `{channel_link_id, action: apply|remove, provider, connection_id, priority}`.

#### 2.7 `channel_events_inbox` (nova — eventos de entrada dos providers)
| `id`, `org_id`, `connection_id`, `provider`, `event_type` (`member_join\|member_remove\|member_ban\|chat_migrated\|...`), `external_user_id`, `payload` jsonb, `processed` bool, `received_at` |
- Webhook-in (Discord Gateway relay / Telegram updates / WhatsApp webhooks) grava aqui; um worker reconcilia contra `channel_links` (detecta `left_manually`, `banned`, `migrate_to_chat_id`).

#### 2.8 Tabelas de outros domínios tocadas
- **`entitlements`** (§09): lido (não escrito) — origem do `desired`. `channel_links.entitlement_id` referencia.
- **`interactions`** (§11/CRM): escreve `channel_joined`, `channel_left`, `channel_link_failed`, `channel_account_linked`.
- **`audit_logs`** (§25.6): mudanças de `channel_mappings`, reconexões, replays manuais.

---

### 3. API & Edge Functions

#### 3.1 Endpoints `/v1` (REST pública — admin/headless)

**Connections de canal**
```
GET    /v1/integrations                              # lista (inclui discord/telegram/whatsapp)
POST   /v1/integrations/discord/connect              # inicia OAuth do bot (install URL)
POST   /v1/integrations/telegram/connect             # registra bot token + valida getMe
POST   /v1/integrations/whatsapp/connect             # registra WABA/phone_number_id (API Oficial)
GET    /v1/integrations/{connectionId}/resources     # lista cargos/grupos descobertos (discovery)
POST   /v1/integrations/{connectionId}/resources/refresh  # re-descobre recursos via API
DELETE /v1/integrations/{connectionId}               # desconecta (pausa syncs)
```

**Mapa tier → cargo/grupo**
```
GET    /v1/channel-mappings                          # lista o mapa da org
POST   /v1/channel-mappings                          # cria mapping (target tier/perk → resource)
PATCH  /v1/channel-mappings/{id}                     # editar (mode, auto_add_to_server, pause)
DELETE /v1/channel-mappings/{id}                     # remover (dispara reconcile do recurso)
POST   /v1/channel-mappings/preview                  # dry-run: quantos membros afetados / quem ganha/perde
```

**Estado de canais do membro**
```
GET    /v1/members/{memberId}/channels               # channel_links do membro + estado por provider
POST   /v1/members/{memberId}/channels/resync        # força re-sync deste membro (idempotente)
```

**Vínculo de conta externa (membro)**
```
GET    /v1/me/channel-identities                     # contas vinculadas do membro logado
POST   /v1/me/channel-identities/discord/oauth-start # gera URL OAuth (identify, guilds.join)
GET    /v1/me/channel-identities/discord/callback    # troca code → tokens, cria identity
POST   /v1/me/channel-identities/telegram/link       # via login widget / start nonce
DELETE /v1/me/channel-identities/{provider}          # desvincular (vira pending_link se tiver direito)
```

**Operação / saúde**
```
GET    /v1/channels/health                           # status por connection (active/degraded/needs_reauth)
GET    /v1/channels/sync-failures                    # links em failed/DLQ
POST   /v1/channels/sync-failures/{linkId}/replay    # replay manual
POST   /v1/integrations/{connectionId}/reconcile     # dispara reconcile on-demand
```

#### 3.2 Edge Functions / Jobs internos

| Função | Tipo | Descrição |
|---|---|---|
| `discord-oauth-callback` | função | Troca `code` por tokens, persiste `member_channel_identities` (cifrado), tenta join+role. |
| `discord-bot-install` | função | Gera install URL com escopos/perms do bot; trata callback de instalação no guild. |
| `channel-sync-worker` | consumer pgmq | Consome `channel_sync_realtime`/`_bulk`, resolve identity, chama connector, escreve `channel_links` + interactions. Token bucket por connection. |
| `channel-connector-discord` | módulo | add/remove role, add-to-guild (`guilds.join`), list members, handle 429/`Retry-After`. |
| `channel-connector-telegram` | módulo | add via invite-link/approve, kick (ban+unban), handle `migrate_to_chat_id`. |
| `channel-connector-whatsapp` | módulo | add/remove participant via Cloud API Oficial; respeita janela 24h/templates. |
| `channel-webhook-in` | função | Recebe Discord Gateway relay / Telegram updates / WhatsApp webhooks → grava `channel_events_inbox` (verifica assinatura). |
| `channel-events-processor` | consumer | Processa inbox: detecta `left_manually`, `banned`, `chat_migrated`, novos joins. |
| `channel-reconcile-cron` | pg_cron | Por connection: diff desejado×real, enfileira correções em `channel_sync_bulk` (rate-limited). |
| `channel-resource-discovery` | função/job | Lista cargos/grupos do provider → popula `channel_resources` (cache). |
| `connection-health-monitor` | pg_cron | Detecta token revogado/bot removido → `needs_reauth`/`degraded` + alerta. |

> Mudança de tier/entitlement **não** tem endpoint próprio aqui: chega como `entitlement_sync_jobs` (de §09) e é expandida pelo `channel-sync-worker`.

---

### 4. Telas / Front

#### 4.1 Admin (painel padronizado §10.1 → módulo "Comunidade & Canais")

- **Hub de Conexões:** cards Discord / Telegram / WhatsApp com status (Conectado / Precisa reautenticar / Degradado / Não conectado), botão Conectar (OAuth Discord, token Telegram, WABA WhatsApp), e diagnóstico ("bot está em 2 servidores", "12 cargos detectados").
- **Editor do Mapa Tier → Cargo/Grupo:** tabela/matriz. Linhas = tiers (ou perks de canal); colunas/células = recursos (cargos/grupos) por provider, escolhidos de **dropdown populado por discovery** (sem digitar IDs). Toggles por mapping: `additive` (herda dos inferiores), `auto_add_to_server`. Suporte a **multi-guild** (agrupar por servidor).
- **Preview de impacto (dry-run):** ao salvar/alterar o mapa, modal "X membros ganharão cargo @VIP, Y perderão @Membro — aplicar agora / agendar". Usa `POST /channel-mappings/preview`.
- **Painel de Saúde & Sync:** lista de `channel_links` em `failed`/DLQ ("3 membros não receberam cargo"), filtro por provider, ação **Replay**. Métricas: % sincronizado, último reconcile, fila pendente, membros `pending_link` (não conectaram conta).
- **Conflitos:** seção "Atenção" — membros pagantes **banidos** no provider, membros que **saíram manualmente**, contas duplicadas. Cada item com ação (cancelar membership / ignorar / reconvidar).
- **Configuração de reconcile:** frequência, política de saída manual (re-adicionar? sim/não), política de grace (remover em suspended? sim/aguardar).

#### 4.2 Membro (front hosted temável §24.2 — área do membro)

- **Seção "Seus canais":** lista de canais a que o tier dá direito, cada um com estado: **Conectado** ✅ / **Conecte sua conta** (CTA OAuth Discord, vincular Telegram, confirmar WhatsApp) / **Você saiu — Reentrar** / **Pendente**.
- **Botão "Conectar Discord"** (OAuth com `identify guilds.join`), "Vincular Telegram" (deep-link ao bot), "Usar meu WhatsApp" (confirma o número do perfil).
- **Estado pós-vínculo:** "Pronto! Você recebeu o cargo @VIP em [Servidor]" + link direto para o servidor/grupo (invite/deep-link).
- **Aviso no downgrade/cancel:** "Ao mudar de plano você sairá de: grupo VIP, cargo @VIP" (alimenta o aviso de perda de perks de §09 §4.2).
- Componente SDK reutilizável `<ChannelConnect provider="discord"/>` para modo híbrido (§24.3).

---

### 5. Integrações externas

| Serviço | Como integra | Auth | Operações-chave |
|---|---|---|---|
| **Discord** | Bot (REST API v10) + OAuth2 (membro) + Gateway/relay p/ eventos | Bot token (cifrado) na Connection; OAuth `identify guilds.join` por membro | `PUT/DELETE guild member role`; `PUT guild member` (join via `guilds.join`); list guild members (reconcile); listen `GUILD_MEMBER_ADD/REMOVE/UPDATE`, ban events. Limites: 50 req/s global + buckets por rota; **250 cargos/guild**; `Retry-After` em 429. |
| **Telegram** | Bot API (HTTPS) + updates (webhook ou long-poll relay) | Bot token (cifrado); bot precisa ser **admin** do grupo/canal | Add via invite-link de uso único / `approveChatJoinRequest`; kick = `banChatMember`+`unbanChatMember`; `createChatInviteLink`; lidar com `migrate_to_chat_id` (grupo→supergrupo). Listagem de membros **limitada** (impacta reconcile). |
| **WhatsApp** | **API Oficial (Cloud API / BSP)** — decisão §30.3 | System user token + `phone_number_id` + WABA (cifrado) | Gestão de **grupos/comunidades** via endpoints oficiais; add/remove participant; **janela 24h** + **templates aprovados** para qualquer mensagem proativa; opt-in obrigatório. |
| **integrations-framework** | Infra comum | — | `connections`, worker/DLQ genérico, webhook-in router, cifragem de segredos. |
| **Asaas** (indireto) | Upstream | — | Webhook de pagamento → §09 resolve entitlement → delta de canal. Não chamado aqui diretamente. |

> **Nota WhatsApp:** a API Oficial historicamente tem suporte **limitado/evolutivo** para gestão programática de grupos. Risco real (§8): se a Cloud API não permitir add/remove de participante de grupo de forma confiável no momento do build, o fallback de produto é **comunidades por convite + link** (membro entra via link gerado, e a remoção é manual/assistida) — **nunca** automação não-oficial. Validar capacidade da API antes de prometer add/remove automático de grupo no WhatsApp.

---

### 6. Épicos & tarefas

#### Épico A — Modelo de dados & RLS
- A1 (M) Migrations: `channel_resources`, `channel_mappings`, `member_channel_identities`, `channel_links`, `channel_events_inbox` + enums + constraints/índices (incl. UNIQUEs idempotentes).
- A2 (S) Estender `connections` (status `degraded\|needs_reauth`, `meta` escopos/guilds, `external_account_ref`).
- A3 (M) RLS por `org_id` em todas + testes de isolamento. Cifragem de `credentials`/`oauth_tokens`.
- A4 (S) Filas pgmq `channel_sync_realtime` + `channel_sync_bulk`.

#### Épico B — Connections & discovery (admin conecta)
- B1 (L) Discord bot install (OAuth/escopos/perms) + persistir guild(s) + `getMe`/permissão check.
- B2 (M) Telegram connect (bot token + valida admin no grupo) + WhatsApp connect (WABA/phone_id, API Oficial).
- B3 (M) `channel-resource-discovery`: lista cargos (Discord), grupos/canais (Telegram), grupos/comunidades (WhatsApp) → `channel_resources`.
- B4 (S) `connection-health-monitor`: detecta token revogado/bot removido → `needs_reauth`/`degraded` + alerta admin.

#### Épico C — Mapa tier → cargo/grupo
- C1 (M) Endpoints `channel-mappings` CRUD + UNIQUE + validação (resource pertence à connection da org).
- C2 (M) Suporte `mode=additive` (herança de cargos de tiers inferiores) — expansão no resolver.
- C3 (M) Multi-guild: mapping carrega `guild_id`; sync itera todos os guilds/recursos do tier.
- C4 (M) `POST /channel-mappings/preview` (dry-run de impacto: ganham/perdem).
- C5 (L) Admin: editor de matriz tier×recurso com dropdown por discovery + toggles + agrupar por servidor.

#### Épico D — Vínculo de conta externa (member identity linking)
- D1 (L) Discord OAuth (`identify guilds.join`) `oauth-start`/`callback` → `member_channel_identities` (tokens cifrados) + refresh token handling.
- D2 (M) Telegram link (deep-link `start=<nonce>` + bot captura user_id) / Login Widget.
- D3 (S) WhatsApp: confirmar número E.164 do perfil (opt-in/template) → identity.
- D4 (S) UNIQUE anti-duplicidade (mesma conta externa por 2 membros) + estado `unlinked`/`invalid`.
- D5 (M) Front "Seus canais" + CTAs de conexão + estado pós-vínculo (componente `<ChannelConnect/>`).

#### Épico E — Engine de sync (núcleo)
- E1 (L) `channel-sync-worker`: consome filas, resolve identity, idempotência por `channel_links` (UNIQUE), grava estado.
- E2 (M) Connector Discord: add/remove role, add-to-guild via `guilds.join`, 429/`Retry-After`, buckets.
- E3 (M) Connector Telegram: add (invite/approve), kick limpo (ban+unban), `migrate_to_chat_id`.
- E4 (M) Connector WhatsApp (API Oficial): add/remove participant; tratar limitação de grupos (fallback invite-link).
- E5 (M) **Conceder-antes-revogar** + coalescing de deltas do mesmo membro.
- E6 (M) Token bucket por connection + filas separadas realtime/bulk (prioridade do ao-vivo).
- E7 (S) `pending_link`: sem identity → estado pendente, não erro; CTA na área do membro.

#### Épico F — Eventos de entrada & edge cases
- F1 (M) `channel-webhook-in` (Discord relay / Telegram updates / WhatsApp webhooks) + verificação de assinatura → `channel_events_inbox`.
- F2 (M) `channel-events-processor`: detecta `left_manually`, `banned`, `chat_migrated`, joins; atualiza `channel_links`.
- F3 (M) Política de saída manual (não re-adicionar / re-adicionar se obrigatório) — configurável.
- F4 (M) Tratamento de `banned`: terminal + alerta "membro pagante banido" no admin.
- F5 (S) Conta unlinked → volta a `pending_link` se ainda tem direito.

#### Épico G — Reconciliação & resiliência
- G1 (L) `channel-reconcile-cron` por connection: diff desejado×real (Discord completo; Telegram event-driven; WhatsApp parcial) → correções em fila bulk.
- G2 (M) Falha-parcial isolada por `channel_link`; entitlement não rebaixa; DLQ + replay manual.
- G3 (M) Circuit breaker por connection (provider fora) → `degraded`, pausa, retoma no reconcile.
- G4 (S) Painel admin de saúde/sync + replay + métricas (% sincronizado, pending_link, DLQ).
- G5 (S) Rate-limit do reconcile/remap em massa (modo lento, baixa prioridade).

#### Épico H — Integração com tiers/entitlements & timeline
- H1 (S) Expandir `entitlement_sync_jobs` (provider channel) → `channel_links` (perk → recursos).
- H2 (S) Registrar `channel_joined/left/failed/account_linked` em `interactions` (CRM §11.2).
- H3 (S) Respeitar grace (reage a entitlement `suspended` conforme política) — sem grace próprio.
- H4 (S) Aviso de perda de canais no downgrade (alimenta preview de §09).

---

### 7. Dependências

| Depende de | Por quê |
|---|---|
| **integrations-framework** | Infra de `connections` (OAuth/token cifrado, refresh, status), catálogo de connectors, worker/DLQ genérico, webhook-in router, cifragem de segredos. **Dependência mais forte** — este domínio são os 3 connectors concretos sobre essa base. |
| **tiers-perks** | Origem do *direito*: perk `channel`, entitlements (`active`/`revoked`), deltas de sync. O mapa tier→cargo referencia `tiers`/`perks`. Este domínio é o executor do perk `channel`. |
| **payments-billing** | Upstream: webhook Asaas → muda subscription → resolve entitlement → delta de canal. Grace period (quando remover acesso) é definido lá. |
| **member-identity** | `members`/`member_id`; `member_channel_identities` referencia o membro; vínculo de conta externa parte da identidade. |
| **auth-rbac** | Permissões de admin para conectar provider, editar mapa, replay; escopo por org; member logado para vincular conta. |
| **crm** | Timeline (`interactions`) registra entradas/saídas de canal; conflitos aparecem na ficha do membro. |
| **fundacao** | Schema base, `org_id`, RLS, pg_cron/pgmq, convenções de migration, cifragem. |
| **member-app / admin-app / design-system** | Telas: hub de conexões, editor do mapa, "Seus canais", painel de saúde. |
| **webhooks** | Pode emitir `member.channel_joined`/`channel_left` para webhooks-out da org (§22). |
| **observability-qa** | Monitorar syncs/DLQ/retries (§27 "syncs de integração monitorados"). |
| **security-lgpd** | Tokens cifrados, consentimento WhatsApp/opt-in, DPA com Discord/Telegram/WhatsApp como sub-processadores. |

---

### 8. Riscos & decisões técnicas

1. **Conta externa não vinculada** é o gargalo de adoção, não um erro. Muitos membros pagam e nunca conectam o Discord → não recebem cargo → reclamam "paguei e não tenho acesso". Mitigação: CTA persistente, e-mail/push pós-compra "conecte seu Discord", estado claro `pending_link`. **Não** falhar o sync. Métrica de "% conectado" no admin.
2. **Atribuir cargo exige o membro estar no guild.** Sem `guilds.join` autorizado, só dá pra add role a quem já entrou. Decidir UX: forçar `guilds.join` no OAuth (mais fricção, mas automático) vs invite-link (menos fricção, membro precisa entrar). Recomendação: pedir `guilds.join` e ter invite como fallback.
3. **Rate limits / mudanças em massa.** Org com 10k membros que reconfigura o mapa, ou reconcile completo, pode estourar limites do Discord (50 req/s, buckets por rota) e Telegram (~30/s). Filas separadas (realtime prioritário vs bulk lento), token bucket por connection, backoff com `Retry-After`. Sem isso, sync ao vivo trava atrás de um remap gigante.
4. **Multi-guild / múltiplos servidores.** Uma Connection com bot em N guilds; mapping precisa de `guild_id`. Cargo `@VIP` no Guild A ≠ `@VIP` no Guild B (IDs diferentes). Discovery e mapa têm que ser por guild. Risco de o admin mapear cargo do guild errado.
5. **Saída manual ≠ remoção.** Re-adicionar à força quem saiu sozinho é UX hostil e loop infinito com quem quer sair. Recomendação: **não** re-adicionar automático; oferecer "reentrar". Mas org pode querer canal "obrigatório". Config por canal. (Open Questions, blocking parcial.)
6. **Conta banida pelo dono, membro continua pagando.** Conflito de soberania: moderação é do dono; cobrança é do membro. A Stanbase não desbane. Precisa de visibilidade (alerta) + decisão de produto: cancelar membership? manter cobrando? (Open Questions, blocking parcial.)
7. **WhatsApp API Oficial — gestão de grupos é limitada/evolutiva.** A Cloud API pode não suportar add/remove programático de participante de grupo de forma confiável no build. Fallback de produto: comunidade por **convite/link** + remoção assistida; **nunca** lib não-oficial (decisão §30.3). Validar capacidade antes de prometer automação total. **Risco alto para o escopo de WhatsApp.**
8. **Reconcile do Telegram é cego.** Bots não listam membros de grupos grandes via API → reconcile do Telegram é majoritariamente event-driven; drift pode passar despercebido (alguém saiu e voltou sem evento processado). Documentar como limitação; Discord é o canal com reconcile forte.
9. **Idempotência sob retry.** Webhook Asaas reenvia, reconcile e sync ao vivo rodam juntos → mesmo `channel_link` pode ser processado em paralelo. UNIQUE `(member_id, channel_resource_id)` + estados `syncing/revoking` como lock lógico + ações idempotentes (add role já presente = no-op). Sem isso, duplica eventos na timeline e bate na API à toa.
10. **Drift "vazado" pós-cancelamento.** Membro cancela enquanto Discord está fora → cargo permanece (membro acessa de graça). Reconcile é a única defesa; definir frequência (recomendado ≤24h, on-demand ao cancelar). **Stanbase é fonte da verdade** (exceto ban/saída manual).
11. **Token/bot revogado.** Bot removido do guild ou OAuth do membro revogado → 401/403. Não floodar DLQ: Connection → `needs_reauth`, pausa syncs daquele provider, alerta admin único. Distinguir "auth quebrada" (pausa) de "erro pontual" (retry).
12. **Telegram `migrate_to_chat_id`.** Grupo comum vira supergrupo → `chat_id` muda. Se não capturar o evento, todos os syncs daquele grupo falham silenciosamente. Tratar no events-processor (atualiza `channel_resources.external_id`).
13. **Grace period e remoção.** Membro inadimplente em grace (`suspended`): remove o cargo já ou espera o grace acabar? Remover cedo demais irrita quem só atrasou um dia; tarde demais dá acesso grátis. Reage à política do entitlement (§13.4), não decide sozinho. (Open Questions.)
14. **Limite de 250 cargos por guild (Discord).** Org com muitos tiers × muitos perks de canal pode esbarrar. Improvável no MVP, mas validar no design do mapa.

---

### 9. Escopo MVP vs. depois

#### MVP (Fase 2 — §29 "Integrações canais (Discord)")
- **Discord completo:** bot install (OAuth), OAuth do membro (`identify guilds.join`), discovery de cargos, mapa tier→cargo (single + multi-guild), add/remove role na sincronização contínua, `pending_link`, conceder-antes-revogar.
- **Engine de sync** (worker + filas realtime/bulk + token bucket + idempotência) — genérica, mas validada com Discord.
- **Reconcile do Discord** (diff desejado×real, fonte da verdade Stanbase) + DLQ + replay manual + painel de saúde.
- Edge cases Discord: conta não vinculada (`pending_link`), saída manual (`left_manually`, não re-add), banido (alerta), token/bot revogado (`needs_reauth`), rate limit (backoff).
- Timeline CRM (entradas/saídas de canal) + aviso de perda no downgrade.
- **Telegram básico:** add via invite-link, kick limpo (ban+unban) por downgrade — reconcile event-driven (sem listagem completa).

#### Depois (Fases 2+/3)
- **WhatsApp** (API Oficial) — dependente de validar a capacidade real de gestão de grupos da Cloud API; possivelmente só convite/link + remoção assistida no início.
- Telegram avançado (canais privados, aprovação de join requests automatizada, supergrupos com tópicos).
- Herança de cargos `mode=additive` configurável + UI de hierarquia.
- Reconcile sofisticado + dashboard de drift por provider + métricas de SLA de sync.
- Múltiplas connections do mesmo provider por org (ex.: 2 servidores Discord não-federados) — se necessário.
- Webhooks-out de canal (`member.channel_joined/left`) + automações Zapier.
- `auto_add_to_server` granular e políticas de canal "obrigatório".
- Suporte a outros canais (Slack, fóruns) via mesmo framework.
