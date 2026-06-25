## 28. Observabilidade & QA

> Domínio **transversal e de plataforma**: a malha de telemetria (logs estruturados, tracing, métricas, alertas, status page, health checks) que torna a Stanbase operável, mais a **estratégia de testes** (unit, RLS/policy, contract contra OpenAPI, e2e admin/membro, carga) que torna cada release confiável, e a camada de **analytics de produto** (com consentimento LGPD). É o domínio que responde a três perguntas operacionais: *"está no ar?"* (health/status), *"está saudável?"* (métricas/SLO), *"por que quebrou?"* (logs/tracing) — e a uma pergunta de release: *"posso fazer deploy?"* (suíte de testes verde + gates).
>
> Fontes de verdade no doc: **§27** (observabilidade, métricas e analytics — escopo central), §6 (stack: Edge Functions, pgmq/pg_cron, Realtime), §6.2 (`request_id`, idempotência, auditoria por chamada), §10.2 (métricas-chave do dashboard de produto — **propriedade de `admin-app`, não deste domínio**), §21.1 (`request_id`, envelope de erro, rate limit), §22 (webhook deliveries: retries, DLQ, log de entregas, replay), §25.6 (`webhook_deliveries`, `audit_logs`), §26 (segredos nunca em log, LGPD, consentimento por canal), §28 (ambientes dev/staging/prod separados; CI roda testes de RLS e contrato; geração de SDK/MCP no CI), §29 (faseamento).
>
> **Fronteira dura com a Fundação (§05):** a fundação **já entrega** os blocos primitivos de telemetria — o `logger.ts` estruturado (`request_id`, redaction de PII/segredos), o `_shared` com envelope de erro, os jobs `dlq-monitor`, `audit-retention`, `health-canary`, a infra de `pgmq`/`pg_cron`, e os 3 ambientes Supabase. Este domínio **não reinventa** esses primitivos; ele os **cabeia numa malha coerente, multi-tenant e acionável**: define o **schema do log** (campos obrigatórios, `trace_id`/`span_id`), o **pipeline de export** (Edge logs → sink externo), a **tabela de métricas/eventos** e os **SLOs**, transforma `dlq-monitor`/`health-canary` em **status page + alertas roteados**, e implementa a **disciplina de testes em CI**. Quando este doc diz "a fundação já loga X", X é pré-requisito; o que **falta** (correlação, agregação, alerta, dashboard, painel de QA) é escopo daqui.
>
> **Fronteira com `admin-app` e os domínios de negócio:** as **métricas de produto** (MRR, churn, funil, coortes, distribuição por tier — §10.2) são **calculadas e expostas pelos domínios donos** (`payments-billing`, `crm`, `ai-layer`) e **renderizadas pelo `admin-app`**. Este domínio fornece a **infra de eventos de analytics** (coleta com consentimento, tabela `product_events`, pipeline) e o **dashboard técnico interno** (saúde da plataforma, para o superadmin), não os KPIs de negócio do dono. A linha: *negócio do dono* → admin-app/domínios; *saúde da plataforma + qualidade do código* → aqui.

---

### 1. Como funciona

#### 1.1 As cinco superfícies de observabilidade (vocabulário)

Para não misturar conceitos, fixamos cinco superfícies distintas, cada uma com dado, consumidor e retenção próprios:

| Superfície | Pergunta que responde | Dado primário | Consumidor | Retenção típica |
|---|---|---|---|---|
| **Logs** | "O que aconteceu nesta request/job?" | linha JSON estruturada por evento | dev (debug), superadmin (forense) | 7–30d quente, 90d frio |
| **Traces** | "Por onde passou e onde demorou?" | spans correlacionados por `trace_id` | dev (latência, gargalo) | 7–14d (amostrado) |
| **Métricas** | "Está saudável agora / na tendência?" | séries temporais agregadas (p50/p95/p99, erro%, throughput) | superadmin (SLO), on-call | 13 meses (agregado) |
| **Health/Status** | "Está no ar?" | resultado de probes sintéticos | público (status page), uptime monitor | 90d |
| **Analytics de produto** | "Como o membro/admin usa?" | eventos de produto com consentimento | dono (via admin-app), produto Stanbase | conforme LGPD/consentimento |

> **Regra de ouro:** os quatro primeiros são **operacionais/da plataforma** (donos = Stanbase). O quinto é **de produto** e cruza a fronteira LGPD (dados de pessoas), exigindo **consentimento** e isolamento multi-tenant. Misturar telemetria operacional com PII de membro é o erro mais comum e mais caro — mantê-los em pipelines separados é decisão de arquitetura (§8).

#### 1.2 Anatomia de um log estruturado (o contrato de log)

A fundação entrega o `logger.ts`; **este domínio fixa o schema obrigatório** que todo log de Edge Function, job e worker deve emitir — uma linha JSON, nunca texto livre:

```json
{
  "ts": "2026-06-24T18:03:11.482Z",
  "level": "info|warn|error|fatal",
  "service": "v1-router|passport-issue|integration-sync-worker|jobs/...",
  "env": "dev|staging|prod",
  "trace_id": "trc_01J...",        // correlaciona toda a cadeia da request
  "span_id": "spn_01J...",         // este passo específico
  "parent_span_id": "spn_...|null",
  "request_id": "req_01J...",      // = trace_id na entrada; exposto no header x-request-id
  "org_id": "uuid|null",           // tenant — chave de TODA observabilidade multi-tenant
  "actor": "user:uuid|apikey:id|system|anon",
  "credential_type": "jwt|api_key|oauth_client|none",
  "mode": "live|test",             // sandbox vs real (§ public-api 1.9)
  "route": "POST /v1/subscriptions",
  "status": 201,
  "error_code": "validation_failed|null",
  "latency_ms": 142,
  "db_ms": 38,                     // tempo gasto em queries (sub-span)
  "external_ms": 61,               // tempo gasto chamando provider externo (Asaas, Discord)
  "queue": "integration_sync_q|null",
  "attempt": 1,
  "msg": "subscription created"
}
```

Regras concretas e invioláveis:
- **`org_id` em TODA linha** que tem contexto de tenant. Sem ele, nenhuma consulta multi-tenant (isolar a investigação de uma org) é possível. Jobs sem org (GC, retention) usam `org_id: null` + `service`.
- **`trace_id` propagado fim a fim:** nasce na borda (`v1-router` gera se o cliente não enviou `X-Trace-Id`/`traceparent`), viaja por **header** para chamadas internas (function→function), e é **gravado em colunas** quando o trabalho vira assíncrono (enfileira em `pgmq` com `trace_id` no payload → o worker continua o mesmo trace). É a única forma de seguir "request → enfileirou sync → worker chamou Discord → webhook-out".
- **Redaction obrigatória (herdada de §05/§26):** nunca logar `auth_token` de passe, `credentials` de connection, chave de API crua, body de cartão, `service_role`. O `logger` mantém uma **denylist** de chaves + um sanitizador de PII (e-mail/telefone → hash ou mascarado) aplicado **antes** de serializar. Violação é bug de segurança, pega no lint (§6 Épico F).
- **Níveis com semântica:** `error` = falhou esta request/job mas o sistema segue; `fatal` = invariante violada/corrupção (página o on-call). `warn` = degradação recuperável (retry agendado, `degraded`). Logar `error` para um `404` de cliente é ruído — `404` esperado é `info`.

#### 1.3 Tracing — o ciclo de uma requisição correlacionada

```
Cliente → [X-Trace-Id? gera] → v1-router (span: http.request)
   ├─ span: auth.resolve            (api_key lookup, 4ms)
   ├─ span: ratelimit.check         (1ms)
   ├─ span: idempotency.check       (db, 6ms)
   ├─ span: handler.subscriptions   (negócio)
   │     ├─ span: db.insert.subscription (22ms)
   │     └─ span: asaas.createCharge     (external, 380ms)  ← gargalo visível
   ├─ span: pgmq.enqueue entitlement_sync  (trace_id no payload)
   └─ response 201  (x-request-id, latency_ms total)
        ┊ (assíncrono, MESMO trace_id)
        └─ integration-sync-worker (span: sync.discord.grant_role, 210ms)
              └─ pgmq.enqueue webhook_out  (trace_id segue)
                    └─ webhook-dispatcher (span: deliver, 95ms, status 200)
```

- **Sem APM pago no MVP:** o tracing é **estruturado em logs** (todo span é uma linha de log com `trace_id`/`span_id`/`parent_span_id` + `duration_ms`), reconstruível por query. Um **adapter OpenTelemetry** (OTLP exporter) é plugável depois para Grafana Tempo/Honeycomb/Axiom sem reescrever instrumentação (a API de span é nossa, o backend é troca de adapter — §8). Decisão: **não acoplar a um vendor de APM no v0**; o schema de log já carrega tudo que um trace precisa.
- **Amostragem:** 100% de traces com `error`/`fatal` e 100% de POSTs financeiros; amostragem (ex.: 10%) de GETs de alto volume para conter custo de storage. `org_id` específico pode ser "always-sample" via flag (debug ao vivo de uma org problemática).
- **Edge case — trace que atravessa o PSP e volta:** quando o Asaas chama nosso webhook-in (`subscription.payment_succeeded`), **não há** `trace_id` original (o webhook é um novo trace). Ligamos os dois mundos por **`psp_ref`/`external_ref`** registrado em ambos os lados: o log da cobrança original carrega `psp_ref`, o log do webhook-in também → correlação por chave de negócio, não por trace. Documentar essa "costura por chave de negócio" para o on-call.

#### 1.4 Métricas e SLOs — o que medimos e os alvos

Métricas derivam dos logs (agregação) ou de probes. Os **SLOs** (objetivos) e seus **error budgets** guiam alertas (não alertar em tudo — alertar quando o budget queima):

| SLI (indicador) | Definição | SLO proposto (revisar §8) | Janela |
|---|---|---|---|
| **Disponibilidade API `/v1`** | % de requests não-5xx (exclui 4xx de cliente) | **99,9%** | 30d móvel |
| **Latência API `/v1` (leitura)** | p95 de GET | **< 300ms** | 30d |
| **Latência API `/v1` (escrita não-financeira)** | p95 de POST/PATCH | **< 600ms** | 30d |
| **Latência checkout (cria subscription)** | p95 fim a fim (inclui Asaas) | **< 2,5s** | 30d |
| **Disponibilidade do checkout/pagamento** | % de tentativas de cobrança que completam | **99,5%** | 30d |
| **Entrega de webhook-out** | % entregue em ≤ 3 tentativas | **99%** | 7d |
| **Latência de sync de integração** | tempo enqueue→aplicado, p95 (channel_sync) | **< 60s** | 7d |
| **Frescor do passport push** | mudança de tier → push de atualização do passe, p95 | **< 30s** | 7d |
| **Verify pública** | disponibilidade + p95 (porteiro escaneia QR) | **99,9% / < 400ms** | 30d |

- **Métricas por org (multi-tenant):** todo SLI é também quebrável por `org_id`. Um problema pode atingir **uma org** (Discord daquele dono caiu) sem mover o número global. O alerta global pega incidente de plataforma; o **painel por org** (e alerta opt-in por org) pega o incidente do tenant. Isso é a diferença entre "a plataforma está bem" e "este cliente está sofrendo".
- **Métricas de negócio NÃO são SLO:** MRR, churn, conversão (§10.2) são KPIs do **dono**, donos dos domínios `payments-billing`/`crm`/`ai-layer`. Aqui medimos **saúde técnica**. Não confundir "churn alto" (problema de negócio do dono) com "erro alto no cancelamento" (problema técnico nosso).
- **RED + USE:** para serviços (Edge/workers) usamos **RED** (Rate, Errors, Duration); para recursos (DB, fila, storage) usamos **USE** (Utilization, Saturation, Errors). A profundidade de fila `pgmq` (saturation) é métrica de primeira classe — fila crescendo = sync atrasando = perk não aplicado.

#### 1.5 Health checks e status page — a máquina de estados do incidente

Três níveis de health check, com profundidade crescente:

1. **Liveness** (`GET /v1/health` — já existe na fundação §05 3.1): o processo responde? DB ping ok? Retorna `{status, version, env, db}`. Barato, alta frequência, usado por load balancer/uptime monitor.
2. **Readiness/Deep** (`GET /v1/health/deep`, autenticado superadmin): checa dependências críticas — DB write, `pgmq` acessível, Storage, **e probes leves dos provedores externos** (Asaas, Apple/Google Wallet, LLM) via `connection-health-cron` do framework de integrações (§19). Retorna por dependência: `{name, status: ok|degraded|down, latency_ms, checked_at}`.
3. **Synthetic canaries** (`health-canary` cron, §05 3.4): jornadas sintéticas ponta a ponta num **tenant de canário dedicado** (org `__canary__`, dados de seed): emitir um passe de teste, fazer um verify, simular um checkout em **test mode**. Detecta quebra que liveness não pega (ex.: certificado Apple expirou → emissão falha mas `/health` está verde).

**Status page** — máquina de estados de componente:

```
operational ──► degraded_performance ──► partial_outage ──► major_outage
     ▲                  │                      │                 │
     └──────────────────┴──────────────────────┴─────────────────┘
                         (recovery quando probes voltam)
                              │
                        maintenance (estado manual, planejado)
```

- Componentes na status page: **API**, **Checkout/Pagamentos**, **Passport (Wallet)**, **Verify pública**, **Webhooks**, **Integrações (Discord/YouTube/etc.)**, **Painel admin**, **Front de membro**.
- **Transição automática** disparada por SLI cruzando limiar (ex.: erro% da API > 5% por 5 min → `degraded_performance`); **transição manual** (incidente declarado pelo on-call, manutenção planejada).
- **Status page é pública** (`status.stanbase.com`) e **per-component**, hospedada fora da infra principal (ou em provedor de status page tipo Instatus/Statuspage, ou estática em CDN) — não pode cair junto com o que monitora. **Edge case crítico:** se a status page roda na mesma Supabase que caiu, ela mente "tudo verde". Decisão: status page e seu probe **fora da Supabase principal** (§8).
- **Multi-tenant na status page:** a status page pública mostra **saúde da plataforma**, não de uma org. Incidente que afeta só uma integração de um dono **não** vai para a página pública — vai para um **banner no admin daquela org** (já previsto em §19: "Integração instável"). Não assustar 1000 donos por causa do Discord de 1.

#### 1.6 Monitoramento de webhooks de saída — status, retries, DLQ, replay

O doc §22 exige "entrega confiável: retries com backoff, dead-letter, log de entregas, replay manual". Este domínio é o **dono da observabilidade** desse fluxo (a entrega em si é do domínio `webhooks`; o painel/alerta/métrica é daqui — fronteira igual à de §19). Máquina de estados de uma **tentativa de entrega**:

```
queued ──► sending ──► delivered (2xx)                       [terminal ✓]
              │
              ├─► failed_transient (timeout/5xx/429) ──► retry_scheduled ──┐
              │         (backoff exponencial + jitter: 1m,5m,30m,2h,6h...)  │
              │                                                             │
              │◄────────────────────────────────────────────────────────────┘
              │         (até N tentativas, ex.: 8)
              │
              ├─► failed_permanent (4xx do endpoint do cliente: 400/410) ──► dead_letter
              └─► exhausted (esgotou retries) ────────────────────────────► dead_letter
                                                                              │
                                                          replay manual ──────┘ (volta a queued)
```

Regras de observabilidade:
- **Cada tentativa** vira linha em `webhook_delivery_attempts` (não só o agregado em `webhook_deliveries`) — para ver "tentou 5x, todas timeout às 3h da manhã".
- **DLQ visível e acionável:** painel lista entregas em `dead_letter` por org/endpoint/evento, com o **último erro**, o **payload** (redatado) e botão **replay**. Replay re-enfileira preservando `trace_id` original (correlação mantida).
- **Auto-disable de endpoint morto:** endpoint que retorna `410 Gone` ou falha 100% por > 24h → connection do webhook marcada `disabled` + alerta ao admin ("seu endpoint X parou de responder; reativamos quando você corrigir"). Evita martelar um endpoint morto eternamente (custo + ruído).
- **Métricas:** taxa de entrega por org/evento, latência de entrega, profundidade da fila de webhook, tamanho da DLQ (com tendência — DLQ crescendo é alerta). SLO em §1.4.
- **Edge case — tempestade de retry:** um cliente com endpoint instável pode gerar milhares de retries. **Quarentena por endpoint** (circuit breaker): após X falhas consecutivas, espaça agressivamente e não deixa esse endpoint monopolizar a fila/worker dos outros. Isolamento de "vizinho barulhento" multi-tenant.

#### 1.7 Monitoramento de syncs de integração e reconcile

Espelha §19 (que **executa** os syncs); aqui é o **olhar de observabilidade** sobre eles:
- **Estado de sync** (`connection_sync_state` de §19): contadores por connector de `succeeded/retry_scheduled/dead_letter`. DLQ de sync com replay (§19.3.1 `/sync-state/{jobId}/replay`) — o painel é o mesmo conceito do webhook DLQ.
- **Reconcile drift** (`reconcile_runs` de §19): drift detectado vs. corrigido por run. **Drift persistente** (mesmo membro/recurso diverge run após run) = alerta acionável: ou o mapping está `broken`, ou o provider rejeita silenciosamente. Tendência de drift é sinal de integração apodrecendo.
- **Connection health:** `degraded`/`revoked_by_provider`/`token_expired` persistente (§19 estados) → alerta ao admin da org (acionável: "reconecte"). Métrica global: % de connections saudáveis por connector (se 30% dos Discords estão `degraded`, é incidente de plataforma, não de tenant).
- **Métrica de frescor:** tempo entre o evento que gera a intenção (upgrade de tier) e o sync aplicado no provider (cargo concedido). É o SLI "latência de sync" do §1.4 — o que o membro sente como "paguei e o cargo não veio".

#### 1.8 Alertas acionáveis — a disciplina anti-ruído

Um alerta só existe se for **acionável** (alguém pode/deve fazer algo) e **endereçado** (vai para quem age). Regras:
- **Alerta = sintoma + impacto + ação sugerida + runbook.** Ex.: *"API erro% > 5% por 5min (SLO 99,9% — budget queimando) | impacto: ~N requests falhando | provável: deploy recente / Asaas / DB | runbook: link"*. Alerta sem runbook é dívida.
- **Roteamento por severidade:**
  - **P1 (page/acorda on-call):** queda total (verify pública down, checkout down, DB down, error budget de disponibilidade estourado).
  - **P2 (canal de alerta, horário comercial):** degradação (latência p95 acima do SLO, DLQ crescendo, taxa de webhook caindo, connector com 30%+ `degraded`).
  - **P3 (digest diário/semanal):** drift acumulando, certificado a expirar em 30d, fila lentamente subindo.
- **Multi-tenant — alerta global vs. por org:** alerta de plataforma (afeta muitos) ≠ alerta de tenant (afeta um). O segundo, por padrão, vira **banner/notificação no admin do dono**, não página o on-call da Stanbase. Exceção: orgs marcadas `tier_critico`/enterprise podem ter alerta dedicado (decisão de produto §8).
- **Anti-fadiga:** dedupe (mesmo alerta não dispara 100x), agrupamento (10 connections `degraded` do mesmo provider = 1 alerta "provider X instável"), supressão durante manutenção declarada, e **auto-resolução** (alerta fecha sozinho quando o SLI volta). Limiar de "página humano" é deliberadamente alto.
- **Alertas de domínio que pingam aqui** (já mapeados nos planos irmãos): §19 J3 (connection degraded, DLQ, refresh falhando), §10 (cobrança falhando em massa, webhook Asaas parado → entitlements não atualizam = **incidente silencioso perigosíssimo**), §11/§08 (certificado Apple/SA Google a expirar — **expiração de certificado de passe é incidente clássico esquecido**), §security-lgpd (tentativas de acesso negado anômalas).

#### 1.9 Ambientes, dados de seed e o tenant de canário

- **Três ambientes** (§28: dev/staging/prod, projetos Supabase separados). Observabilidade **por ambiente** — `env` em todo log/métrica; dashboards e alertas de prod são separados (alerta de staging **não** acorda ninguém).
- **Dados de seed determinísticos:** um pacote `supabase/seed` com **N orgs de exemplo cobrindo as verticais** (clube de carro, time, creator, balada), tiers/perks variados, membros em todos os lifecycle stages, transações live e test, eventos passados/futuros, connections em todos os estados (connected/degraded/revoked), webhooks com entregas ok/DLQ. **Por quê:** sem seed realista, e2e/carga/demos são fracos e as telas de observabilidade nunca são exercitadas com dados "feios". Seed é **idempotente e versionado** (roda em dev/staging/CI).
- **Tenant de canário (`__canary__`):** uma org reservada **em produção** onde os synthetic canaries (§1.5) e e2e de smoke pós-deploy rodam contra dados reais sem afetar clientes. Seus dados são **excluídos de toda métrica/analytics de negócio** (filtro `org_id != canary` em todo agregado) para não poluir. Edge case: esquecer de excluir o canário infla "membros ativos" e "transações" — o filtro é parte do contrato de qualquer query agregada.
- **Test mode vs. produção (§ public-api 1.9):** logs/métricas de `mode=test` são segregados dos de `mode=live`. Erro em sandbox não conta no error budget; transação test não entra em receita. `mode` é dimensão de toda métrica.
- **Edge case — PII em ambiente não-prod:** dados de seed são **sintéticos** (faker), nunca cópia de prod. Se algum dia precisar de dump de prod em staging para debug, é **anonimizado/mascarado** (LGPD §26) — nunca PII real fora de prod. Política explícita, validada em §security-lgpd.

#### 1.10 Analytics de produto com consentimento (LGPD)

A camada que cruza a fronteira de dados de pessoa, logo a mais regulada:
- **Eventos opt-in (§27, §26):** o front (admin e membro) emite eventos de produto (`page_view`, `tier_viewed`, `checkout_started`, `checkout_completed`, `content_played`, `wallet_added`) **somente se houver consentimento** do titular para a finalidade "analytics/produto". Sem consentimento → **nenhum** evento de comportamento é coletado (apenas o estritamente operacional/segurança, que tem base legal própria).
- **Consentimento por finalidade e por canal** (alinhado a §17 preferências e §26): banner/preferências distinguem "essencial" (sempre) de "analytics" e "marketing". A escolha do membro é registrada (`consent_records`, dono em `security-lgpd`) e **lida pelo coletor antes de gravar**.
- **Multi-tenant:** evento de produto carrega `org_id` e (quando consentido e identificado) `member_id`. O **dono vê analytics da sua org**; a **Stanbase vê agregados de plataforma** (cross-org, anonimizado/agregado — base legal de legítimo interesse para melhorar o produto, sem expor PII entre tenants). Isolamento RLS por `org_id` na tabela de eventos.
- **Pseudonimização:** id de visitante anônimo (pré-login) é um `anon_id` rotativo, **não** vinculado a PII até o login + consentimento; ao revogar consentimento, para de coletar e (a pedido) expurga histórico daquele titular (direito LGPD §26).
- **Onde mora o cálculo:** os **eventos brutos** moram aqui (pipeline + `product_events`); os **KPIs do dono** (funil, coorte) são montados pelo `admin-app`/domínios sobre esses eventos + dados transacionais. Não duplicamos o cálculo de MRR (isso é de billing).

#### 1.11 Estratégia de testes — as cinco camadas e seus gates

A pirâmide concreta da Stanbase, do mais rápido/barato ao mais lento/caro, com o **gate de CI** de cada uma:

| Camada | O que prova | Ferramenta | Onde roda | Gate |
|---|---|---|---|---|
| **Unit** | lógica pura (cálculo de juros/proração, gerador de Member ID, máquinas de estado, validadores, redaction do logger) | Vitest (front/pkgs), Deno test (Edge) | PR (rápido) | bloqueia merge |
| **RLS/Policy** | isolamento multi-tenant: org A nunca lê/escreve org B; service role filtra; rota pública mínima | pgTAP + harness 2-sessions | PR (DB efêmero) | **bloqueia merge** (segurança) |
| **Contract** | request/response batem com o `openapi.yaml`; sem drift schema↔código | Schemathesis/Dredd + validação de exemplos | PR | bloqueia merge |
| **E2E** | jornadas reais admin e membro (checkout, emitir passe, verify, check-in) | Playwright | merge→staging | bloqueia promote a prod |
| **Carga** | comportamento sob volume (checkout concorrente, verify em massa no evento, fila de sync) | k6 | agendado/pré-release | informa (não bloqueia) + SLO |

Detalhamento dos pontos não-óbvios:

- **RLS/Policy tests (o mais crítico — §26, §05 C5):** para cada tabela com `org_id`, provar com **duas sessões reais** (JWT de org A e org B) que: A não faz `SELECT`/`UPDATE`/`DELETE`/`INSERT` em linha de B; que `FORCE ROW LEVEL SECURITY` está on; que **service role bypassa** (logo o handler Edge precisa filtrar — testar que o handler filtra); que a **rota pública** (`verify`) expõe só o mínimo (sem PII sem token). Um teste gerado **por tabela** (lint que descobre tabela com `org_id` sem teste de RLS correspondente → falha CI). Esta é a **rede de segurança que sustenta a promessa multi-tenant inteira** — sem ela, um RLS esquecido vaza dados entre comunidades.
- **Contract tests (§28: "CI roda testes de contrato"):** o `openapi.yaml` é fonte da verdade (§ public-api). O teste de contrato: (a) valida que toda resposta real de `/v1` casa com o schema declarado (sem campo extra não documentado, sem campo faltando); (b) valida que os **exemplos** do OpenAPI são respostas válidas; (c) **property-based fuzzing** (Schemathesis) gera inputs do schema e verifica que a API nunca devolve 5xx para input válido nem aceita input inválido. Detecta o **drift** clássico: alguém muda o handler e esquece o spec (ou vice-versa) → quebra a promessa de paridade headless (§ public-api 1.1).
- **E2E admin × membro (§29 fases):** dois conjuntos de jornadas. **Admin:** criar org, montar tier+perk, ver membro, disparar campanha (mock de envio), check-in num evento. **Membro:** login social (mock OAuth), checkout de tier (Asaas **sandbox**), adicionar ao Wallet (mock de assinatura), abrir conteúdo gated, verify do próprio QR. Rodam contra **staging com seed** e contra o **tenant de canário em prod** (smoke pós-deploy, subconjunto).
- **Carga (§27 implícito em SLO):** cenários-alvo: **checkout concorrente** (capacidade limitada de tier "Founding Member: 100 vagas" — race de last-seat, §12), **verify em massa** (porta de evento: 500 scans em 2 min), **fila de sync** (upgrade em massa após drop → milhares de grants no Discord respeitando rate limit). Mede contra os SLOs do §1.4. **Edge case de carga:** rate limit do **provider externo** (Discord/Asaas) é o gargalo real, não o nosso código — o teste de carga precisa de **mocks dos providers** para medir o nosso sistema, e um teste separado (menor, contra sandbox real) para validar o backoff.
- **Testes de webhook/idempotência (atravessa domínios):** provar que reenviar o mesmo `Idempotency-Key` não duplica cobrança; que webhook-in duplicado (`provider_event_id`) é dedupado; que replay de DLQ não duplica efeito. São testes de integração de alto valor (o bug aqui custa dinheiro real).

#### 1.12 Regras de negócio concretas (resumo acionável)

1. Todo log de Edge/job/worker é JSON estruturado com o schema do §1.2; texto livre é proibido em produção.
2. `org_id`, `trace_id`, `env`, `mode` são dimensões obrigatórias de toda telemetria multi-tenant.
3. Segredos/PII **nunca** em log (denylist + sanitizador + lint).
4. Alerta sem runbook e sem ação não é criado; alerta de tenant não acorda on-call por padrão.
5. SLO define o que vira alerta; alerta dispara quando o **error budget** queima, não a cada erro isolado.
6. Status page e seus probes vivem **fora** da infra que monitoram.
7. Tenant de canário e `mode=test` são **excluídos** de toda métrica/analytics de negócio.
8. Analytics de produto só coleta com **consentimento** registrado; revogação para a coleta.
9. CI bloqueia merge sem unit + RLS + contract verdes; bloqueia promote a prod sem e2e verde.
10. Toda tabela com `org_id` tem teste de RLS correspondente (lint força).

---

### 2. Modelo de dados

> Princípio: telemetria de **alto volume** (logs/traces/eventos) **não** vive no Postgres operacional quente — vai para um **sink externo** (§5) ou tabelas **particionadas + retenção agressiva**. O Postgres guarda o que precisa de **RLS, replay e auditoria** (deliveries, alertas, eventos de produto consentidos, configuração). Tabelas de plataforma (sem `org_id`) usam policy de superadmin; tabelas com `org_id` herdam o RLS padrão (§05 2.3).

#### 2.1 Telemetria operacional (plataforma)

**`slo_definitions`** (config dos SLOs — superadmin)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK | |
| `key` | `text` UNIQUE | ex.: `api_availability`, `checkout_latency_p95` |
| `description` | `text` | |
| `target` | `numeric` | ex.: `0.999` ou `2500` (ms) |
| `comparator` | `text` | `gte`/`lte` |
| `window` | `interval` | `30 days` |
| `severity_on_breach` | `text` | `P1`/`P2`/`P3` |
| `enabled` | `bool` | |

**`alert_rules`** (regras de alerta — superadmin; opcional por org)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK | |
| `org_id` | `uuid` null | null = regra global de plataforma; preenchido = alerta por org |
| `slo_key` | `text` null | liga a `slo_definitions` (ou regra ad-hoc) |
| `metric` | `text` | `error_rate`, `dlq_depth`, `queue_depth`, `webhook_delivery_rate`, `cert_expiry_days` |
| `condition` | `jsonb` | `{op, threshold, for_minutes}` |
| `severity` | `text` | `P1`/`P2`/`P3` |
| `route` | `jsonb` | destino: `{channel: pagerduty\|slack\|email\|admin_banner, target}` |
| `runbook_url` | `text` | obrigatório p/ P1/P2 (CHECK) |
| `dedupe_key` | `text` | agrupamento |
| `enabled` | `bool` | |

**`alert_events`** (disparos — histórico/auditoria)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | `bigint` IDENTITY PK | |
| `rule_id` | `uuid` FK → `alert_rules` | |
| `org_id` | `uuid` null | tenant afetado, se aplicável |
| `status` | `text` | `firing`/`acknowledged`/`resolved`/`suppressed` |
| `severity` | `text` | |
| `value` | `numeric` | valor que cruzou o limiar |
| `fired_at` / `resolved_at` | `timestamptz` | |
| `trace_id` | `text` null | correlação com a causa |
| `notified` | `jsonb` | canais notificados + timestamps (dedupe) |
| | | índice `(status, fired_at desc)`, `(org_id, fired_at desc)` |

**`status_components`** (componentes da status page)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK | |
| `key` | `text` UNIQUE | `api`, `checkout`, `passport`, `verify`, `webhooks`, `integrations`, `admin`, `member` |
| `name` | `text` | rótulo público |
| `state` | `text` | `operational`/`degraded_performance`/`partial_outage`/`major_outage`/`maintenance` |
| `auto_managed` | `bool` | se transiciona por SLI ou só manual |
| `updated_at` | `timestamptz` | |

**`status_incidents`** + **`status_incident_updates`** (incidentes públicos)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK | |
| `title` | `text` | |
| `impact` | `text` | `minor`/`major`/`critical`/`maintenance` |
| `state` | `text` | `investigating`/`identified`/`monitoring`/`resolved` |
| `component_ids` | `uuid[]` | componentes afetados |
| `started_at`/`resolved_at` | `timestamptz` | |
| `is_public` | `bool` | incidente de plataforma (público) vs. interno |
| updates: `id`, `incident_id` FK, `body`, `state`, `at` | | timeline de comunicação |

**`health_probe_results`** (resultado de probes deep/canary — retenção curta, particionada por dia)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | `bigint` IDENTITY | |
| `probe` | `text` | `db_write`, `pgmq`, `storage`, `asaas`, `apple_wallet`, `google_wallet`, `llm`, `canary_checkout`, `canary_verify` |
| `env` | `text` | |
| `status` | `text` | `ok`/`degraded`/`down` |
| `latency_ms` | `int` | |
| `detail` | `jsonb` | erro/contexto |
| `at` | `timestamptz` | índice `(probe, at desc)` |

**`metric_rollups`** (séries agregadas pré-computadas por job, para o dashboard técnico — evita varrer logs ao vivo)
| Coluna | Tipo | Notas |
|---|---|---|
| `bucket` | `timestamptz` | janela (1m/5m/1h) |
| `env` | `text` | |
| `org_id` | `uuid` null | null = agregado de plataforma |
| `metric` | `text` | `req_count`, `err_count`, `p50_ms`, `p95_ms`, `p99_ms`, `webhook_delivered`, `webhook_failed`, `sync_dlq`, `queue_depth` |
| `dimensions` | `jsonb` | `{route, status_class, connector, mode}` |
| `value` | `numeric` | |
| | | PK composta `(bucket, env, org_id, metric, dimensions)`; particionada por dia/semana |

> **Logs e traces brutos NÃO têm tabela aqui** por padrão — vão para o sink externo (§5). Se for necessário um buffer no Postgres (ex.: para o painel sem sair da Supabase no MVP), uma `edge_request_log` **particionada por dia** com **retenção de 7–14d** (drop de partição, barato), nunca crescimento infinito. Decisão MVP em §8.

#### 2.2 Webhook deliveries (observabilidade; tabela base em §05/§22)

**`webhook_deliveries`** (do doc §25.6 — agregado por entrega; **tocada** aqui para observabilidade)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK | |
| `org_id` | `uuid` | RLS |
| `webhook_id` | `uuid` FK | endpoint do cliente |
| `event` | `text` | `member.tier_changed`, etc. (§22) |
| `event_id` | `text` | id do evento de origem (idempotência/replay) |
| `status` | `text` | `queued/sending/delivered/retry_scheduled/dead_letter` |
| `attempts` | `int` | |
| `next_attempt_at` | `timestamptz` null | |
| `last_status_code` | `int` null | resposta HTTP do cliente |
| `last_error` | `text` null | |
| `trace_id` | `text` | correlação |
| `created_at`/`delivered_at` | `timestamptz` | |
| | | índices `(org_id, status)`, `(status, next_attempt_at)` (scheduler), `(webhook_id, created_at desc)` |

**`webhook_delivery_attempts`** (NOVA — granularidade por tentativa, para diagnóstico)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | `bigint` IDENTITY | |
| `delivery_id` | `uuid` FK → `webhook_deliveries` | |
| `attempt_no` | `int` | |
| `status_code` | `int` null | |
| `error` | `text` null | timeout/dns/5xx |
| `duration_ms` | `int` | |
| `at` | `timestamptz` | |

> Retenção: `webhook_delivery_attempts` é particionada por semana com expurgo (alto volume). `webhook_deliveries` mantém o agregado por mais tempo (replay precisa do payload — payload guardado redatado/cifrado).

#### 2.3 Analytics de produto (com `org_id` + consentimento)

**`product_events`** (eventos de produto consentidos — RLS por org; particionada por dia)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | `bigint` IDENTITY | |
| `org_id` | `uuid` not null | RLS — dono vê só a sua |
| `member_id` | `uuid` null | só se identificado **e** consentido |
| `anon_id` | `text` null | visitante pseudônimo pré-login |
| `name` | `text` | `page_view`, `checkout_started`, `checkout_completed`, `content_played`, `wallet_added`, ... |
| `props` | `jsonb` | propriedades do evento (sem PII livre) |
| `consent_basis` | `text` | `consent`/`legitimate_interest`/`essential` — **gravado no evento** p/ auditoria LGPD |
| `session_id` | `text` null | |
| `app` | `text` | `admin`/`member` |
| `occurred_at` | `timestamptz` | índice `(org_id, name, occurred_at)` |
| | | particionada por dia; expurgo conforme retenção/consentimento |

> Relações: `member_id` → `members` (§07); o coletor cruza com `consent_records` (dono `security-lgpd` §26) **antes** de gravar — se não há base legal, não grava. `anon_id` vira `member_id` no login só se consentido (e a coluna `member_id` pode ser preenchida retroativamente na sessão).

#### 2.4 Suporte a QA / CI (config, não runtime quente)

**`test_coverage_gates`** (opcional — registra o estado de gates por domínio/PR; pode viver só no CI, não no DB)
| Coluna | Tipo | Notas |
|---|---|---|
| `domain` | `text` | `payments-billing`, etc. |
| `gate` | `text` | `unit`/`rls`/`contract`/`e2e` |
| `last_status` | `text` | `pass`/`fail` |
| `coverage_pct` | `numeric` null | |
| `updated_at` | `timestamptz` | |

> A maior parte do estado de QA vive no **provedor de CI** (GitHub Actions), não no DB. Esta tabela é opcional, só se quisermos um painel "saúde da suíte" no superadmin.

#### 2.5 Índices, constraints e particionamento (transversal)

- **Particionamento por tempo** (`product_events`, `health_probe_results`, `webhook_delivery_attempts`, `metric_rollups`, `edge_request_log` se existir): partição por dia/semana + job de **drop de partição antiga** (retenção barata, sem `DELETE` em massa). Usar `pg_partman` ou partições nativas declarativas.
- **RLS:** `product_events`, `webhook_deliveries`, `webhook_delivery_attempts` (via join), `alert_rules`/`alert_events` quando `org_id` não-nulo → policy padrão `org_id = auth.org_id()`. Tabelas de plataforma (`slo_definitions`, `status_*`, `health_probe_results`, `metric_rollups` global) → policy de superadmin/service (leitura para superadmin, escrita só service role).
- **Status page pública:** os endpoints públicos de status leem via **Edge Function/view materializada**, nunca acesso anônimo direto às tabelas (mesmo padrão da `verify` em §05 2.3) — expõe só estado de componente, sem detalhe interno.
- **CHECK:** `alert_rules.runbook_url` not null quando `severity in (P1,P2)`; `slo_definitions.target` coerente com `comparator`.

---

### 3. API & Edge Functions

#### 3.1 Endpoints `/v1` (REST — superadmin/admin/headless; §21)

```
# Health (liveness existe na fundação; deep é deste domínio)
GET    /v1/health                          # liveness (fundação §05) — público, barato
GET    /v1/health/deep                      # readiness + dependências externas (superadmin)
GET    /v1/status                           # estado dos componentes (público, p/ status page)

# Observabilidade — webhooks de saída (painel/DLQ)
GET    /v1/webhooks/{id}/deliveries          # entregas de um endpoint (status, tentativas)
GET    /v1/webhooks/deliveries/{deliveryId}  # detalhe + tentativas (payload redatado)
POST   /v1/webhooks/deliveries/{deliveryId}/replay   # replay manual de DLQ (preserva trace_id)
GET    /v1/webhooks/deliveries?status=dead_letter    # fila DLQ da org

# Observabilidade — syncs/integração (espelha §19; aqui é o olhar de QA/obs)
GET    /v1/integrations/{id}/sync-state      # (definido em §19) — referenciado p/ painel
GET    /v1/integrations/{id}/reconcile-runs  # (definido em §19)

# Métricas técnicas por org (dono vê a saúde da SUA org)
GET    /v1/org/health                        # resumo: erro%, latência p95, DLQ, connections degraded (da org)

# Analytics de produto (ingest + leitura agregada)
POST   /v1/events                            # ingest de evento de produto (valida consentimento)
POST   /v1/events/batch                      # ingest em lote (front faz buffer)
GET    /v1/analytics/funnel                  # funil consentido (alimenta admin-app; cálculo pode ser de billing/crm)

# Superadmin — observabilidade de plataforma (escopo cross-org)
GET    /v1/admin/slo                          # SLOs e error budget atual
GET    /v1/admin/metrics                       # séries de metric_rollups (filtros: env, route, org_id)
GET    /v1/admin/alerts                         # alertas firing/histórico
POST   /v1/admin/alerts/{id}/ack                # acknowledge
POST   /v1/admin/status/incidents               # abrir/atualizar incidente público
PATCH  /v1/admin/status/components/{key}        # mudar estado de componente (manual/manutenção)
```

> A maioria dos endpoints de **superadmin** não é parte do contrato público versionado para parceiros (não vai no SDK/MCP externos) — vive sob um namespace `/v1/admin/*` autenticado por role de superadmin (§22 superadmin). `POST /v1/events` **é** público (front emite), com rate limit por origem.

#### 3.2 Edge Functions / Jobs internos

| Nome | Tipo | Descrição |
|---|---|---|
| `health-deep` | função | Checa DB write, pgmq, storage e providers externos; alimenta `/v1/health/deep` e `status_components`. |
| `health-canary` | pg_cron (fundação §05) | **Estendido aqui:** roda jornadas sintéticas no tenant `__canary__` (emitir passe test, verify, checkout sandbox); grava `health_probe_results`; transiciona `status_components`. |
| `metrics-rollup` | pg_cron (1m/5m/1h) | Agrega logs/eventos → `metric_rollups` (p50/p95/p99, erro%, throughput por env/org/route/mode). |
| `slo-evaluator` | pg_cron (a cada Nmin) | Compara `metric_rollups`/probes com `slo_definitions`; computa error budget; cria/resolve `alert_events`. |
| `alert-dispatcher` | consumer/cron | Lê `alert_events firing`, aplica dedupe/agrupamento/supressão, roteia por `alert_rules.route` (page/slack/email/banner). |
| `webhook-dispatcher` | consumer pgmq | **(Dono lógico = §22/webhooks;** observabilidade aqui) Entrega webhook-out, backoff/jitter, grava `webhook_deliveries`+`attempts`, DLQ, auto-disable de endpoint morto. |
| `dlq-monitor` | pg_cron (fundação §05) | **Estendido:** mede profundidade de DLQ (pgmq sync + webhook), gera métrica e alerta de tendência. |
| `log-exporter` | função/stream | Encaminha logs estruturados das Edge Functions para o sink externo (OTLP/HTTP), com buffer e retry. |
| `events-ingest` | função | Valida consentimento (cruza `consent_records`), sanitiza props, grava `product_events`; rejeita sem base legal. |
| `analytics-retention` | pg_cron | Expurgo de `product_events`/probes/attempts por partição + por revogação de consentimento. |
| `cert-expiry-watch` | pg_cron diário | Checa validade do certificado Apple PassKit, SA Google Wallet, segredos de webhook → alerta P3 (30d) / P2 (7d). |
| `status-publisher` | função | Renderiza estado público para `status.stanbase.com` (ou sincroniza com provedor externo de status). |

> **Decisão (edge case de loop):** o `log-exporter` e os jobs de alerta **não podem** depender da mesma infra que monitoram de forma circular. O `alert-dispatcher` tem um caminho de "dead man's switch" (heartbeat externo): se o próprio pipeline de alerta parar, um monitor externo (uptime/cron de terceiro) percebe o silêncio e avisa. Sem isso, "tudo verde" pode significar "o alertador morreu".

---

### 4. Telas / Front

#### 4.1 Superadmin (`apps/stanbase-admin` — §10 nível interno)

- **Dashboard de saúde da plataforma:** RED por serviço (API, workers, webhook-dispatcher), error budget de cada SLO (gauge + tendência), profundidade de filas (`pgmq` sync/webhook), latência p50/p95/p99, mapa de saúde por **org** (heatmap — quais tenants estão sofrendo).
- **Central de alertas:** lista de `alert_events` (firing/ack/resolved), ack/silenciar, link para runbook e para o trace correlacionado.
- **Editor de status page + incidentes:** mudar estado de componente, abrir/atualizar incidente público (`investigating→identified→monitoring→resolved`), histórico.
- **Explorador de logs/traces:** busca por `trace_id`/`org_id`/`request_id`/`route`/`status` (embed do sink externo ou view sobre `edge_request_log` no MVP); "ver tudo deste trace" reconstrói a cadeia (§1.3).
- **Painel de QA/CI:** estado dos gates por domínio (unit/RLS/contract/e2e), cobertura, últimos deploys e seus smoke-tests.
- **Gestão de SLOs e alert rules:** CRUD de `slo_definitions`/`alert_rules` com validação de runbook obrigatório.

#### 4.2 Admin da org (`apps/admin` — §10.1, módulos existentes)

- **Painel de saúde de integrações/webhooks** (já previsto em §19.4.1 e §22): jobs de sync pendentes/falhos/DLQ com **replay**; entregas de webhook com status/tentativas/DLQ + **replay**; banner "Integração instável" (`degraded`); aviso de endpoint de webhook auto-desabilitado.
- **Mini "status da minha org":** widget discreto no dashboard mostrando se há incidente afetando esta org (ex.: Discord degradado) — sem expor a status page global. Dogfooding de `/v1/org/health`.
- **Configurações → Privacidade/Analytics:** o dono escolhe se ativa analytics de produto na sua org e vê o estado de consentimento agregado (quantos membros consentiram) — liga com §26.
- **Developers → Webhooks:** ver log de entregas, testar endpoint ("enviar evento de teste"), inspecionar payload de uma entrega (redatado).

#### 4.3 Membro (`apps/member` — §24)

- **Banner/preferências de consentimento:** distingue essencial × analytics × marketing; escolha registrada; revogável a qualquer momento (LGPD). É a **porta de entrada** da coleta de `product_events`.
- **SDK de eventos no front:** wrapper leve que **só dispara** se há consentimento; buffer + `POST /v1/events/batch`; nunca coleta PII não consentida; respeita `Do Not Track`/opt-out.

> Nenhuma tela de observabilidade técnica é exposta ao **membro** (só consentimento). Telas técnicas são superadmin; o que o **dono** vê é saúde de suas integrações/webhooks e analytics da sua org.

---

### 5. Integrações externas

| Serviço | Papel | Como integra |
|---|---|---|
| **Sink de logs/traces** (Axiom / Grafana Loki+Tempo / Honeycomb / Datadog) | Armazenar e consultar logs e traces de alto volume fora do Postgres | `log-exporter` envia via OTLP/HTTP; **adapter** desacopla o vendor (trocável). MVP pode começar com **Logflare** (nativo do Supabase) + buffer Postgres curto. |
| **Métricas/dashboards** (Grafana / Datadog) | Visualizar `metric_rollups` e séries | Datasource lê `metric_rollups` (Postgres) ou recebe métricas exportadas; painéis versionados como código. |
| **Status page** (Instatus / Statuspage / Better Stack) | Página pública de status fora da infra principal | `status-publisher` sincroniza `status_components`/incidentes via API; ou página estática em CDN. **Fora da Supabase principal** (§1.5). |
| **Uptime / dead-man's-switch** (Better Stack / UptimeRobot / Cron de terceiro) | Probe externo independente + alertar se o **próprio** alertador silenciar | Monitora `/v1/health` e o heartbeat do `alert-dispatcher` de fora. |
| **Paging/on-call** (PagerDuty / Opsgenie) | Acordar humano em P1 | `alert-dispatcher` roteia P1 via API; escalonamento/on-call schedule no provedor. |
| **Chat de alerta** (Slack / Discord interno) | P2/P3 em canal | `alert-dispatcher` posta mensagem formatada (sintoma+impacto+runbook+trace link). |
| **Analytics de produto** (PostHog self-host / próprio) | Eventos de produto com consentimento | `events-ingest` é a fonte; PostHog (self-host, dado no nosso controle p/ LGPD) ou pipeline próprio sobre `product_events`. **Não** usar analytics que vaze PII para terceiro sem DPA. |
| **CI/CD** (GitHub Actions) | Rodar a pirâmide de testes + gates | Pipelines: unit+RLS+contract no PR; e2e no merge; carga agendada; geração de OpenAPI→SDK/MCP (§28). |
| **Asaas (sandbox)** | Ambiente de teste de pagamento p/ e2e/canary | Checkout em test mode contra sandbox Asaas; nunca cobra real. |

> **Princípio de portabilidade:** toda integração de observabilidade passa por **adapter** (igual ao PSP-agnóstico de §13). Não acoplar a um vendor caro no v0 — começar com o que o Supabase oferece (Logflare/Postgres) + adapters prontos para migrar quando o volume/custo justificar.

---

### 6. Épicos & tarefas

#### Épico A — Contrato e pipeline de logs
- A1 (M) Fixar **schema de log** (§1.2) + estender o `logger.ts` da fundação: `trace_id`/`span_id`/`parent_span_id`, `org_id`, `mode`, `db_ms`/`external_ms`.
- A2 (M) **Propagação de `trace_id`** fim a fim: gera na borda (`v1-router`), header em chamadas internas, payload em `pgmq` (worker continua o trace).
- A3 (M) **Redaction/sanitização**: denylist de chaves + mascarador de PII (e-mail/telefone) aplicado antes de serializar; testes provando que segredo/PII nunca sai.
- A4 (M) `log-exporter` (OTLP/HTTP) com buffer e retry + **adapter** de sink (Logflare/Axiom/Loki) trocável.
- A5 (S) (opcional MVP) `edge_request_log` particionada por dia + retenção curta (buffer no Postgres p/ painel sem sink externo).

#### Épico B — Tracing e instrumentação de spans
- B1 (M) API de span leve (`startSpan/endSpan`) sobre o logger; spans para auth/ratelimit/idempotency/handler/db/external.
- B2 (M) Instrumentar chamadas externas (Asaas, Wallet, Discord, LLM) com `external_ms` + `psp_ref/external_ref` p/ costura por chave de negócio (§1.3).
- B3 (S) Amostragem configurável (100% erro/financeiro; % de GET; always-sample por `org_id` via flag).
- B4 (S) Adapter OpenTelemetry plugável (exporter OTLP) sem trocar a instrumentação.

#### Épico C — Métricas, SLO e error budget
- C1 (M) Migration `slo_definitions` + `metric_rollups` (particionada) + seed dos SLOs do §1.4.
- C2 (L) `metrics-rollup` cron: agrega logs/eventos → p50/p95/p99, erro%, throughput por env/org/route/mode.
- C3 (M) `slo-evaluator`: error budget burn-rate, cruza limiares, abre/resolve `alert_events`.
- C4 (M) Métricas de fila (`pgmq` depth sync/webhook) e de saturação (USE) como séries de primeira classe.
- C5 (S) Quebra por `org_id` em todas as métricas (multi-tenant) + filtro de exclusão do tenant canário e `mode=test`.

#### Épico D — Health checks & status page
- D1 (M) `health-deep` (`/v1/health/deep`): DB write, pgmq, storage, providers externos (reusa `connection-health-cron` §19).
- D2 (M) Estender `health-canary`: jornadas sintéticas no tenant `__canary__` (passe test, verify, checkout sandbox) → `health_probe_results`.
- D3 (M) Migration `status_components`/`status_incidents`/`status_incident_updates` + máquina de estados + transição automática por SLI.
- D4 (M) `status-publisher` + página pública **fora da Supabase** (provedor de status ou estática CDN) + `cert-expiry-watch`.
- D5 (S) Banner de incidente por org no admin (separa plataforma × tenant).

#### Épico E — Alertas acionáveis
- E1 (M) Migration `alert_rules` (runbook obrigatório p/ P1/P2) + `alert_events`.
- E2 (L) `alert-dispatcher`: dedupe, agrupamento, supressão (manutenção), auto-resolução, roteamento por severidade (page/slack/email/banner).
- E3 (M) Integração PagerDuty/Opsgenie (P1) + Slack (P2/P3) + e-mail; **dead-man's-switch** externo do próprio alertador.
- E4 (S) Roteamento de alerta de tenant → banner/notificação no admin (não acorda on-call); flag enterprise p/ alerta dedicado.
- E5 (S) Runbooks iniciais (API down, checkout down, webhook Asaas parado, certificado expirando, DLQ crescendo).

#### Épico F — Webhooks-out & syncs (observabilidade)
- F1 (M) Migration `webhook_delivery_attempts` (particionada) + tocar `webhook_deliveries` (trace_id, last_status_code, índices de scheduler).
- F2 (M) Máquina de estados da entrega (§1.6) + backoff/jitter + **auto-disable de endpoint morto** + quarentena/circuit-breaker por endpoint.
- F3 (M) Painel de DLQ (webhook + sync) + **replay** preservando `trace_id`; "enviar evento de teste".
- F4 (S) Métricas e alertas de webhook (taxa de entrega, DLQ crescendo) + observabilidade de reconcile drift (consome §19 `reconcile_runs`).
- F5 (S) Lint: toda tabela com `org_id` sem RLS força → falha CI (rede de segurança transversal).

#### Épico G — Analytics de produto (com consentimento)
- G1 (M) Migration `product_events` (RLS por org, particionada) + `consent_basis` por evento.
- G2 (M) `events-ingest` (`POST /v1/events[/batch]`): valida consentimento (cruza `consent_records` §26), sanitiza props, rejeita sem base legal.
- G3 (M) SDK de eventos no front (admin+membro): só dispara com consentimento; buffer; respeita opt-out/DNT.
- G4 (M) Banner/preferências de consentimento (essencial × analytics × marketing) + revogação → `analytics-retention` expurga.
- G5 (S) Isolamento: dono vê analytics da org; Stanbase vê agregado anonimizado cross-org (legítimo interesse).
- G6 (S) Adapter de analytics (PostHog self-host ou pipeline próprio) sem PII a terceiro sem DPA.

#### Épico H — Estratégia de testes (CI)
- H1 (L) **Suíte RLS/policy** (pgTAP + harness 2-sessions): por tabela, provar isolamento A×B, FORCE RLS, service-role-bypass→handler filtra, rota pública mínima. Gera **um teste por tabela** + lint que exige cobertura.
- H2 (L) **Contract tests** contra `openapi.yaml` (Schemathesis/Dredd): resposta casa com schema, exemplos válidos, property-based fuzzing; detecta drift schema↔código no PR.
- H3 (M) Harness de **unit** padronizado (Vitest front/pkgs, Deno test Edge) + cobertura mínima por pacote; testes de cálculo financeiro/Member ID/máquinas de estado/redaction.
- H4 (L) **E2E Playwright** admin (org→tier→membro→campanha→check-in) e membro (login→checkout sandbox→wallet→gated→verify) contra staging com seed + smoke no canário pós-deploy.
- H5 (M) **Testes de carga k6**: checkout concorrente (last-seat race), verify em massa (porta de evento), fila de sync sob upgrade em massa; mede contra SLOs.
- H6 (M) **Testes de idempotência/webhook** cross-domínio: mesma `Idempotency-Key` não duplica cobrança; webhook-in duplicado dedupado; replay de DLQ não duplica efeito.
- H7 (M) **Gates de CI**: unit+RLS+contract bloqueiam merge; e2e bloqueia promote; carga informa; geração OpenAPI→SDK/MCP no pipeline (§28).

#### Épico I — Ambientes & seed
- I1 (M) Pacote `supabase/seed` idempotente: N orgs por vertical, tiers/perks, membros em todos lifecycle stages, transações live/test, eventos, connections em todos estados, webhooks com DLQ.
- I2 (S) Tenant de canário `__canary__` em prod + filtro de exclusão em **toda** query agregada/analytics.
- I3 (S) Política de dados não-prod: seed sintético (faker); se dump de prod, anonimizar/mascarar (§26); nunca PII real fora de prod.
- I4 (S) Segregação `mode=test` × `live` em métricas, error budget e receita.

#### Épico J — Telas
- J1 (M) Superadmin: dashboard de saúde da plataforma (RED/USE, error budget, heatmap por org).
- J2 (M) Superadmin: central de alertas (ack/silenciar/runbook/trace) + editor de status/incidentes.
- J3 (M) Superadmin: explorador de logs/traces ("ver tudo deste trace") + painel de QA/CI.
- J4 (S) Admin: painel de DLQ webhook/sync com replay + "status da minha org" + configs de privacidade/analytics.
- J5 (S) Membro: banner/preferências de consentimento + SDK de eventos.

---

### 7. Dependências

| Depende de | Por quê |
|---|---|
| **fundacao** | `logger.ts` estruturado + redaction, `_shared` (envelope, request_id, rate limit), jobs base (`dlq-monitor`, `audit-retention`, `health-canary`), `/v1/health`, pgmq/pg_cron, RLS template, 3 ambientes, geração OpenAPI no CI. Este domínio **cabeia** esses primitivos; sem eles, não há o que observar. |
| **public-api** | `openapi.yaml` é a fonte da verdade dos **contract tests**; `request_id`/`trace_id`, `mode` (live/test), idempotência e códigos de erro canônicos são as dimensões da telemetria. Os testes de contrato **dependem** do spec estável. |
| **webhooks** | Dono lógico da **entrega** de webhooks-out; este domínio é dono da **observabilidade** (DLQ, métricas, alertas, replay). Domínios irmãos (entrega × medição), igual ao par §19/§27. |
| **integrations-framework** | Fonte de `connection_sync_state`, `reconcile_runs`, estados de connection (`degraded`/`revoked`) e `connection-health-cron` que alimentam health-deep e alertas. §19 J1/J3 explicitamente reportam aqui. |
| **payments-billing** | Cobranças/webhook Asaas: webhook parado = entitlements não atualizam = **incidente silencioso**; checkout é SLI crítico; sandbox Asaas para e2e/carga; idempotência financeira é o teste de maior valor. |
| **passport** | Expiração de certificado Apple/SA Google = falha de emissão; frescor de push de passe é SLI; canário emite passe de teste. |
| **verification-checkin** | Verify pública é SLI de altíssima criticidade (porteiro no evento); carga de verify em massa; canário faz verify. |
| **security-lgpd** | `consent_records` (base legal lida antes de coletar analytics), retenção/expurgo por revogação, anonimização de dados não-prod, redaction de PII em log, RLS testado. Dependência dura para o pilar de analytics. |
| **auth-rbac** | Role de superadmin para endpoints `/v1/admin/*`; `org_id`/`mode`/`actor` nos claims que viram dimensões de telemetria; permissão de admin para ver DLQ/replay/analytics da org. |
| **crm / ai-layer** | Donos dos KPIs de negócio (churn, segmentos) que **consomem** `product_events`; a fronteira é "infra de eventos aqui, cálculo de KPI lá". |
| **admin-app / superadmin / design-system** | Renderizam os painéis (saúde, alertas, status, DLQ, QA) e o widget de saúde da org; o membro renderiza consentimento. |

> Dependência mais crítica: **fundacao** (primitivos) e **public-api** (spec para contract tests). Sem `openapi.yaml` estável, o gate de contrato não existe; sem o `logger`/`trace_id`, não há correlação. As mais **acopladas em runtime** são `webhooks`, `integrations-framework` e `payments-billing` (as três fontes dos incidentes mais comuns e caros).

---

### 8. Riscos & decisões técnicas

1. **Custo e volume de telemetria.** Logar tudo no Postgres operacional **mata o banco** (storage, I/O, autovacuum). Decisão: telemetria de alto volume vai para **sink externo** via `log-exporter`; o Postgres guarda só o que precisa de RLS/replay/auditoria (deliveries, eventos consentidos, config), tudo **particionado com retenção agressiva** (drop de partição, nunca DELETE em massa). Amostragem de traces de GET. **Open question:** sink definitivo (Logflare/Axiom/Loki/Datadog) e budget mensal.

2. **Observabilidade que cai junto com o sistema.** Se o alertador/status page roda na mesma Supabase que caiu, "tudo verde" mente. Mitigação: status page e probe **fora** da infra principal + **dead-man's-switch** externo que percebe o silêncio do alertador. Sem isso, o pior incidente (queda total) é o que menos alerta.

3. **Multi-tenancy na observabilidade.** O risco simétrico: (a) alertar 1000 donos por um problema de 1 (fadiga, pânico); (b) um problema que afeta só uma org sumir no agregado global. Mitigação: toda métrica quebra por `org_id`; alerta de plataforma (global) ≠ alerta de tenant (banner no admin do dono). Definir o limiar "quando um problema de tenant vira incidente de plataforma" (ex.: > X% das orgs do mesmo connector).

4. **Vazamento de PII/segredo em log (incidente de segurança).** Um `console.log(member)` ou `error.body` com cartão/token vaza dados. Mitigação: denylist + sanitizador no logger **central** (ninguém loga direto), lint que pega `console.log` cru em Edge, e testes provando redaction. É a violação mais provável em desenvolvimento rápido.

5. **Costura de trace pelo PSP.** O webhook do Asaas é um novo trace, sem o `trace_id` original — perde-se a cadeia "cobrança → webhook → entitlement". Mitigação: correlação por **chave de negócio** (`psp_ref`/`external_ref`) registrada nos dois lados. Documentar para o on-call; sem isso, investigar pagamento que não atualizou membership vira garimpo.

6. **Webhook Asaas parado = incidente silencioso.** Se o Asaas para de entregar webhooks (ou nós paramos de processá-los), pagamentos sucedem mas memberships não atualizam — **ninguém vê** até o membro reclamar. Mitigação: alerta de **ausência** de eventos esperados (heartbeat: "esperávamos N webhooks/h, recebemos 0") + reconcile periódico com o PSP (§13.5 reconciliação). Alarme por silêncio é mais difícil que por erro, e mais importante aqui.

7. **Expiração de certificado de passe.** Certificado Apple PassKit / SA Google Wallet expira → emissão de passe quebra silenciosamente (o canário pega, mas só se existir). Mitigação: `cert-expiry-watch` (alerta 30d/7d) + canário que emite passe de teste. Incidente clássico esquecido.

8. **Flakiness de e2e mina o gate.** E2E Playwright instável → time aprende a ignorar o vermelho → o gate vira teatro. Mitigação: e2e determinístico (seed fixo, mocks de OAuth/Wallet/PSP sandbox, retry controlado, quarentena de teste flaky), e2e **mínimo e de alto valor** (jornadas críticas), unit/contract carregam o peso. Não transformar e2e em suíte gigante frágil.

9. **Drift schema↔OpenAPI.** Sem contract test, o spec mente e a promessa de paridade headless (§ public-api) quebra. Mitigação: contract test no PR (resposta real × schema), exemplos validados, e o `openapi.yaml` como artefato obrigatório do PR de qualquer domínio que toca capacidade pública.

10. **Consentimento e analytics (LGPD).** Coletar evento de comportamento sem base legal é violação. Mitigação: `events-ingest` **sempre** cruza `consent_records` antes de gravar; `consent_basis` no próprio evento (auditável); revogação para a coleta e expurga; analytics sem PII a terceiro sem DPA. O coletor falha-fechado: na dúvida, não coleta.

11. **Dados de seed e o tenant canário poluindo métricas.** Esquecer de excluir `__canary__`/`mode=test` infla "membros ativos"/receita. Mitigação: filtro de exclusão é **parte do contrato** de toda query agregada (helper compartilhado), testado.

12. **Cardinalidade de métricas.** Quebrar por `org_id` × `route` × `status` × `mode` explode a cardinalidade (custo no sink de métricas). Mitigação: `metric_rollups` pré-agregado com dimensões controladas; `org_id` em métricas detalhadas só sob demanda/amostrado; nunca usar `member_id` ou `request_id` como dimensão de métrica (isso é log/trace, não métrica).

13. **SLO sem dados históricos.** Definir 99,9% no v0 é chute. Mitigação: os números do §1.4 são **propostos**; começar **medindo sem alertar** (modo observação) por semanas, calibrar limiares com dados reais, e só então ligar paging. Alerta calibrado errado = fadiga ou cegueira.

14. **Quem é o on-call?** Stanbase é time pequeno no início; paging 24/7 pode não existir. Decisão de produto/operação: definir cobertura de on-call realista (talvez só horário comercial + best-effort fora) e ajustar severidades a essa realidade — não criar P1 que ninguém atende.

---

### 9. Escopo MVP vs. depois

#### MVP (transversal — acompanha §29 Fases 0–1, endurece nas Fases 2–4)
- **Logs estruturados** com schema completo (§1.2), `trace_id` propagado, redaction de PII/segredo, exportação para sink (começar com **Logflare/Supabase** + buffer Postgres curto; adapter pronto p/ trocar).
- **Tracing por log** (spans em log, sem APM pago): correlação fim a fim incluindo workers e webhook-out; costura por chave de negócio no PSP.
- **Health checks** (`/v1/health` da fundação + `/v1/health/deep` + canário no tenant `__canary__`) e **status page pública fora da Supabase** com os componentes core (API, Checkout, Passport, Verify, Webhooks, Integrações).
- **Métricas e SLO mínimos**: RED da API, latência checkout/verify, profundidade de fila, DLQ — em **modo observação** primeiro, alertas calibrados depois.
- **Alertas P1/P2 essenciais** roteados (page + slack), com **dead-man's-switch** externo; runbooks dos incidentes críticos (API/checkout/webhook-Asaas/cert/DLQ).
- **Observabilidade de webhooks-out e syncs**: `webhook_deliveries`+`attempts`, painel de DLQ com **replay**, auto-disable de endpoint morto; reuso de `connection_sync_state`/`reconcile_runs` de §19.
- **Estratégia de testes — núcleo bloqueante**: **unit + RLS/policy + contract** no CI bloqueando merge (RLS é inegociável p/ a promessa multi-tenant); **e2e smoke** das jornadas críticas (checkout sandbox, verify, emitir passe) bloqueando promote; geração OpenAPI→SDK/MCP no pipeline.
- **Ambientes & seed**: dev/staging/prod separados, seed idempotente cobrindo as verticais, tenant canário com exclusão de métricas, segregação live/test.
- **Analytics de produto — base com consentimento**: `events-ingest` falha-fechado contra `consent_records`, `product_events` com RLS, banner de consentimento, SDK de eventos no front. (Os **KPIs** que consomem isso amadurecem com `crm`/`ai-layer`.)
- **`cert-expiry-watch`** desde o MVP (passport é MVP — §29 Fase 1 — e certificado expira em silêncio).

#### Depois (Fases 3+ e maturidade operacional)
- **APM/tracing dedicado** (OpenTelemetry → Tempo/Honeycomb/Datadog) com waterfall visual e amostragem adaptativa; explorador de traces rico.
- **SLOs por org e alerta dedicado** para tenants enterprise; relatórios de confiabilidade por cliente.
- **Carga (k6) automatizada e contínua** com cenários de pico (drop/evento) e regressão de performance no CI; orçamento de performance por endpoint.
- **Status page por componente avançada** (uptime histórico, subscribe a incidentes, RSS) e **incident management** completo (postmortems, MTTR/MTTD).
- **Analytics de produto avançado** (funis/coortes/retention configuráveis pelo dono, A/B, feature flags com telemetria), PostHog self-host completo.
- **Alertas inteligentes** (anomaly detection, burn-rate multi-janela, agrupamento por causa raiz), on-call schedule/escalonamento maduro.
- **Chaos/resilience testing** (injeção de falha de provider) e **synthetic monitoring** geográfico distribuído.
- **Painel de QA/CI rico** (flaky tracking, tendência de cobertura, tempo de suíte) e mutation testing nas áreas financeiras.
- **Data warehouse/export** de eventos consentidos para BI do dono (com DPA), e agregados cross-org anonimizados para o produto Stanbase.
