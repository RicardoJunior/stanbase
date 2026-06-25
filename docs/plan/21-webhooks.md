## 21. Webhooks & Automação

> **Domínio-plataforma de mensageria de eventos.** É o **barramento de eventos de domínio** da Stanbase: um lado **recebe** o que cada domínio produz (`member.created`, `subscription.payment_succeeded`, `event.checkin`, `passport.issued`, `content.published`…) e o **entrega de forma confiável** a endpoints HTTP que a org cadastrou (webhooks de **saída**), com assinatura HMAC, retries com backoff, dead-letter, replay manual e log de entregas. O outro lado **recebe** eventos de serviços externos (Asaas, Discord) — porém esse ingest é **executado pelo framework de integrações (§19)** com verificação de assinatura; aqui só documentamos a fronteira e o roteamento. Por cima de tudo, o **app oficial Zapier/Make** (capability `automation` do §19) transforma esses eventos em **triggers** e a API `/v1` em **actions**, levando a Stanbase ao stack de qualquer dono sem código.
>
> **Fonte de verdade:** `STANBASE.md` §22 (webhooks in/out, Zapier/Make, catálogo de eventos), §6 (stack: Edge Functions TS/Deno, pgmq, pg_cron, pg_net, Realtime), §21 (API pública `/v1`, idempotência, OpenAPI), §25.6 (`webhooks`, `webhook_deliveries`, `api_keys`, `audit_logs`), §26 (HMAC, segredos cifrados, RLS, LGPD), §27 (monitoramento de entregas e DLQ), §10.1 item 13 (módulo admin "Desenvolvedores"). Domínio **irmão** do §19 (integrações): §19 é **in** (recebe e executa adapters de provider); §21 é **out** (entrega eventos da Stanbase para o mundo). Eles se cruzam: um webhook-in normalizado pelo §19 pode **gerar** um evento de domínio que o §21 entrega para fora.
>
> **Decisões imutáveis herdadas:** Edge Functions TS/Deno; **pgmq** para fila de entregas, **pg_cron** para schedulers, **pg_net** para HTTP de saída a partir do banco/worker; RLS por `org_id`; segredos (signing secrets) **cifrados**, nunca no front; API-first (registro de webhook é `POST /v1/webhooks`, dogfooding); idempotência transversal da fundação (`idempotency_keys`); `audit_logs` para tudo. Webhook é recurso **por org** (cada base tem seus próprios endpoints e segredos).

---

### 21.1 Como funciona

#### 21.1.1 Vocabulário e as quatro peças

| Peça | É | Escopo | Volume |
|---|---|---|---|
| **Event type (catálogo)** | Definição padronizada de um evento de domínio: nome (`subscription.payment_succeeded`), versão do schema, exemplo de payload, domínio dono. **Código + linha em `webhook_event_types`.** | Global (plataforma) | Dezenas |
| **Domain event (evento emitido)** | Uma ocorrência concreta: "membro B7K2M9X4 mudou de tier às 14h". Gravado **uma vez** no **outbox** pelo domínio dono, dentro da mesma transação que mudou o estado. | Por org | Altíssimo |
| **Webhook subscription (endpoint)** | A org cadastrou uma URL e assinou um conjunto de event types. Tem `secret` (HMAC), filtros, status. **1+ por org.** | Por org | Centenas |
| **Delivery (entrega)** | A tentativa de mandar UM domain event para UM endpoint. Tem máquina de estados, tentativas, backoff, resposta do cliente. **fan-out:** 1 evento × N endpoints assinantes = N deliveries. | Por org | Altíssimo |

> **Princípio de design (event → outbox → fan-out → delivery):** os domínios **não chamam HTTP de cliente diretamente**. Eles **emitem** o evento no **outbox** (`webhook_events`) na mesma transação que comita a mudança (padrão *transactional outbox* — sem isso, um webhook pode disparar para uma mudança que sofreu rollback, ou uma mudança comita sem webhook). Um worker lê o outbox, faz **fan-out** para os endpoints assinantes (cria N `webhook_deliveries`), e outro worker entrega cada uma com retry/backoff. Separar **produção do evento** (síncrona, transacional) da **entrega** (assíncrona, com retry) é o coração da confiabilidade.

#### 21.1.2 Catálogo de eventos de saída (MVP + reservados)

Eventos canônicos `recurso.acao` (snake_case no payload, datas ISO-8601 UTC — §21.1). Cada um declara o **domínio dono** (quem emite) e o **schema versionado**:

| Event type | Dono (§) | Quando dispara | Carga essencial (resumo) |
|---|---|---|---|
| `member.created` | crm/member-identity (§07/§08) | nova relação pessoa×org | `member_id`, `tier_id?`, `source`, `joined_at` |
| `member.tier_changed` | tiers-perks (§09) | upgrade/downgrade/grandfather | `member_id`, `from_tier`, `to_tier`, `proration?` |
| `member.churned` | crm/payments (§08/§10) | cancelou/expirou definitivamente | `member_id`, `last_tier`, `reason`, `churned_at` |
| `subscription.payment_succeeded` | payments-billing (§10) | webhook Asaas `PAYMENT_RECEIVED` confirmado | `subscription_id`, `member_id`, `amount`, `method`, `installment?` |
| `subscription.payment_failed` | payments-billing (§10) | `PAYMENT_OVERDUE`/recusa de cartão | `subscription_id`, `member_id`, `attempt`, `next_retry_at?` |
| `event.checkin` | verification-checkin (§12) | check-in efetivo (`valid→used`) | `event_id`, `ticket_id`, `member_id`, `operator`, `at` |
| `passport.issued` | passport (§11) | passe emitido (membership/ticket) | `member_id`, `pass_id`, `type`, `platform` |
| `content.published` | content-gating (§14) | conteúdo gated publicado | `content_id`, `type`, `min_tier`, `publish_at` |

**Reservados / habilitados conforme o domínio entrega** (mesma infra, sem mudar o motor): `member.segment_entered`/`member.segment_left` (§08), `member.entitlements_changed` (§09), `subscription.canceled`/`subscription.renewed` (§10), `transaction.refunded`/`transaction.chargeback` (§10), `payout.paid` (§10), `ticket.issued`/`ticket.refunded` (§13), `passport.updated`/`passport.revoked`/`passport.token_rotated` (§11), `member.left_discord` (normalizado do §19), `event.created` (§13).

> **Regra:** adicionar um evento novo = adicionar uma linha em `webhook_event_types` + o domínio dono chamar `emit_domain_event(...)`. O motor de entrega **não muda**. Eventos **não** listados no catálogo são rejeitados na emissão (typo-safety) e na assinatura (org não consegue assinar evento inexistente).

#### 21.1.3 Envelope canônico do payload (estável e versionado)

Todo webhook de saída tem o **mesmo envelope** — o `data` muda por evento, o envelope nunca:

```json
{
  "id": "evt_01H...",                    // id único do EVENTO (não da entrega) — para idempotência no consumidor
  "type": "subscription.payment_succeeded",
  "api_version": "2026-06-01",           // versão do schema do payload (data); permite evoluir sem quebrar
  "created_at": "2026-06-24T14:03:11Z",  // quando o EVENTO ocorreu (não quando foi entregue)
  "org_id": "org_...",                   // org dona (multi-tenant explícito p/ o consumidor)
  "data": { /* específico do event type, snake_case */ },
  "delivery": {                          // metadados da ENTREGA específica
    "id": "del_01H...",
    "attempt": 2,                        // nº desta tentativa (1-based)
    "subscription_id": "whk_..."         // qual endpoint
  }
}
```

- **`id` é o que o consumidor deduplica** (não o `delivery.id`): retries reentregam o **mesmo `id`** → o consumidor processa 1x. Documentar isso explicitamente no portal do dev.
- **`api_version`** é fixada **por endpoint** no momento do registro (ou default da org), não "latest" — assim mudar o schema de um evento não quebra integrações vivas (ver §21.8 risco de versionamento).
- **Headers HTTP** acompanham o envelope (assinatura, id, tentativa) — ver §21.1.5.

#### 21.1.4 Máquina de estados — Delivery (a unidade de trabalho de saída)

Delivery = "entregar UM evento a UM endpoint". Vive em pgmq (`webhook_delivery_q`) + tabela durável (`webhook_deliveries`):

```
            fan-out cria a delivery
                     │
                     ▼
   pending ──pick──► delivering ──2xx──► succeeded
      ▲                  │
      │                  ├─ 4xx (≠408/429) ──► failed_permanent (não retenta; erro do cliente)
      │                  │
      │                  ├─ 5xx / timeout / conn refused / 408 / 429 ──► retry_scheduled
      │                  │            │ (esgotou max_attempts)
      └──next_attempt────┘            ▼
                                  dead_letter ──replay manual──► pending
                                      ▲
                  endpoint disabled ──┘ (entrega pausada enquanto endpoint paused/disabled)
```

Estados e regras concretas:

- **`pending`** — delivery criada pelo fan-out, aguardando o worker. Idempotente por `(event_id, webhook_id)` UNIQUE — o mesmo evento nunca cria duas deliveries para o mesmo endpoint.
- **`delivering`** — worker pegou a delivery, está fazendo o POST (com lock/visibility timeout do pgmq para não duplicar).
- **`succeeded`** — cliente respondeu **2xx** dentro do timeout (ex.: 10s). Resposta (status + primeiros N KB do body) é logada para o painel.
- **`retry_scheduled`** — falha **transitória**: `5xx`, timeout, conexão recusada/reset, DNS, `408`, `429`. Reagenda com **backoff exponencial + jitter** (ver §21.1.6). Respeita `Retry-After` em `429`/`503`.
- **`failed_permanent`** — falha **não-retentável**: `4xx` ≠ `408`/`429` (ex.: `400`, `401`, `404`, `410`, `422`) → o endpoint do cliente rejeitou de forma definitiva; **não adianta retentar o mesmo payload**. Conta para o circuit-breaker de auto-disable (§21.1.7).
- **`dead_letter`** — esgotou `max_attempts` (default 8) em falhas transitórias. **Não é descartada**: fica na DLQ visível no painel, com botão **replay manual**. Retenção configurável (ex.: 30 dias).
- **Replay** (manual ou em massa) cria uma **nova tentativa** da MESMA delivery (mesmo `event.id`, `attempt` continua incrementando) — o consumidor idempotente não duplica. Replay também serve para "endpoint ficou de pé de novo, reprocessa as DLQ das últimas 24h".

> **Distinção crítica (4xx vs 5xx):** `5xx`/timeout/conn = **culpa do servidor do cliente ou da rede** → retenta. `4xx` (exceto 408/429) = **o cliente entendeu e rejeitou** → não retenta (retentar 404 mil vezes é desperdício e ruído). Errar isso = ou martelar um endpoint quebrado, ou desistir cedo de um endpoint que só teve um soluço. `410 Gone` é sinal forte para **auto-disable** o endpoint.

#### 21.1.5 Assinatura HMAC e headers

Cada endpoint tem um `secret` (gerado pela Stanbase, **cifrado** em repouso, exibido **uma vez** no registro/rotação). Para cada POST:

- **`X-Stanbase-Signature`**: `t=<unix_ts>,v1=<hex>` onde `v1 = HMAC_SHA256(secret, "<unix_ts>.<raw_body>")`. O timestamp **dentro do conteúdo assinado** previne replay (o consumidor rejeita se `|now - t| > tolerância`, ex.: 5 min).
- **`X-Stanbase-Event`**: o `type` (`subscription.payment_succeeded`) — permite roteamento no consumidor sem parsear o body.
- **`X-Stanbase-Event-Id`**: o `event.id` — chave de idempotência do consumidor, também em header.
- **`X-Stanbase-Delivery-Id`** + **`X-Stanbase-Attempt`**: rastreio/depuração.
- **`Content-Type: application/json`**, **`User-Agent: Stanbase-Webhooks/1`**.
- **Rotação de segredo (overlap):** ao rotacionar, o endpoint pode ter **dois secrets ativos** por um período de graça (ex.: 24h) — assinamos com o **novo**, mas mantemos o antigo válido na verificação documentada para o consumidor migrar sem downtime. Após o grace, o antigo é descartado. (Ver §21.8 risco de rotação.)

> **Verificação (documentada para o consumidor):** recomputar o HMAC sobre o **raw body** (não o JSON re-serializado), comparar em **tempo constante**, e validar a janela do timestamp. Publicamos snippets prontos (Node/Deno/Python/PHP) no portal do dev — verificação mal feita do lado do cliente é a fonte #1 de "meu webhook não funciona".

#### 21.1.6 Backoff, ordering e timeout

- **Backoff:** exponencial com jitter. Schedule default (8 tentativas): ~imediato, 30s, 2min, 10min, 30min, 1h, 3h, 6h (com jitter ±20%). Total ~10h de janela antes da DLQ. Respeita `Retry-After` (segundos ou data) quando presente em `429`/`503`.
- **Timeout de conexão/resposta:** 10s (connect+read). Cliente lento = timeout = retry transitório.
- **Ordering (best-effort, não garantido por padrão):** webhooks **não garantem ordem** entre tipos diferentes; retries embaralham ("at-least-once, unordered"). **Documentar isso é obrigatório** — o consumidor não pode assumir que `member.created` chega antes de `subscription.payment_succeeded`. Para quem precisa de ordem **por entidade**, oferecemos **ordering opcional por chave** (`ordering_key = member_id`): deliveries com a mesma key vão a uma sub-fila serial por endpoint — uma não sai até a anterior dar 2xx ou ir para DLQ (com head-of-line blocking controlado por timeout). MVP: best-effort + `created_at`/`sequence` no envelope para o consumidor reordenar; ordering serial é pós-MVP (Open Question).
- **`sequence` monotônico por org** no envelope (`data._meta.sequence` ou top-level) permite o consumidor detectar gaps/reordenar mesmo no modo unordered.

#### 21.1.7 Endpoint fora do ar, circuit breaker e auto-disable

Endpoint do cliente caído por horas/dias é o edge case central:

1. Falhas transitórias consecutivas alimentam um **contador por endpoint** (`consecutive_failures`).
2. Ao cruzar um limiar (ex.: 10 falhas seguidas **ou** 100% de falha por 1h), o endpoint entra em **`degraded`**: o backoff por delivery cresce, e abre-se um **circuit breaker** — em vez de tentar cada delivery individualmente e martelar, fazemos **probes** espaçados; enquanto aberto, novas deliveries ficam `pending` represadas (não explodem a fila).
3. **Auto-disable de segurança:** se o endpoint falha **continuamente por X tempo** (ex.: 5 dias) ou responde `410 Gone`, ele é **`auto_disabled`**, paramos de entregar, **notificamos o admin** (e-mail + banner no painel), e as deliveries vão para DLQ. Isso evita gastar recursos e poluir logs eternamente com um endpoint morto.
4. **Recuperação:** um probe que volta a dar 2xx **fecha o breaker**, retoma a fila represada. Para `auto_disabled`, o admin reabilita manualmente (e pode **replay em massa** da janela perdida).
5. **Half-open:** ao reabrir, deixa passar 1 probe; se ok, fecha; se falha, reabre com backoff maior.

> **Por que represar e não enfileirar infinito:** sem breaker, um endpoint caído com tráfego alto enche a `webhook_delivery_q` de milhões de deliveries em `retry_scheduled`, competindo com endpoints saudáveis. O breaker isola o endpoint problemático sem afetar os demais (bulkhead por endpoint).

#### 21.1.8 Fluxo passo a passo — emissão → entrega

1. **Domínio dono muda estado** (ex.: §10 confirma `PAYMENT_RECEIVED`). Na **mesma transação**, chama `emit_domain_event('subscription.payment_succeeded', org_id, data, idempotency_key)` → INSERT em `webhook_events` (outbox). Commit atômico: ou ambos persistem, ou nenhum.
2. **`webhook-fanout-worker`** (consumer pgmq, alimentado por trigger/notify no outbox ou poll) pega o evento `pending`, busca os endpoints da org que **assinam aquele type** e passam nos **filtros** (ver §21.1.9), e cria N `webhook_deliveries` (`pending`) — **idempotente** por `(event_id, webhook_id)`. Marca o evento `fanned_out`. Se zero assinantes → `no_subscribers` (não é erro).
3. **`webhook-delivery-worker`** (consumer pgmq) pega cada delivery `pending`, carrega o `secret` (decifra em memória, nunca loga), monta envelope + headers + assinatura, faz **POST via pg_net/fetch** com timeout 10s.
4. **2xx** → `succeeded`, loga status+latência+trecho do body, zera `consecutive_failures` do endpoint. **5xx/timeout** → `retry_scheduled` com backoff. **4xx≠408/429** → `failed_permanent`. Atualiza contadores do breaker.
5. Esgotou tentativas → `dead_letter`. Admin vê no painel, pode **replay**.
6. Métricas (sucesso/falha/latência/DLQ por endpoint e por type) vão para observabilidade (§27).

#### 21.1.9 Filtros e fan-out seletivo

- Endpoint assina **lista de event types** (`events: ["subscription.*", "event.checkin"]`) — suporta **wildcard por prefixo** (`subscription.*` casa todos os de subscription).
- **Filtros opcionais** por atributo do payload (ex.: só `tier_id IN (...)`, só eventos de um `event_id` específico) — avaliados no fan-out, evitando entregar ruído. MVP: filtro por type + wildcard; filtros por atributo são pós-MVP (Open Question sobre o quão rico).
- **Fan-out grande:** uma org com 50 endpoints assinando o mesmo type gera 50 deliveries por evento. Fan-out é **assíncrono e em lote**; o INSERT de deliveries é bulk; cada uma é independente (uma falhando não afeta as outras).

#### 21.1.10 Payloads grandes (thin vs fat events)

- **Default: payload "magro" + dados essenciais** (ids + campos-chave), **não** o objeto inteiro. Mantém o POST pequeno, rápido e estável.
- **Teto de tamanho:** se o `data` ultrapassar um limite (ex.: 256 KB), **não inflamos o webhook**: entregamos a versão magra com um campo `data_truncated: true` + `resource_url` (`GET /v1/.../{id}`) para o consumidor buscar o objeto completo via API (com a credencial dele). Evita endpoints rejeitando por `413`/timeout e evita vazar PII desnecessária no corpo.
- **Sem anexos binários** em webhook (mídia/comprovantes vão por `resource_url` para Storage com signed URL). O envelope é sempre JSON pequeno.

#### 21.1.11 Webhooks de entrada (fronteira com §19)

Webhooks **de entrada** (Asaas, Discord) são **recebidos e verificados pelo framework de integrações (§19)** e por `payments-billing` (§10, rota dedicada `POST /v1/webhooks/asaas`). Este domínio **não** reimplementa o ingest. O que pertence a este domínio na fronteira:

- **Roteamento de eventos normalizados:** quando o §19 normaliza um evento de entrada que vira um **evento de domínio** (ex.: "membro saiu do Discord" → `member.left_discord`), ele chama `emit_domain_event(...)` → este domínio **entrega para fora** se a org assinou.
- **Padrões reusados de verificação** (documentados aqui por completude, implementados no §19/§10): HMAC-SHA256 sobre **raw body** em tempo constante; Ed25519 (Discord, `X-Signature-Ed25519` + `X-Signature-Timestamp`); token compartilhado em header (Asaas `asaas-access-token`); **anti-replay** por janela de timestamp; **dedupe** por `provider_event_id` UNIQUE; **persistir cru antes de processar**; **responder 2xx rápido** e processar assíncrono.

> **Fronteira explícita:** §10 é dono do webhook Asaas (efeitos financeiros); §19 é dono do ingest genérico de providers e da verificação; §21 é dono da **saída** e do **catálogo/envelope/entrega**. A tabela `webhook_deliveries` (§25.6) é **deste** domínio (saída); `asaas_webhook_events`/`inbound_events` são dos outros (entrada).

#### 21.1.12 Zapier / Make (app oficial)

- **Triggers** (Zapier "New X") = assinaturas de webhook **gerenciadas pelo próprio app**: quando o usuário cria um Zap, o app chama `POST /v1/webhooks` (via *REST Hook subscribe*) registrando a URL do Zapier; ao desligar o Zap, chama `DELETE`. Cada trigger mapeia para um event type do catálogo (`member.created` → trigger "New Member"). Zapier também suporta **polling fallback** (`GET /v1/members?cursor=` ordenado por `created_at`) para gatilhos sem webhook.
- **Actions** (Zapier "Create/Update X") = chamadas diretas à API `/v1` (criar membro, enviar mensagem para segmento, emitir passport, adicionar tag) — reuso total da API pública, **sem** endpoint especial.
- **Auth:** API key da org (com escopo) ou OAuth2 — o mesmo do §21 da API pública. O app guarda a credencial no Zapier/Make.
- **Make** segue o mesmo modelo (instant triggers via webhook, actions via módulos da API). **MVP:** infra de webhook + API pronta; **app publicado** nos diretórios Zapier/Make é pós-MVP (§19 capability `automation`).

---

### 21.2 Modelo de dados

Tabelas de instância carregam `org_id` + RLS por `org_id` (template da fundação §2.3). `webhook_event_types` é **global** (catálogo, sem `org_id`, RLS leitura para autenticados). Estende `webhooks` e `webhook_deliveries` do §25.6.

#### 21.2.1 Catálogo de eventos (global)

**`webhook_event_types`** (fonte da verdade do "o que a Stanbase emite")
| Coluna | Tipo | Nota |
|---|---|---|
| `type` | text PK | `subscription.payment_succeeded` (slug estável) |
| `domain` | text | domínio dono (`payments-billing`, `crm`…) |
| `description` | text | exibição no portal do dev |
| `schema` | jsonb | JSON Schema do `data` (valida emissão + documenta) |
| `current_api_version` | text | versão atual do schema (`2026-06-01`) |
| `example_payload` | jsonb | exemplo renderizado no portal |
| `status` | enum | `available\|beta\|deprecated` |
| `is_pii` | bool | marca eventos cujo `data` pode ter PII (LGPD/retenção) |

#### 21.2.2 Endpoints (subscriptions de saída)

**`webhooks`** (estende §25.6 — `id`, `org_id`, `url`, `events`, `secret`)
| Coluna | Tipo | Nota |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK | RLS |
| `url` | text | destino HTTPS (valida TLS, bloqueia IP privado/SSRF — ver §21.8) |
| `description` | text | rótulo do admin ("Zap de boas-vindas") |
| `events` | text[] | types assinados + wildcards (`subscription.*`) |
| `filters` | jsonb null | filtros por atributo (pós-MVP) |
| `secret` | bytea cifrado | HMAC secret (Vault/pgsodium); nunca em claro |
| `secret_prev` | bytea cifrado null | segredo anterior durante o grace de rotação |
| `secret_rotated_at` | timestamptz null | fim do grace = `+24h` |
| `api_version` | text | versão de schema fixada para este endpoint |
| `status` | enum `webhook_status` | `active\|paused\|degraded\|auto_disabled\|disabled` |
| `consecutive_failures` | int default 0 | alimenta circuit breaker |
| `breaker_state` | enum | `closed\|open\|half_open` |
| `breaker_open_until` | timestamptz null | quando o breaker tenta half-open |
| `ordering_key` | text null | atributo p/ ordering serial (pós-MVP; ex.: `member_id`) |
| `created_by` | uuid | admin que criou (audit) |
| `last_success_at` / `last_failure_at` | timestamptz null | painel |
| `created_at` / `updated_at` | timestamptz | |

Constraints/índices:
- `idx_webhooks_org_status (org_id, status)`.
- Índice GIN em `events` para o fan-out resolver assinantes por type rapidamente: `GIN (events)` (com expansão de wildcard no worker).
- Limite por org (ex.: 50 endpoints) — anti-abuso.
- View pública (front) **sem** `secret`/`secret_prev`; o segredo cru só sai **uma vez** na resposta do registro/rotação.

#### 21.2.3 Outbox de eventos

**`webhook_events`** (outbox transacional — todo evento de domínio nasce aqui)
| Coluna | Tipo | Nota |
|---|---|---|
| `id` | text PK | `evt_...` (ULID/KSUID — ordenável no tempo); é o `event.id` do envelope |
| `org_id` | uuid FK | RLS |
| `type` | text FK → `webhook_event_types.type` | |
| `api_version` | text | versão do schema no momento da emissão |
| `data` | jsonb | payload (`data` do envelope), validado contra `schema` |
| `idempotency_key` | text null | chave natural do produtor (evita evento duplicado em retry de quem emite) |
| `sequence` | bigint | monotônico **por org** (sequence/identity) p/ o consumidor reordenar |
| `occurred_at` | timestamptz | quando a mudança ocorreu (= `created_at` do envelope) |
| `status` | enum | `pending\|fanned_out\|no_subscribers\|failed_fanout` |
| `fanned_out_at` | timestamptz null | |

Constraints/índices:
- `UNIQUE (org_id, type, idempotency_key)` parcial `WHERE idempotency_key IS NOT NULL` — produtor não duplica evento (ex.: retry de webhook Asaas re-emitindo `payment_succeeded`).
- Índice `(status, id)` para o fanout worker pegar `pending`.
- `sequence` via `GENERATED ... AS IDENTITY` ou sequence por org (Open Question: per-org vs global).
- Retenção: outbox antigo (já `fanned_out`) é expurgado por cron (ex.: 30 dias) — não é log eterno (o log de entrega é o `webhook_deliveries`).

#### 21.2.4 Entregas

**`webhook_deliveries`** (estende §25.6 — `id`, `webhook_id`, `event`, `status`, `attempts`)
| Coluna | Tipo | Nota |
|---|---|---|
| `id` | text PK | `del_...` |
| `org_id` | uuid FK | RLS |
| `webhook_id` | uuid FK → `webhooks` | endpoint destino |
| `event_id` | text FK → `webhook_events.id` | qual evento |
| `event_type` | text | desnormalizado p/ filtro/painel rápido |
| `status` | enum `delivery_status` | `pending\|delivering\|succeeded\|retry_scheduled\|failed_permanent\|dead_letter` |
| `attempts` | int default 0 | nº de tentativas feitas |
| `max_attempts` | int default 8 | |
| `next_attempt_at` | timestamptz null | backoff |
| `last_status_code` | int null | resposta do cliente |
| `last_response_snippet` | text null | primeiros ~2KB do body (debug; sem PII sensível) |
| `last_error` | text null | timeout/conn/DNS |
| `request_headers` / `request_body_hash` | jsonb / text | auditoria (não guardar body cru cifrado a menos que necessário) |
| `duration_ms` | int null | latência da última tentativa |
| `delivered_at` | timestamptz null | quando deu 2xx |
| `created_at` / `updated_at` | timestamptz | |

Constraints/índices:
- `UNIQUE (event_id, webhook_id)` — **idempotência do fan-out** (um evento nunca entrega 2x ao mesmo endpoint).
- Índice `(status, next_attempt_at)` — worker pega prontos para (re)tentar.
- Índice `(webhook_id, created_at DESC)` — painel "últimas entregas do endpoint".
- Índice parcial `(org_id) WHERE status='dead_letter'` — painel DLQ.
- A **fila** real é pgmq (`webhook_delivery_q`); esta tabela é o **estado durável/auditável** espelhado (mesmo padrão do §19 `connection_sync_state`).
- Retenção: deliveries `succeeded` expurgadas após ~30–90 dias (log de entrega não é eterno; LGPD §26). DLQ retida mais tempo para replay.

#### 21.2.5 Tabelas de outros domínios tocadas

- **`audit_logs`** (§25.6): criar/editar/pausar/remover endpoint, **rotação de segredo**, replay (individual e em massa), auto-disable → `action=webhook.created`/`webhook.secret_rotated`/`webhook.replayed`, `actor`, `target=webhook_id`.
- **`webhook_events` (outbox)** é escrito por **todos os domínios produtores** via o helper `emit_domain_event()` (§07/§08/§09/§10/§11/§12/§14/§19). Convenção: o produtor **não** conhece endpoints — só emite no outbox; o fan-out é deste domínio.
- **`api_keys`** (§25.6, dono = public-api/auth-rbac §06): Zapier/Make e consumidores headless autenticam **actions** com API key; este domínio não cria api_keys, **reusa**.
- **`idempotency_keys`** (fundação §05): `POST /v1/webhooks` e replays usam o middleware de idempotência transversal.
- **`inbound_events`/`asaas_webhook_events`** (§19/§10): **entrada** — NÃO são deste domínio; citadas só na fronteira (§21.1.11).

---

### 21.3 API & Edge Functions

#### 21.3.1 Endpoints `/v1` (REST pública — admin/headless; §21)

**Gestão de endpoints (webhooks de saída)**
```
GET    /v1/webhooks                          # lista endpoints da org (sem secret)
POST   /v1/webhooks                          # registra endpoint (events[], url); retorna secret UMA vez
GET    /v1/webhooks/{id}                     # detalhe (sem secret)
PATCH  /v1/webhooks/{id}                     # editar url/events/filters/description/status (pause)
DELETE /v1/webhooks/{id}                     # remove endpoint
POST   /v1/webhooks/{id}/rotate-secret       # rotaciona secret (grace de 24h); retorna novo secret UMA vez
POST   /v1/webhooks/{id}/test                # envia evento de teste (ping) p/ validar a URL/assinatura
```

**Log de entregas, DLQ e replay**
```
GET    /v1/webhooks/{id}/deliveries          # log de entregas (filtro por status/type/data); cursor
GET    /v1/webhooks/deliveries/{deliveryId}  # detalhe: request/headers/response/erro/tentativas
POST   /v1/webhooks/deliveries/{deliveryId}/replay   # replay de UMA entrega (inclui da DLQ)
POST   /v1/webhooks/{id}/replay              # replay em massa por janela/filtro (DLQ das últimas 24h, type X)
```

**Catálogo de eventos (portal do dev)**
```
GET    /v1/webhooks/event-types              # catálogo (types, schema, exemplo, api_version)
GET    /v1/webhooks/event-types/{type}       # detalhe de um type + exemplo de payload
```

> **Auth:** todos sob JWT (admin com permissão do módulo `developers`) ou API key com escopo `webhooks:write`. **Exceção:** o **POST de entrega** ao cliente NÃO é um endpoint nosso — é o cliente quem recebe. A rota `/test` é dogfooding (manda um `webhook.test` real assinado).

#### 21.3.2 Edge Functions / Jobs internos

| Função | Tipo | Descrição |
|---|---|---|
| `emit_domain_event` | helper SQL/TS (não job) | Chamado **na transação** do produtor: valida `type` no catálogo + `data` contra `schema`, INSERT no outbox `webhook_events` (idempotente). É o **único** ponto de emissão. |
| `webhook-fanout-worker` | consumer pgmq | Lê `webhook_events` `pending`, resolve endpoints assinantes (match de `events`+wildcard+filtros), cria `webhook_deliveries` em bulk (idempotente), marca `fanned_out`/`no_subscribers`. |
| `webhook-delivery-worker` | consumer pgmq | Pega deliveries prontas, carrega secret (decifra), assina HMAC, POST com timeout, classifica resposta (2xx/4xx/5xx), grava estado, backoff/DLQ, atualiza breaker. |
| `webhook-breaker-cron` | pg_cron | Probes de endpoints `open`/`degraded` (half-open), fecha/reabre breaker, retoma fila represada, **auto-disable** após X dias de falha contínua + notifica admin. |
| `webhook-retry-scheduler` | pg_cron (ou pgmq delay) | Promove `retry_scheduled` cujo `next_attempt_at <= now` de volta para a fila de entrega. |
| `webhook-reaper-cron` | pg_cron | Expurga outbox/deliveries `succeeded` antigos (retenção/LGPD); move DLQ além da retenção para arquivo frio/expurgo. |
| `webhook-test-sender` | função | Dispara o evento de teste (`webhook.test`) assinado p/ a URL — usado por `/test` e pelo wizard de registro. |

> **Dogfooding e adapter pattern (núcleo de código):** a assinatura HMAC, o backoff e o classificador de resposta são **um único módulo** reusado; adicionar um event type **não** toca o motor. O `webhook-delivery-worker` é agnóstico ao type — só conhece envelope + endpoint + secret.

> **pg_net vs fetch:** entrega via `fetch` no Edge worker (controle fino de timeout/headers) é o padrão; `pg_net` é alternativa para disparo direto do banco em jobs. Decisão de implementação (Open Question menor) — recomendação: worker Edge com `fetch` + pgmq para visibilidade/lock.

---

### 21.4 Telas / Front

#### 21.4.1 Admin — módulo "Desenvolvedores" (§10.1 item 13)

- **Lista de webhooks:** tabela de endpoints (URL, eventos assinados, status com badge — `ativo`/`pausado`/`instável`/`auto-desativado`), taxa de sucesso 24h, última entrega. CTA **Novo webhook**.
- **Wizard de novo webhook (modal):** campo URL (valida HTTPS + ping), **multiselect de eventos** (agrupados por domínio, com wildcard "todos de subscription"), exibe o **secret gerado UMA vez** com botão copiar + aviso "guarde agora, não mostraremos de novo". Botão **Enviar evento de teste** que mostra a resposta do endpoint ao vivo (status, latência) — valida assinatura do lado do cliente antes de ir pra produção.
- **Detalhe do webhook:** status + circuit breaker (banner "Endpoint instável/desativado — reative") + botões **Rotacionar segredo** (mostra novo secret uma vez + explica grace de 24h), **Pausar/Reativar**, **Remover**, **Replay em massa** (janela/type). Métricas: sucesso/falha por dia, latência p50/p95.
- **Log de entregas (delivery log):** lista paginada por endpoint com filtro por **status** (sucesso/falha/DLQ) e **type**; cada linha → **drawer** com request (headers + body enviado), response (status + body recebido), erro, nº de tentativas, timeline de retries. Botão **Reenviar** (replay individual) em cada entrega.
- **Painel DLQ:** dead-letters agrupados por endpoint; **replay em massa** com seleção; explica "por que foi para DLQ" (esgotou tentativas / endpoint 4xx).
- **Catálogo de eventos (portal do dev):** lista de event types com **exemplo de payload** renderizado, schema, `api_version`, e snippets de **verificação de assinatura** (Node/Deno/Python/PHP) — copy-paste. Dogfooding do OpenAPI/§21.
- **Zapier/Make:** card "Conectar via Zapier/Make" (deep-link para o app) na tela de integrações (§19) e em Desenvolvedores.

> **Permissões (§06):** módulo `developers` com ações `read`/`write`/`manage`. Rotacionar segredo, ver o secret e replay em massa exigem `developers.write`/`manage`. Operator/staff de porta **não** acessa.

#### 21.4.2 Membro

- **Nenhuma tela de membro.** Webhooks são infraestrutura para o dono/parceiro. (O membro nunca vê este domínio.)

---

### 21.5 Integrações externas

| Serviço | Papel | Como integra |
|---|---|---|
| **Endpoints HTTP do cliente** | Destino dos webhooks de saída | POST assinado HMAC; o cliente verifica e responde 2xx. Documentação + snippets no portal. |
| **Zapier** | Triggers (REST Hooks) + Actions (API) | App oficial gerencia subscribe/unsubscribe via `POST/DELETE /v1/webhooks`; actions via `/v1`. Auth por API key/OAuth. (Capability `automation` §19.) |
| **Make (Integromat)** | Instant triggers (webhook) + módulos (API) | Mesmo modelo do Zapier. |
| **Asaas** | Webhook de **entrada** | Recebido e verificado por **payments-billing §10** (`POST /v1/webhooks/asaas`, token compartilhado em header). Efeitos → emitem eventos de saída deste domínio (`subscription.payment_*`). |
| **Discord** | Webhook de **entrada** | Recebido/verificado por **§19** (Ed25519). Eventos normalizados (`member.left_discord`) → emitem saída via este domínio. |
| **Supabase pgmq / pg_cron / pg_net** | Infra | Fila de entregas, schedulers de retry/breaker/reaper, HTTP de saída. |
| **Provedor de e-mail (§17/§30)** | Notificação ao admin | Alerta de endpoint `auto_disabled`/breaker aberto. |

> **Fronteira reforçada:** este domínio **não** verifica assinatura de **entrada** de Asaas/Discord (isso é §10/§19). Ele **assina** (HMAC) o que **sai**. O cruzamento é: entrada normalizada → `emit_domain_event` → saída.

---

### 21.6 Épicos & tarefas

#### Épico A — Catálogo & modelo de dados
- A1 (M) Migration `webhook_event_types` (catálogo global) + enums + seed dos 8 types MVP (§21.1.2) com `schema` e `example_payload`.
- A2 (M) Migration `webhooks` estendida (status, breaker_state, secret cifrado + secret_prev, api_version, events[], filters, contadores) + índices (GIN em events) + RLS + view sem secret.
- A3 (M) Migration `webhook_events` (outbox: id ULID, sequence por org, idempotency_key unique parcial, status) + índices.
- A4 (M) Migration `webhook_deliveries` estendida (status, attempts, backoff, response_snippet, breaker fields) + `UNIQUE(event_id,webhook_id)` + índices (DLQ, por endpoint, prontas-p/-retry).
- A5 (S) Cifragem do `secret` (Vault/pgsodium) + helper `loadSecret`/`storeSecret` (só Edge, nunca loga) + geração CSPRNG.
- A6 (S) RLS + testes de isolamento por org; garantir que o front nunca lê `secret`.

#### Épico B — Emissão (transactional outbox)
- B1 (M) Helper `emit_domain_event(type, org_id, data, idempotency_key?)`: valida type no catálogo + `data` contra JSON Schema, INSERT idempotente no outbox **na transação do produtor**.
- B2 (S) Contrato/SDK interno para os domínios produtores (§07–§14, §19) chamarem o helper de forma uniforme.
- B3 (S) Sequence monotônico por org no outbox + `occurred_at`.

#### Épico C — Fan-out
- C1 (M) `webhook-fanout-worker` (pgmq): resolve assinantes por type + **wildcard por prefixo**, cria deliveries em bulk idempotente, marca `fanned_out`/`no_subscribers`.
- C2 (S) Matching de wildcard (`subscription.*`) + índice GIN; testes de fan-out grande (N endpoints).
- C3 (S) Filtros por atributo do payload (estrutura pronta; ativação pós-MVP).

#### Épico D — Entrega, assinatura e backoff
- D1 (L) `webhook-delivery-worker`: monta envelope canônico + headers, **assina HMAC** (`t=,v1=`), POST com timeout, classifica 2xx/4xx/5xx, grava estado + response snippet.
- D2 (M) **Backoff exponencial + jitter** + respeito a `Retry-After`; `retry_scheduled` + `webhook-retry-scheduler`.
- D3 (M) Classificação 4xx (permanente) vs 5xx/timeout/conn (transitório) vs 408/429 (transitório) → DLQ ao esgotar.
- D4 (S) Replay individual (`/deliveries/{id}/replay`) reusando o mesmo `event.id` (idempotência no consumidor).
- D5 (M) Replay em massa (`/webhooks/{id}/replay`) por janela/type/status (DLQ recovery).

#### Épico E — Resiliência: endpoint fora do ar
- E1 (M) Contador `consecutive_failures` + estados `degraded` e **circuit breaker** (`closed/open/half_open`) por endpoint.
- E2 (M) `webhook-breaker-cron`: probes half-open, fechar/reabrir, represar fila do endpoint aberto (bulkhead).
- E3 (S) **Auto-disable** após X dias de falha contínua ou `410 Gone` + notificação ao admin (e-mail + banner).
- E4 (S) Rotação de segredo com **grace de 24h** (dois secrets válidos) + `webhook.secret_rotated` no audit.

#### Épico F — Payloads grandes & versionamento
- F1 (S) Teto de tamanho do `data` + `data_truncated` + `resource_url` (thin event fallback).
- F2 (S) `api_version` fixada por endpoint + envelope estável; estratégia de evolução de schema sem breaking.

#### Épico G — API & portal do dev
- G1 (M) Endpoints `/v1/webhooks` CRUD + rotate-secret + test (secret exibido uma vez).
- G2 (M) `/v1/webhooks/{id}/deliveries` + `/deliveries/{id}` (log com request/response/tentativas) + cursor.
- G3 (S) `/v1/webhooks/event-types` (catálogo + exemplo + schema) servido do `webhook_event_types`.
- G4 (S) `webhook-test-sender` (`webhook.test` assinado) + validação de URL (HTTPS, SSRF guard).

#### Épico H — Telas (admin "Desenvolvedores")
- H1 (M) Lista de webhooks + status/breaker + taxa de sucesso.
- H2 (M) Wizard de novo webhook (multiselect de eventos, secret uma vez, enviar teste ao vivo).
- H3 (M) Detalhe + delivery log (drawer request/response) + replay individual.
- H4 (S) Painel DLQ + replay em massa.
- H5 (S) Catálogo de eventos (exemplos + snippets de verificação) no portal do dev.

#### Épico I — Zapier/Make (pós-MVP no app; infra no MVP)
- I1 (S) REST Hook subscribe/unsubscribe testado contra `POST/DELETE /v1/webhooks` (compatível com Zapier).
- I2 (M) App Zapier oficial (triggers por type + actions sobre `/v1`) — **pós-MVP**.
- I3 (S) App Make oficial — **pós-MVP**.

#### Épico J — Observabilidade & segurança
- J1 (S) Métricas: entregas sucesso/falha/latência p50/p95 por endpoint e por type, tamanho da DLQ, breaker abertos → §27.
- J2 (S) **SSRF guard** na URL do endpoint (bloquear IP privado/loopback/metadata, exigir HTTPS, resolver DNS no envio).
- J3 (S) Audit log de create/edit/rotate/replay/auto-disable; alertas (DLQ crescendo, endpoint auto-desativado, breaker aberto > N).

---

### 21.7 Dependências

| Depende de | Por quê |
|---|---|
| **fundacao** | pgmq (fila de entrega), pg_cron (retry/breaker/reaper), pg_net/fetch, RLS por org, Vault para cifrar `secret`, `idempotency_keys`/`audit_logs`, esqueleto `/v1`/OpenAPI, convenção de migrations. Pré-requisito universal. |
| **auth-rbac** | Permissão do módulo `developers` (criar/editar/rotacionar/replay são ações sensíveis, escopo por org); API key com escopo `webhooks:*` para Zapier/headless. |
| **public-api** | Os webhooks **complementam** a API `/v1`: registro de endpoint, payloads `resource_url` e as **actions** do Zapier são chamadas à mesma API pública; envelope segue convenções (snake_case, ISO-8601, cursor). |
| **integrations-framework (§19)** | Domínio **irmão**: webhooks de **entrada** (Asaas/Discord) são recebidos/verificados lá; eventos normalizados (`member.left_discord`) chamam `emit_domain_event` daqui. Capability `automation` (Zapier/Make) é catalogada lá. |
| **crm / member-identity** | Produtores de `member.created`, `member.churned`, `member.segment_entered/left` (via `emit_domain_event`). |
| **tiers-perks** | Produtor de `member.tier_changed`, `member.entitlements_changed`. |
| **payments-billing** | Produtor de `subscription.payment_succeeded/failed`, `subscription.canceled/renewed`, `transaction.refunded/chargeback`, `payout.paid`; dono do webhook **de entrada** Asaas (efeitos → eventos de saída daqui). |
| **passport** | Produtor de `passport.issued/updated/revoked/token_rotated`. |
| **verification-checkin** | Produtor de `event.checkin`. |
| **content-gating** | Produtor de `content.published`. |
| **events-tickets** | Produtor de `ticket.issued/refunded`, `event.created`. |
| **communication** | Reuso do provedor de e-mail para notificar admin de endpoint auto-desativado; campanhas podem ser **actions** via Zapier. |
| **security-lgpd** | Cifragem de `secret`, SSRF guard, retenção de payloads (eventos `is_pii`), DPA com destinos. |
| **observability-qa** | Painel de entregas/DLQ/breaker, métricas e alertas (§27). |
| **design-system / admin-app** | Telas do módulo Desenvolvedores (lista, wizard, delivery log, DLQ, catálogo). |
| **superadmin** | Catálogo global `webhook_event_types` é gerido pelo time Stanbase; visão cross-org de saúde de entregas. |

> **Dependência mais crítica:** **todos os domínios produtores** (§08/§09/§10/§11/§12/§14/§19) — sem o `emit_domain_event` adotado por eles, o outbox fica vazio e não há o que entregar. O motor de entrega é genérico, mas **depende de adoção uniforme** do helper de emissão (por isso B2 é tarefa de contrato).

---

### 21.8 Riscos & decisões técnicas

1. **Endpoint do cliente fora do ar (edge case central).** Caído por horas/dias enche a fila e martela à toa. **Mitigação:** backoff exponencial + jitter, circuit breaker por endpoint (bulkhead — não afeta endpoints saudáveis), represamento em vez de retry individual, **auto-disable** após X dias + notificação, **replay em massa** quando volta. `410 Gone` = auto-disable imediato.
2. **Ordering não garantido.** Retries embaralham; `member.created` pode chegar depois de `subscription.payment_succeeded`. **Decisão:** at-least-once **unordered** por padrão (documentado!), com `sequence`/`occurred_at` no envelope para o consumidor reordenar. Ordering serial por `ordering_key` é **opt-in pós-MVP** (head-of-line blocking controlado). Não prometer ordem que não entregamos.
3. **Idempotência no consumidor.** Retries reentregam o mesmo evento → o consumidor pode processar 2x. **Mitigação:** `event.id` estável em retries (não muda!) + header `X-Stanbase-Event-Id` + documentação explícita "deduplique por id". É **responsabilidade do consumidor**, mas nós damos a chave estável e o snippet.
4. **Idempotência na emissão (lado nosso).** Produtor reprocessa (retry de webhook Asaas re-emite `payment_succeeded`) → outbox duplicado → fan-out duplicado. **Mitigação:** `UNIQUE(org_id, type, idempotency_key)` no outbox + `UNIQUE(event_id, webhook_id)` na delivery. Dupla barreira.
5. **Transactional outbox obrigatório.** Disparar HTTP "na hora" arrisca webhook para mudança que sofreu rollback, ou mudança comitada sem webhook. **Decisão:** emitir no outbox **na mesma transação** + fan-out/entrega assíncronos. Nunca chamar HTTP do cliente dentro da transação de negócio (latência + acoplamento).
6. **Payloads grandes.** Objeto inteiro infla o POST, dá `413`/timeout, vaza PII. **Decisão:** thin events por default (ids + essenciais) + `data_truncated`/`resource_url` acima do teto (256 KB). Mídia nunca no corpo.
7. **Segredo rotacionado.** Rotacionar e cortar o antigo na hora derruba o consumidor que ainda valida com o velho. **Decisão:** **grace de 24h com dois secrets válidos** (assinamos com o novo; verificamos ambos do lado documentado); secret exibido **uma vez** (cifrado em repouso, nunca relogado).
8. **Fan-out grande.** 1 evento × N endpoints = N deliveries; uma org com muitos Zaps multiplica carga. **Mitigação:** fan-out em bulk assíncrono, deliveries independentes, limite de endpoints por org, breaker isola endpoint problemático.
9. **SSRF via URL do webhook.** Org cadastra `http://169.254.169.254/...` ou IP interno → o worker vira proxy para a rede interna. **Mitigação:** exigir HTTPS, **bloquear IP privado/loopback/link-local/metadata** (resolver DNS no momento do envio, rejeitar ranges privados), egress controlado.
10. **Verificação de assinatura mal feita (lado do consumidor).** Fonte #1 de tickets. **Mitigação:** assinar sobre **raw body**, incluir timestamp no conteúdo assinado (anti-replay), publicar snippets prontos por linguagem e um `/test` que mostra a resposta ao vivo.
11. **Retenção de logs com PII (LGPD).** `webhook_deliveries.last_response_snippet` e o `data` de eventos `is_pii` podem conter e-mail/nome. **Mitigação:** retenção curta + `webhook-reaper-cron`, não guardar body cru além do snippet, marcar `is_pii` no catálogo, DPA com destinos (§26).
12. **Versionamento de schema de evento.** Mudar o `data` de um evento quebra integrações vivas. **Decisão:** `api_version` **fixada por endpoint**; mudanças breaking = novo `api_version` + período de coexistência; aditivas (campos novos) são não-breaking.
13. **Fronteira in × out borrada.** Tentação de reimplementar ingest de Asaas/Discord aqui. **Decisão:** entrada é §10/§19; este domínio só **sai** + entrega o que `emit_domain_event` recebe. `webhook_deliveries` (out) é nosso; `asaas_webhook_events`/`inbound_events` (in) não.
14. **`webhook.test` e dogfooding.** O teste precisa ser um evento **real assinado** (não um mock), senão valida algo diferente do que produção entrega. Usar o mesmo motor (`webhook-test-sender` → `webhook-delivery-worker`).
15. **DLQ que cresce sem ninguém olhar.** Vira buraco negro. **Mitigação:** alerta quando DLQ por org/endpoint cruza limiar, painel com replay em massa, retenção que expurga DLQ velha após X dias (com aviso).

---

### 21.9 Escopo MVP vs. depois

#### MVP (alinhado a §29 Fase 4 — "Plataforma para devs: API + webhooks + Zapier + MCP + SDKs"; mas a **infra de emissão** já é necessária na Fase 1–2 porque payments/passport/checkin emitem eventos)
- **Catálogo** dos 8 event types MVP (§21.1.2) + envelope canônico versionado.
- **Transactional outbox** (`webhook_events`) + helper `emit_domain_event` adotado pelos produtores (§08/§09/§10/§11/§12/§14).
- **Fan-out** (com wildcard por prefixo) + **delivery worker** com **assinatura HMAC**, **backoff exponencial + jitter**, classificação 4xx/5xx, **DLQ**, **replay manual** (individual e em massa).
- **Endpoints `/v1/webhooks`** CRUD + rotate-secret (grace 24h) + `/test` + **log de entregas** + DLQ.
- **Resiliência:** circuit breaker por endpoint + auto-disable + notificação ao admin. SSRF guard.
- **Thin events** + `resource_url` para payloads grandes.
- **Telas do módulo Desenvolvedores:** lista, wizard (secret uma vez + teste ao vivo), delivery log com drawer, DLQ, **catálogo de eventos com snippets de verificação**.
- **Compatibilidade Zapier** via REST Hooks (`POST/DELETE /v1/webhooks`) — o app publicado vem depois, mas a infra de subscribe/unsubscribe e as actions (API `/v1`) já funcionam.
- Observabilidade básica de entregas/DLQ/breaker (§27) + audit log.

#### Depois (Fases 4+)
- **App oficial Zapier/Make publicado** nos diretórios (triggers por type + actions ricas), com OAuth e polling fallback.
- **Ordering serial opt-in** por `ordering_key` (head-of-line blocking controlado).
- **Filtros ricos por atributo** do payload no fan-out (não só por type/wildcard).
- **Eventos reservados** ativados conforme os domínios entregam (`payout.paid`, `transaction.chargeback`, `passport.token_rotated`, `member.segment_*`, `ticket.*`, `member.left_discord`…).
- **Mais formatos de saída** (ex.: webhook para fila do cliente / EventBridge / Pub/Sub) e **co-assinatura/mTLS** para destinos de alta segurança.
- **Dashboard de saúde de entregas cross-org** no superadmin + SLA de entrega.
- **Schema registry público** versionado dos eventos (consumido por SDKs gerados do OpenAPI).
