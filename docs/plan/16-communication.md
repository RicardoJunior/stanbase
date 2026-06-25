## 16. Comunicação, Campanhas & Presentes

> Fonte de verdade: STANBASE.md §17 (comunicação, campanhas, presentes), §11.2/§11.13 (timeline + consentimentos no CRM), §16 (canais Discord/Telegram/WhatsApp), §19 (copy por IA na voz da marca), §21.2 (`POST /v1/messages`, `POST /v1/gifts`), §22 (webhooks), §25.5 (`messages`/`campaigns`/`gifts`), §26 (LGPD/consentimento), §30 (WhatsApp = API Oficial; i18n pt-BR/en-US/es). Este plano detalha o domínio para execução.

Este domínio é o **motor de saída de mensagens** da Stanbase: 1-para-1 (mensagem direta a um membro) e 1-para-muitos (campanha segmentada) através de **e-mail, push e WhatsApp**, com agendamento, voz-da-marca por IA, métricas de funil (entrega → abertura → clique → conversão) escritas de volta na **timeline do CRM**, e respeito **rígido** a consentimento/preferência por canal (LGPD). Inclui também **Presentes** (gifts) físicos e digitais a membros específicos — orquestração e fulfillment, com integração ao perk type `drop` (tiers-perks §09).

**Decisões de fronteira (o que este domínio possui vs. consome):**
- **Possui:** `messages`/`campaigns`, `message_recipients` (estado por destinatário), templates (`message_templates`), provedor abstrato de canal (channel adapter), throttling/scheduling/timezone, dedup de destinatário, métricas de entrega, `gifts` + fulfillment, supressão (suppression list por bounce/complaint/hard-fail), WhatsApp template registry (aprovação Meta).
- **Consome (não duplica):** `segments`/`lists` e a **DSL de regras** (CRM §08), `consents`/`consent_history` (CRM §08 §1.13 — o gate de canal já existe lá), `interactions`/timeline (CRM — escrevemos eventos `message.*`/`gift.*`), `ai/copy` (ai-layer §19), `member_profiles` (e-mail/telefone/locale/timezone), `transactions` (atribuição de conversão), `webhooks` de saída (§22), Asaas (gift pago vira transação).
- **Não confundir com Comunidade & Canais (§16 doc / community-channels):** aquele domínio gerencia **pertencimento** a Discord/Telegram/grupos WhatsApp por tier (cargos/grupos). Este aqui **envia mensagens** (broadcast/DM). WhatsApp aparece nos dois: lá como grupo por tier, aqui como mensagem template/sessão 1-a-1. Mantemos separados; ambos usam a mesma `connection` WhatsApp.

---

### 1. Como funciona

#### 1.1 Conceitos e modelo mental

- **Message (envio):** unidade de **um disparo** para uma audiência. Pode ser:
  - **`direct`** — 1 destinatário (DM a um membro). Ex.: "obrigado por 1 ano de casa".
  - **`campaign`** — N destinatários a partir de **segmento(s)/lista(s)** ou filtro ad-hoc. Ex.: "drop exclusivo para Camarote".
  - **`transactional`** — disparada por evento de sistema (recibo, falha de cobrança, ingresso emitido). **Não passa por opt-in de marketing** (base legal = execução de contrato), mas ainda respeita supressão de hard-fail e preferências técnicas. Maioria das transacionais nasce em outros domínios (payments, events, passport) e só usa este motor como **transport**.
- **Template (`message_templates`):** corpo reutilizável com variáveis (`{{member.name}}`, `{{tier.name}}`, `{{org.name}}`, `{{gift.tracking_url}}`...), por canal e por **locale** (pt-BR/en-US/es). Para WhatsApp, o template tem um vínculo com o **template aprovado pela Meta** (`whatsapp_templates`).
- **Channel adapter:** abstração sobre o provedor real de cada canal (e-mail, push, WhatsApp). A aplicação fala "envie esta mensagem renderizada por este canal"; o adapter resolve provedor, faz a chamada, normaliza o retorno (provider_message_id, erro, status) e mapeia eventos de webhook do provedor para nosso vocabulário (`delivered`, `bounced`, `complained`, `opened`, `clicked`...). **Provedor de e-mail/push fica a decidir** (§8) — o adapter isola essa decisão.
- **Recipient (`message_recipients`):** uma linha por (mensagem × membro × canal) com **máquina de estados própria**. É onde vivem entrega/abertura/clique/conversão e os erros. A campanha é a soma dos estados de seus recipients.
- **Gift (`gifts`):** um presente concedido a um membro específico (físico ou digital). Tem fulfillment próprio e pode (opcionalmente) custar dinheiro (gift pago → transação Asaas) ou ser cortesia.

#### 1.2 Máquina de estados — Campaign / Message

```
draft ──┬─ schedule ──► scheduled ──(chega a hora / janela TZ)──► queued
        │                   │                                       │
        └─ send_now ────────┴───────────────────────────────────► queued
                            ▲ cancel                                │ build audience snapshot
                            │                                       ▼
                         (cancel só em draft/scheduled)          sending ──► sent ──► completed
                                                                    │                    ▲
                                                                    │ pause              │ (todos recipients terminais)
                                                                    ▼                    │
                                                                  paused ──resume────────┘
                                                                    │
                                                                    └─ cancel (aborta restantes; já enviados ficam)
```

- **`draft`** — editável (audiência, corpo, canal, agendamento). Não consome cota.
- **`scheduled`** — tem `scheduled_at` (+ regra de timezone, §1.7). Cancelável/editável até "T menos buffer".
- **`queued`** — chegou a hora; o job **congela o snapshot de audiência** (CRM §08 §1.5 — segmento dinâmico vira snapshot reproduzível **no instante do envio**) e materializa `message_recipients`. A partir daqui a audiência **não muda mais** (idempotência + reprodutibilidade).
- **`sending`** — recipients sendo despachados sob throttling (§1.6).
- **`paused`** — admin pausou; nenhum novo despacho; retomável. Recipients já enviados permanecem.
- **`sent`** — todos despachados ao provedor (não significa entregue).
- **`completed`** — todos os recipients atingiram estado terminal (delivered/bounced/failed/suppressed) **ou** expirou a janela de coleta de eventos (ex.: 72h para abertura/clique). Métricas finais consolidadas.
- **`cancelled`** — abortado; recipients ainda não despachados ficam `cancelled`.

**Regra dura:** a transição `queued → sending` é **idempotente** e protegida por lock (`SELECT ... FOR UPDATE SKIP LOCKED` na fila pgmq + flag em `campaigns`), para que dois workers nunca re-disparem a mesma campanha (evita double-send — pior bug deste domínio).

#### 1.3 Máquina de estados — Recipient (por destinatário × canal)

```
                       audience build
                            │
                            ▼
   pending ──suppressed?──► suppressed  (consentimento ausente / na suppression list)  [terminal]
      │ (passou no gate)
      ▼
   throttled/queued ──despacha──► sent_to_provider
                                      │
                ┌──provider aceitou──┤
                ▼                     ▼ provider rejeitou (4xx/5xx)
            accepted              failed_soft ──retry(backoff,N)──► (volta a sent_to_provider)
                │                     │ esgotou retries
                │                     ▼
                │                  failed_hard  [terminal]
                ▼
   (webhook do provedor)
   delivered ──► opened ──► clicked ──► converted   (cada um é incremental, opcional)
      │
      ├─ bounced (soft) ──► retry/aging
      ├─ bounced (hard) ──► failed_hard + add à suppression list  [terminal]
      └─ complained (spam) ──► failed_hard + suppression + revoga consent do canal  [terminal]
```

- **`pending → suppressed`**: avaliado **no momento do build da audiência E novamente no instante do despacho** (consentimento pode ter mudado entre agendar e enviar — sempre revalida no despacho). Razões: sem consentimento no canal, na suppression list (hard bounce/complaint anteriores), contato inválido (sem e-mail/telefone), idioma sem template.
- **`sent_to_provider → accepted`**: provedor retornou 2xx + `provider_message_id`. Guardamos o ID para correlacionar webhooks.
- **`failed_soft`**: erro transitório do provedor (rate limit, 5xx, timeout) → **retry com backoff exponencial + jitter**, teto de N tentativas; depois `failed_hard`.
- **`delivered/opened/clicked/converted`**: chegam **assíncronos via webhook** do provedor (push e WhatsApp têm `delivered`/`read`; e-mail tem `delivered`/`open` via pixel/`click` via link wrap). São **incrementais e idempotentes** (um `opened` repetido não conta duas aberturas únicas).
- **`bounced`/`complained`**: ver §1.8 (bounce/hard-fail/opt-out) — efeitos colaterais sobre suppression e consent.

> **Diferença entre estados do envio e métricas:** `sent` (despachamos) ≠ `delivered` (provedor confirmou entrega) ≠ `opened` (membro abriu). A UI **nunca** deve dizer "entregue" quando só houve `accepted`. Cada passo é uma coluna/timestamp distinto no recipient.

#### 1.4 Fluxo passo a passo — Campanha segmentada

1. Admin cria campanha: escolhe **canal(is)** (pode ser multicanal com fallback — §1.10), **audiência** (1+ segmentos/listas ou filtro ad-hoc via DSL), **template** (ou escreve corpo, opcionalmente via IA §1.9), **agendamento** (enviar agora / data-hora / janela por TZ).
2. **Preview de audiência** (CRM `POST /segments/{id}/preview` reutilizado): mostra contagem estimada **e a contagem após gates** ("1.240 no segmento → 1.110 elegíveis: 90 sem consentimento de e-mail, 28 na suppression list, 12 sem e-mail"). Transparência é requisito de produto.
3. **Estimativa de custo** (§1.11): mostra custo projetado por canal antes de confirmar (WhatsApp e SMS custam por mensagem; e-mail/push tendem a custo marginal baixo).
4. Confirma → `scheduled` (ou `queued` se "agora").
5. No horário (respeitando TZ §1.7), job `comm_campaign_dispatcher`:
   - **Congela snapshot** de audiência (CRM).
   - **Dedup** de destinatário entre múltiplos segmentos/listas (§1.5) — uma pessoa em 3 segmentos recebe **1** mensagem.
   - Para cada membro: resolve **canal efetivo** (preferência + fallback), **locale/template**, aplica **gate de consentimento + supressão**, renderiza corpo.
   - Materializa `message_recipients` (pending/suppressed).
6. `comm_send_worker` despacha sob **throttling** (rate por provedor/conta/canal) — pgmq como fila de trabalho.
7. Webhooks do provedor (entrada §22) atualizam recipients (delivered/open/click/bounce/complaint).
8. Eventos escritos na **timeline do CRM** (`message.sent`, `message.delivered`, `message.opened`, `message.clicked`) via `crm_record_interaction` (idempotente).
9. **Conversão**: ver §1.12 — quando o membro realiza a ação-alvo (assinou/renovou/comprou ingresso) dentro da janela de atribuição, marca `converted` no recipient + `message.converted` na timeline.
10. Campanha → `completed` quando todos terminais ou janela expira; relatório final.

#### 1.5 Dedup de destinatário em múltiplos segmentos (edge case central)

- Uma campanha pode mirar **vários** segmentos/listas (`message_audiences` N:N). A mesma pessoa pode estar em vários.
- **Regra:** dedup por **`member_id`** no build da audiência → **um único** `message_recipient` por (campanha × membro × canal). Nunca duas mensagens da mesma campanha.
- **Dedup cross-channel:** se a campanha é multicanal com fallback (§1.10), o dedup é por **membro**, escolhendo **um** canal efetivo — não envia e-mail E push do mesmo conteúdo (salvo se o admin marcar explicitamente "multicanal simultâneo", que é caso raro e avisado).
- **Frequency capping (anti-fadiga):** edge case adicional — limite configurável de "máx. X mensagens de marketing por membro por janela (ex.: 7 dias)". Membro que estourou o cap vira `suppressed` com razão `frequency_cap` (não é opt-out; volta a receber depois). Default conservador; ajustável por org. **Transacionais nunca contam no cap.**
- **Dedup entre campanhas concorrentes:** duas campanhas agendadas para o mesmo horário com audiências sobrepostas — o frequency cap as concilia; sem cap, ambas saem (decisão de negócio, openQuestion).

#### 1.6 Throttling (edge case)

- **Por quê:** provedores impõem rate limits (ex.: e-mail X/seg por domínio aquecido; WhatsApp Cloud API tem tiers de mensagens/24h por número; push tem limites por projeto). Estourar = bloqueio/penalidade de reputação.
- **Como:** token-bucket por **(provedor, conta/sender, canal)** mantido no Postgres (`rate_buckets`) ou Redis-like; o worker só despacha se há token. pgmq segura a fila; visibility timeout reenfileira o que não coube.
- **Warm-up de domínio de e-mail:** ramp gradual de volume nos primeiros dias de um sender novo (limite crescente). Configurável por sender.
- **WhatsApp messaging tier:** o número começa com cap diário baixo (1k conversas) e sobe conforme qualidade/uso (Meta). O dispatcher **respeita o tier atual** e estende a campanha por mais janelas se necessário (não falha — agenda o excedente).
- **Edge case — campanha grande não cabe na janela:** se 50k e-mails não cabem na taxa do dia, a campanha **não falha**; o dispatcher distribui ao longo do tempo (com previsão de término exibida) ou respeita a janela TZ do dia seguinte.

#### 1.7 Fuso horário de envio (edge case)

- Cada membro tem `timezone` (de `member_profiles`, inferido por DDD/IP/perfil; default = timezone da org). A org define o **modo de agendamento** da campanha:
  - **`fixed`** — dispara num instante absoluto (UTC), todos ao mesmo tempo. Bom para drops/lançamentos sincronizados.
  - **`local_window`** — entrega "às 9h **no fuso de cada membro**", dentro de uma **janela permitida** (ex.: 9h–20h locais; nunca de madrugada — respeito + deliverability +, p/ WhatsApp, evitar reclamação). O dispatcher agrupa recipients por TZ e libera cada bucket quando bate a hora local.
  - **`send_time_optimization` (pós-MVP, IA):** melhor horário por membro a partir do histórico de abertura.
- **Edge cases:** membro sem TZ → cai no default da org; mudança de horário de verão → usar tz database (America/Sao_Paulo), nunca offset fixo; janela que cruza meia-noite; campanha `local_window` agendada para "hoje 9h" criada às 14h → quem já passou das 9h hoje recebe **amanhã** (ou imediatamente, conforme política — openQuestion).

#### 1.8 Opt-out, bounce e hard-fail (edge cases centrais — LGPD/deliverability)

- **Opt-out (descadastro):**
  - Todo e-mail de marketing carrega **link de unsubscribe** (one-click, List-Unsubscribe header — exigência de provedores) por canal. WhatsApp respeita "PARAR"/"SAIR" e o opt-out nativo da Cloud API.
  - Clique no unsubscribe → `consent` daquele canal vira `revoked` (CRM §08 §1.13), gera `consent.changed` na timeline, e o membro entra na **supressão lógica daquele canal** (não recebe mais marketing nele). **Transacional continua** (base legal de contrato), salvo opt-out total.
  - **Granularidade:** opt-out por **canal** no MVP; por **tipo de mensagem** (marketing/novidades/eventos) pós-MVP (CRM já prevê).
  - **Idempotência:** reclicar unsubscribe não erra; página confirma estado.
- **Bounce:**
  - **Soft bounce** (caixa cheia, indisponível temporário): retry com aging; após N soft bounces consecutivos → trata como hard.
  - **Hard bounce** (endereço inexistente, domínio inválido): recipient → `failed_hard`, e-mail entra na **suppression list** da org (`suppressions`) → futuras campanhas o suprimem automaticamente. Marca `member_profiles` com flag `email_invalid` para a UI sugerir corrigir contato.
- **Complaint (marcação de spam):** webhook de complaint (feedback loop do provedor) → `failed_hard` + suppression + **revoga consent do canal** (sinal forte de não-querer). Protege reputação de envio.
- **Hard-fail de WhatsApp:** número inexistente/sem WhatsApp, fora da janela de 24h sem template aprovado, template rejeitado/pausado pela Meta → `failed_hard` com razão específica; aciona **fallback** (§1.10) se configurado.
- **Suppression list (`suppressions`):** por (org, canal, destino_normalizado [email/phone]), razão (hard_bounce, complaint, manual, global_unsub), `created_at`. **Sempre** consultada no gate. Há também supressão **global Stanbase** (ex.: domínio sabidamente spam-trap) — pós-MVP.

#### 1.9 Copy assistida por IA na voz da marca (§19)

- Botão "Escrever com IA" no editor → chama `POST /v1/ai/copy` (ai-layer §19) passando: objetivo (ex.: convidar para evento), **brand voice** da org (tom, do/don't, exemplos — `brand_voice` em settings), canal (limita formato: push curto, WhatsApp com template, e-mail longo), segmento (contexto: "superfãs que não foram ao último evento"), variáveis disponíveis.
- IA retorna **rascunho** (1+ variações) com placeholders de variáveis preenchíveis. **Guardrail (§19.1):** IA **sugere e rascunha**; o envio exige revisão/confirmação humana. Nada é enviado direto pela IA sem aprovação.
- **Por canal:** para WhatsApp, a IA propõe o **corpo do template** que ainda precisa ir para **aprovação da Meta** (não pode enviar texto livre fora da janela de 24h). A IA avisa que o template precisa ser submetido.
- Saída auditável e ligada ao registro (CRM §08 — `ai_outputs`).
- **i18n:** IA pode gerar as três variantes de locale (pt-BR/en-US/es) a partir de um briefing único.

#### 1.10 Multicanal, preferência e fallback

- **Canal preferido por membro:** derivado de `consents` (só canais com consentimento entram) + preferência explícita do membro (área do membro) + disponibilidade de contato (tem e-mail? tem telefone WhatsApp?).
- **Fallback chain (opcional na campanha):** ex.: "tentar WhatsApp; se sem WhatsApp/sem consentimento, cair para e-mail; se sem e-mail, push". Cada membro resolve para **um** canal efetivo (respeita dedup §1.5).
- **Edge case — custo vs. fallback:** fallback pode escalar custo (WhatsApp > e-mail). A UI mostra a distribuição de canais efetivos e custo antes de confirmar.

#### 1.11 Custo por canal (edge case)

- **Modelo de custo (`channel_costs`):** custo unitário por canal/provedor, configurável (atualizável conforme contrato): e-mail (≈ custo marginal baixo, por mil), push (idem), **WhatsApp (por conversa/template — categoria marketing/utility/authentication tem preços distintos pela Meta)**, SMS (caro, se entrar).
- **Quem paga?** Decisão de negócio (openQuestion): (a) custo embutido na comissão da plataforma; (b) repassado à org como add-on; (c) cota grátis + excedente cobrado. Recomendação: e-mail/push inclusos; WhatsApp com cota + excedente, dado o custo Meta real.
- **Estimativa pré-envio:** `message_cost_estimate` calcula custo projetado da audiência elegível por canal. **Hard cap opcional** por campanha/mês para a org não estourar orçamento sem querer.
- **Custo real:** após envio, consolidamos custo real (do webhook/billing do provedor) em `message_recipients.cost` → relatório de custo por campanha.

#### 1.12 Métricas e atribuição de conversão (na timeline do CRM §11.2)

- **Funil por campanha:** enviados, entregues, taxa de entrega, aberturas (únicas/totais), cliques (únicos/totais, por link), **conversões**, descadastros, bounces, reclamações, custo, receita atribuída.
- **Tracking:**
  - **Abertura (e-mail):** pixel de tracking (1×1) — sabidamente impreciso (Apple MPP infla aberturas; muitos clientes bloqueiam). **Avisar na UI** que abertura é estimativa; priorizar clique/conversão como sinais reais.
  - **Clique:** link-wrapping (redirect via `r.stanbase.com/{token}` que registra e redireciona). Cada link tem token próprio.
  - **Push:** `delivered` e `opened` (tap) vêm do SDK/serviço de push.
  - **WhatsApp:** `sent`/`delivered`/`read` (duplo-tique azul, se o usuário não desativou) via webhook Cloud API.
- **Atribuição de conversão:** janela configurável (ex.: 7 dias) — se o membro realiza a ação-alvo da campanha (assinatura, upgrade, compra de ingresso, resgate de drop) **após** receber/clicar e dentro da janela → atribui conversão + receita (`transactions` correlacionadas). Modelo: **last-touch** no MVP (a última campanha clicada leva o crédito). UTM/`campaign_ref` propagado para o checkout liga a transação à campanha.
- **Timeline:** cada evento de funil vira `interaction` no membro (`message.sent/delivered/opened/clicked/converted`, `gift.sent/shipped/delivered/redeemed`), respeitando idempotência (CRM §08 §1.3).
- **Realtime:** contadores da campanha ao vivo via Supabase Realtime na tela do admin.

#### 1.13 Presentes (Gifts) — físicos e digitais

- **Gift = concessão a membro(s) específico(s)** (não é campanha de mensagem, embora possa **disparar** uma mensagem de aviso). Ex.: brinde ao superfã, código de cupom, item digital, kit físico.
- **Tipos:**
  - **`digital`** — código/cupom/arquivo/entitlement (ex.: VOD avulsa, badge, código de desconto). Entrega = gerar o ativo + mensagem com o link/código. Pode criar um **entitlement** (tiers-perks §09) se for acesso.
  - **`physical`** — item que precisa de **endereço de entrega** e fulfillment (envio manual ou via integração de logística futura). Coleta endereço (se faltar) + rastreio.
- **Relação com perk `drop` (tiers-perks §09):** um `drop` é um perk **por tier** (todo mundo do tier ganha). Um **gift** é **avulso e direcionado** (este membro, agora), podendo ou não referenciar um SKU de drop. Reuso: gift digital que concede entitlement usa a mesma engine de entitlement.
- **Gift pago vs. cortesia:** gift pode ser cortesia (custo absorvido pela org) ou **pago pelo membro** (raro — ex.: "compre um presente para outro membro"). Se pago, gera transação Asaas (split 7,99% normal). MVP: foco em **cortesia**.
- **Máquina de estados do gift:**
  ```
  draft ──► created ──(physical: needs_address?)──► awaiting_address ──► ready
                                                                          │
  ready ──fulfill──► fulfilling ──► shipped/issued ──► delivered/redeemed ──► completed
            │                          │
            └─ cancel (antes de        └─ failed (estoque/erro) ──► needs_attention
               shipped/issued)
  ```
- **Edge cases de gift:**
  - **Endereço ausente (físico):** dispara mensagem ao membro pedindo endereço (link para preencher), com prazo; se não responder, fica `awaiting_address` (não some).
  - **Estoque/limite:** `drop.limited_qty` — gift que excede estoque falha graciosamente (`needs_attention`), não silenciosamente.
  - **Downgrade/cancelamento depois do gift (tiers-perks §09 §449):** **drop/gift já entregue (`completed`/`redeemed`) é terminal** — não se "desfaz" envio físico nem código resgatado. Gift **pendente** pode ser cancelado.
  - **Idempotência:** conceder o mesmo gift duas vezes (retry) não duplica — `Idempotency-Key` + unique parcial.
  - **Membro anonimizado/excluído (LGPD):** gift físico pendente bloqueia/cancela; entregue mantém registro financeiro/logístico mínimo.

#### 1.14 Consentimento como gate (LGPD §26 — reutiliza CRM §08 §1.13)

- O motor **nunca** envia marketing num canal sem `consent.status = granted`. O gate roda **duas vezes** (build + despacho).
- **Transacional** (recibo, falha de cobrança, ingresso, alerta de segurança) usa base legal de **contrato/interesse legítimo** → não exige opt-in de marketing, mas **respeita supressão de hard-fail** (e-mail inexistente continua inexistente) e opt-out **total**.
- **Double opt-in** configurável por canal (WhatsApp na prática exige; e-mail recomendável). Sem opt-in confirmado → `pending`, não recebe marketing.
- A campanha **mostra** quantos foram suprimidos e por quê (transparência exigível em auditoria).

---

### 2. Modelo de dados

> Baseado em §25.5. Marcações: **[novo]** = nova; **[toca]** = ajuste de tabela do doc. Tudo com `org_id` + RLS.

**Tabelas do doc (§25.5) ajustadas:**

`messages` / `campaigns` **[toca]** → consolidamos numa tabela `campaigns` (o "message" do doc) + `message_recipients` para o fan-out.
- `campaigns`: `id`, `org_id`, `kind` (direct|campaign|transactional), `name`, `status` (draft|scheduled|queued|sending|paused|sent|completed|cancelled), `channels` (jsonb — lista ordenada p/ fallback), `template_id` nullable, `body_override` jsonb (corpo por locale se não usa template), `schedule_mode` (now|fixed|local_window|sto), `scheduled_at` (timestamptz), `local_window` jsonb (`{from_hour, to_hour}`), `audience_snapshot_id` nullable, `dedup_strategy`, `frequency_cap_exempt` bool, `cost_estimate` numeric, `cost_actual` numeric, `stats` jsonb (denormalizado: counts), `campaign_ref` text (para UTM/atribuição), `created_by`, `created_at`, `updated_at`, `sent_at`, `completed_at`.
- Índices: INDEX(`org_id`, `status`); INDEX(`org_id`, `scheduled_at`) WHERE status='scheduled'; INDEX(`campaign_ref`).

`gifts` **[toca]**
- `id`, `org_id`, `member_id`, `type` (digital|physical), `drop_perk_id` nullable (FK perks §09 se referencia drop), `name`, `config` jsonb (sku, code, file_url, entitlement_ref, value), `paid` bool, `transaction_id` nullable, `status` (draft|created|awaiting_address|ready|fulfilling|shipped|issued|delivered|redeemed|completed|cancelled|failed|needs_attention), `shipping` jsonb (address, tracking_code, carrier), `message_id` nullable (mensagem de aviso disparada), `idempotency_key`, `created_by`, `created_at`, `updated_at`, `completed_at`.
- Índices: INDEX(`org_id`, `member_id`); INDEX(`org_id`, `status`); UNIQUE(`idempotency_key`) WHERE not null.

**Tabelas novas [novo]:**

`message_recipients` — fan-out por destinatário (alto volume; particionável).
- `id` uuid PK, `campaign_id` FK, `org_id`, `member_id`, `channel` (email|push|whatsapp|sms), `locale`, `destination_hash` (email/phone normalizado, hash p/ correlação sem PII crua em índice), `provider`, `provider_message_id` nullable, `status` (pending|suppressed|queued|sent_to_provider|accepted|delivered|opened|clicked|converted|bounced_soft|bounced_hard|complained|failed_soft|failed_hard|cancelled), `suppress_reason` nullable (no_consent|in_suppression|frequency_cap|no_contact|no_template|invalid), `attempts` smallint, `cost` numeric, `error` jsonb, `sent_at`, `delivered_at`, `first_opened_at`, `first_clicked_at`, `converted_at`, `conversion_transaction_id` nullable, `created_at`.
- Índices: INDEX(`campaign_id`, `status`); UNIQUE(`campaign_id`, `member_id`, `channel`) (dedup duro); INDEX(`provider`, `provider_message_id`) (correlação webhook); INDEX(`org_id`, `member_id`, `created_at`) (frequency cap); partição por RANGE de `created_at` em escala.

`message_audiences` — N:N campanha ↔ segmentos/listas/membros.
- `campaign_id`, `source_type` (segment|list|member|filter), `source_id` (nullable p/ filter), `filter_rules` jsonb (DSL ad-hoc), `exclude` bool (segmento de exclusão). PK composta lógica.

`audience_snapshots` **[novo]** — congelamento reproduzível (espelha CRM segment snapshot, mas dono é a campanha).
- `id`, `campaign_id`, `org_id`, `member_count`, `eligible_count`, `built_at`, `breakdown` jsonb (por canal/razão de supressão).

`message_templates` **[novo]**
- `id`, `org_id`, `channel`, `name`, `category` (marketing|transactional|utility), `bodies` jsonb (`{ "pt-BR": {...}, "en-US": {...}, "es": {...} }` — subject/body/cta por locale), `variables` jsonb (whitelist de placeholders), `whatsapp_template_id` nullable (FK), `status` (draft|active|archived), `created_by`, `created_at`, `updated_at`.

`whatsapp_templates` **[novo]** — registro/aprovação Meta (edge case central).
- `id`, `org_id`, `connection_id` (FK community-channels WhatsApp), `name` (namespace Meta), `category` (MARKETING|UTILITY|AUTHENTICATION), `language` (locale), `components` jsonb (header/body/footer/buttons + variáveis posicionais), `meta_status` (pending|approved|rejected|paused|disabled), `meta_template_id`, `rejection_reason`, `submitted_at`, `approved_at`. Sincronizado via API/webhook da Meta.
- Constraint: só `meta_status='approved'` pode ser usado em envio.

`suppressions` **[novo]**
- `id`, `org_id`, `channel`, `destination_normalized` (email/phone E.164), `reason` (hard_bounce|complaint|manual|global_unsub|invalid), `created_at`, `created_by`. UNIQUE(`org_id`,`channel`,`destination_normalized`).

`channel_costs` **[novo]** — tabela de custo por canal/provedor/categoria.
- `id`, `org_id` nullable (null = default plataforma), `channel`, `provider`, `category`, `unit` (per_message|per_conversation|per_thousand), `unit_cost` numeric, `currency`, `effective_from`.

`rate_buckets` **[novo]** — token-bucket de throttling.
- `key` (org/provider/channel/sender), `tokens` numeric, `refill_rate`, `capacity`, `updated_at`. (Ou implementado em Redis-like; tabela como fallback durável.)

`comm_events_raw` **[novo]** — webhooks crus dos provedores (auditoria/replay/dedup de eventos).
- `id`, `provider`, `payload` jsonb, `signature_valid` bool, `correlated_recipient_id` nullable, `event_type`, `received_at`, `processed_at`. INDEX(`provider`, `received_at`).

`brand_voice` **[novo]** (ou parte de org settings) — perfil de voz da marca p/ IA.
- `org_id`, `tone`, `dos` jsonb, `donts` jsonb, `examples` jsonb, `default_locale`, `signature`.

**Consome de outros domínios (não cria):** `consents`/`consent_history`, `segments`/`lists`/`segment_members` (CRM §08), `interactions` (timeline), `member_profiles` (email/phone/locale/timezone), `transactions` (atribuição/gift pago), `perks` (drop), `entitlements` (gift digital→acesso), `connections` (WhatsApp), `webhooks`.

**RLS:** todas por `org_id`. `message_recipients` e `comm_events_raw` são alto-volume → índices enxutos + partição. PII (email/phone) **não** fica em claro em índices — usamos hash/normalizado; corpo renderizado com PII não é persistido após envio (re-renderizável do template + variáveis; ou guardado cifrado por janela curta para troubleshooting).

---

### 3. API & Edge Functions

**Endpoints REST `/v1` (do doc §21.2 + novos):**

Do doc:
```
POST   /v1/messages                 # criar mensagem/campanha p/ segmento (kind=direct|campaign)
POST   /v1/gifts                    # conceder presente a membro
```

Novos (comunicação):
```
# Campanhas / mensagens
GET    /v1/messages                       # listar campanhas (filtro por status/canal)
POST   /v1/messages                       # criar (draft) — direct|campaign
GET    /v1/messages/{id}                  # detalhe + stats
PATCH  /v1/messages/{id}                  # editar draft/scheduled
POST   /v1/messages/{id}/preview-audience # contagem + breakdown de elegibilidade
POST   /v1/messages/{id}/estimate-cost    # custo projetado por canal
POST   /v1/messages/{id}/test-send        # envio de teste para um destino (admin)
POST   /v1/messages/{id}/schedule         # agenda (fixed|local_window|sto)
POST   /v1/messages/{id}/send             # send_now → queued
POST   /v1/messages/{id}/pause            # sending → paused
POST   /v1/messages/{id}/resume
POST   /v1/messages/{id}/cancel
GET    /v1/messages/{id}/recipients       # cursor; estado por destinatário
GET    /v1/messages/{id}/metrics          # funil consolidado (entrega/abertura/clique/conversão/custo)

# Templates
GET    /v1/templates                      POST /v1/templates
PATCH  /v1/templates/{id}                 DELETE /v1/templates/{id}   # archive
# WhatsApp templates (aprovação Meta)
GET    /v1/whatsapp-templates
POST   /v1/whatsapp-templates             # submete p/ aprovação Meta
GET    /v1/whatsapp-templates/{id}        # status (pending/approved/rejected)
POST   /v1/whatsapp-templates/{id}/sync   # força sync de status com a Meta

# Gifts
GET    /v1/gifts                          POST /v1/gifts
GET    /v1/gifts/{id}
PATCH  /v1/gifts/{id}                     # endereço, status manual (fulfill/ship)
POST   /v1/gifts/{id}/fulfill
POST   /v1/gifts/{id}/cancel
POST   /v1/gifts/{id}/address             # membro preenche endereço (front membro)

# Consentimento/preferências (reusa CRM; expostos aqui p/ a área do membro)
GET    /v1/me/preferences                 # preferências do membro (canais)
PUT    /v1/me/preferences
GET    /v1/u/{token}/unsubscribe          # landing pública de descadastro (one-click)
POST   /v1/u/{token}/unsubscribe          # confirma descadastro (canal/total)

# Supressão / custo
GET    /v1/suppressions                   POST /v1/suppressions   DELETE /v1/suppressions/{id}
GET    /v1/channel-costs                  PUT  /v1/channel-costs

# Brand voice + IA (consome ai-layer)
GET    /v1/brand-voice                    PUT  /v1/brand-voice
POST   /v1/ai/copy                        # rascunho na voz da marca (do doc §21.2)

# Webhooks de entrada dos provedores
POST   /v1/webhooks/email/{provider}      # delivered/open/click/bounce/complaint
POST   /v1/webhooks/push/{provider}
POST   /v1/webhooks/whatsapp              # status + template status + inbound msgs
POST   /v1/r/{token}                      # click-tracking redirect (GET na prática)
GET    /v1/o/{token}.gif                  # open-tracking pixel
```

**Edge Functions / Jobs:**
- `comm_campaign_dispatcher` (job, on-schedule via pg_cron + on send_now) — congela snapshot, dedup, gate de consentimento/supressão, materializa `message_recipients`, enfileira no pgmq. Idempotente + lock anti-double-send.
- `comm_send_worker` (worker pgmq) — consome recipients `queued`, respeita throttling (token-bucket), chama o **channel adapter**, grava `accepted`/`failed_soft`. Backoff em soft-fail.
- `comm_webhook_ingest` (Edge Function por provedor) — valida assinatura, grava `comm_events_raw`, correlaciona ao recipient por `provider_message_id`, aplica transição de estado (delivered/open/click/bounce/complaint), efeitos colaterais (suppression, revoke consent), escreve timeline.
- `comm_tz_releaser` (cron de minuto) — em `local_window`, libera buckets de TZ quando bate a hora local.
- `comm_whatsapp_template_sync` (cron + webhook) — sincroniza status de aprovação dos templates com a Meta.
- `comm_conversion_attributor` (on-event de `transaction`/`subscription`) — casa conversões com recipients dentro da janela; marca `converted` + timeline + receita.
- `comm_cost_consolidator` (job) — reconcilia custo real do provedor por campanha.
- `comm_gift_fulfillment` (worker) — orquestra estados do gift (digital: gera ativo/entitlement; physical: coleta endereço/aciona envio).
- `comm_campaign_completer` (cron) — fecha campanhas cujos recipients são todos terminais ou cuja janela de eventos expirou; consolida stats.
- **Channel adapters** (módulo, não job): `email_adapter`, `push_adapter`, `whatsapp_adapter` — interface comum `send(renderedMessage) → {providerMessageId|error}` + `parseWebhook(payload) → normalizedEvents[]`.

**Idempotência:** `POST /messages/.../send`, `/gifts`, e ingestão de webhook aceitam/derivam `Idempotency-Key` (§21.1). Eventos de webhook deduplicados por `provider_message_id + event_type + timestamp`.

---

### 4. Telas/Front

**Admin (módulo "Comunicação" §10.1 item 8):**
1. **Lista de campanhas** — tabela com status, canal, audiência, agendamento, métricas resumidas (entregue/aberto/clicado/convertido), custo. Filtros por status/canal. Ações: duplicar, editar, cancelar.
2. **Compositor de campanha** (wizard):
   - **Passo 1 — Audiência:** seletor de segmentos/listas (reusa `<RuleBuilder/>` do CRM para filtro ad-hoc), segmentos de exclusão, preview de contagem **e elegibilidade** (com breakdown de supressão).
   - **Passo 2 — Canal & conteúdo:** escolha de canal(is) + fallback, seletor/edição de template por locale, **"Escrever com IA"** (voz da marca), preview por canal/dispositivo, variáveis. Para WhatsApp: seletor de template **aprovado** (bloqueia se não aprovado) + aviso de janela 24h.
   - **Passo 3 — Agendamento:** agora / data-hora fixa / janela por TZ local; preview de "quando cada bucket sai".
   - **Passo 4 — Revisão:** elegíveis, **estimativa de custo**, frequency cap, test-send, confirmar.
3. **Detalhe da campanha** — funil ao vivo (Realtime), gráfico de entrega ao longo do tempo, por canal, lista de recipients filtrável por estado, log de bounces/complaints, custo real, receita atribuída. Botões pause/resume/cancel.
4. **Templates** — CRUD multi-locale, variáveis, preview. **WhatsApp templates:** submissão à Meta, status (pending/approved/rejected + motivo), editor de componentes (header/body/footer/botões).
5. **Presentes** — lista de gifts por estado, criar gift (escolher membro(s), tipo, SKU/código/arquivo, mensagem de aviso), fila de fulfillment físico (endereços, rastreio), gifts que precisam de atenção.
6. **Supressões** — lista por canal/razão, busca, adicionar/remover manual (auditado), import de supressão.
7. **Preferências de comunicação / Voz da marca** — editor de `brand_voice`; configurações de janela TZ default, frequency cap, custos por canal, hard caps de orçamento.

**Front de membro (§24.2 "Perfil/preferências"):**
- **Centro de preferências** — toggles de consentimento por canal (e-mail/push/WhatsApp), preferência de canal, descadastro. Push: prompt de permissão do navegador/PWA.
- **Landing de unsubscribe** (pública, via token no link) — one-click, confirma canal/total.
- **Preencher endereço de gift** (quando recebe gift físico) — formulário via link.
- **Inbox/notificações** (opcional) — histórico de mensagens recebidas na área do membro.

**Componentes-chave:** `<CampaignComposer/>`, `<AudiencePreview/>` (com breakdown de elegibilidade), `<ChannelContentEditor/>`, `<AICopyButton/>`, `<TemplatePreview/>` (por canal/locale), `<WhatsAppTemplateForm/>`, `<CampaignFunnel/>` (Realtime), `<RecipientTable/>`, `<GiftFulfillmentBoard/>`, `<ConsentToggles/>` (compartilhado com CRM), `<SuppressionList/>`.

---

### 5. Integrações externas

- **Provedor de e-mail (a decidir §8):** candidatos — Resend, Amazon SES, Postmark, SendGrid. Envio + webhooks (delivered/open/click/bounce/complaint) + List-Unsubscribe + warm-up de domínio. Isolado pelo `email_adapter`.
- **Provedor de push (a decidir §8):** Web Push (VAPID) nativo p/ PWA; FCM/OneSignal se app nativo entrar. APNs já é usado para passes (passport §08 doc) — **não confundir** push de passe (PassKit/APNs) com push de marketing.
- **WhatsApp — API Oficial (Cloud API / BSP) (§30 decidido):** envio por **template aprovado pela Meta** fora da janela de 24h; mensagem livre só dentro da janela de sessão (resposta do usuário). Webhooks de status (sent/delivered/read/failed) + status de aprovação de template + mensagens inbound. Compartilha a `connection` WhatsApp com community-channels.
- **Meta Business / WhatsApp Manager:** submissão e aprovação de templates, categorias (marketing/utility/auth) com preços distintos, qualidade do número (messaging tier).
- **LLM (Claude, ai-layer §19):** geração de copy na voz da marca, variações e tradução para os 3 locales.
- **Asaas (payments-billing):** gift pago → cobrança/split; conversão atribuída casa com `transactions`.
- **Supabase:** pgmq (filas de envio), pg_cron (scheduler/TZ releaser/completer), Realtime (funil ao vivo), Storage (anexos/arquivos de gift digital), pgvector indireto (similaridade de audiência via CRM).
- **Webhooks de saída (§22):** `message.sent`, `campaign.completed`, `gift.shipped` etc. para o stack do dono.
- **CRM (§08):** segmentos/listas/consents/timeline — dependência forte e bidirecional.
- **MCP (§23):** "crie um segmento de superfãs sem presença no último evento e rascunhe um convite" → compõe CRM (segmento) + ai/copy + messages (draft) — caso de uso citado no doc §23.

---

### 6. Épicos & tarefas

**Épico A — Modelo de dados & RLS**
- A1. Migrations: `campaigns` (consolida messages), `message_recipients` (+partição), `message_audiences`, `audience_snapshots`, `message_templates`, `whatsapp_templates`, `suppressions`, `channel_costs`, `rate_buckets`, `comm_events_raw`, `brand_voice`; ajuste de `gifts` — **L**
- A2. RLS por `org_id` em todas + testes de isolamento; índices (dedup unique, correlação webhook, frequency cap) — **M**
- A3. Particionamento de `message_recipients`/`comm_events_raw` + rotina de partição — **M**

**Épico B — Channel adapters & envio**
- B1. Interface `ChannelAdapter` (send + parseWebhook) + registry de provedor — **M**
- B2. `email_adapter` (provedor a decidir) — envio, List-Unsubscribe, warm-up, webhooks — **L**
- B3. `push_adapter` (Web Push/VAPID p/ PWA) — subscription, envio, eventos — **M**
- B4. `whatsapp_adapter` (Cloud API) — envio por template, janela 24h, inbound, webhooks — **L**
- B5. `comm_send_worker` (pgmq) + throttling token-bucket por provedor/sender — **L**
- B6. Retry/backoff de soft-fail + transição failed_hard — **M**

**Épico C — Campanhas & orquestração**
- C1. CRUD de campanha + máquina de estados (draft→...→completed) com lock anti-double-send — **L**
- C2. `comm_campaign_dispatcher`: snapshot de audiência (reusa CRM) + **dedup** multi-segmento + materialização de recipients — **L**
- C3. Gate de consentimento + supressão (build + despacho) + breakdown de elegibilidade — **M**
- C4. `preview-audience` + `estimate-cost` + test-send — **M**
- C5. Agendamento `fixed` + `local_window` (TZ por membro) + `comm_tz_releaser` — **L**
- C6. Frequency capping (anti-fadiga) por janela, exceção transacional — **M**
- C7. `comm_campaign_completer` + consolidação de stats — **M**

**Épico D — Templates & WhatsApp/Meta**
- D1. CRUD `message_templates` multi-locale + variáveis (whitelist) + render seguro — **M**
- D2. `whatsapp_templates`: submissão à Meta + `comm_whatsapp_template_sync` (status/rejeição) — **L**
- D3. Bloqueio de envio WhatsApp sem template aprovado + categoria/preço — **M**
- D4. Editor de componentes WhatsApp (header/body/footer/botões/variáveis posicionais) — **M**

**Épico E — Métricas, tracking & atribuição**
- E1. Open-pixel (`/o/{token}.gif`) + click-wrapping (`/r/{token}`) + correlação — **M**
- E2. `comm_webhook_ingest` por provedor: validar assinatura, normalizar eventos, transição de estado, efeitos colaterais — **L**
- E3. Escrita na timeline do CRM (`message.*`) idempotente — **M**
- E4. `comm_conversion_attributor` (janela + last-touch + receita) + `campaign_ref`/UTM no checkout — **L**
- E5. Funil consolidado (`/messages/{id}/metrics`) + Realtime no admin — **M**
- E6. `comm_cost_consolidator` (custo real por campanha) — **M**

**Épico F — Opt-out / bounce / supressão (LGPD/deliverability)**
- F1. Unsubscribe one-click (landing + token) → revoga consent + suppression + timeline — **M**
- F2. Suppression list + gate automático + flag `email_invalid` no perfil — **M**
- F3. Tratamento de complaint (feedback loop) → suppression + revoke consent — **M**
- F4. Centro de preferências do membro (front) + push permission prompt — **M**

**Épico G — Presentes (Gifts)**
- G1. CRUD gift + máquina de estados (digital/physical) — **M**
- G2. `comm_gift_fulfillment`: digital (entitlement/código/arquivo) + physical (endereço/rastreio) — **L**
- G3. Coleta de endereço pelo membro (link + form) + prazos — **M**
- G4. Integração com perk `drop`/estoque (tiers-perks) + gift pago (Asaas) — **M**
- G5. Board de fulfillment + gifts "needs attention" — **S**

**Épico H — Copy por IA (voz da marca)**
- H1. `brand_voice` settings + UI — **S**
- H2. `POST /ai/copy` integrado ao compositor (contexto: objetivo/canal/segmento/variáveis) + variações + i18n — **M**
- H3. Guardrail de revisão humana + auditoria de saída IA — **S**

**Épico I — Webhooks de saída & MCP**
- I1. Emitir `message.sent`/`campaign.completed`/`gift.shipped` (webhooks §22) — **S**
- I2. Tools MCP (criar campanha draft, rascunhar copy, conceder gift, ver métricas) — **M**

---

### 7. Dependências

- **fundacao** — schema base, RLS multi-tenant, pgmq (filas de envio), pg_cron (scheduler/TZ/completer), Realtime, Storage. (Bloqueante.)
- **crm** — `segments`/`lists` (audiência), **DSL de regras** (`<RuleBuilder/>`), `consents`/`consent_history` (gate de canal — **já modelado lá**), `interactions`/timeline (escrevemos `message.*`/`gift.*`), `member_profiles` (email/phone/locale/timezone), lifecycle/RFM como campos de segmentação. (Bloqueante — sem segmento/consentimento não há campanha legal.)
- **member-identity** — `members`/`member_id`, contato e idioma do membro. (Bloqueante.)
- **community-channels** — `connection` WhatsApp compartilhada (mesmo número/BSP); separação broadcast vs. pertencimento de grupo. (Forte p/ WhatsApp.)
- **tiers-perks** — perk `drop`/estoque (gift), `entitlements` (gift digital→acesso), tier como dado de segmentação. (Forte p/ presentes.)
- **payments-billing** — gift pago (Asaas/split), `transactions` p/ atribuição de conversão e receita. (Forte p/ conversão/gift pago; campanhas sem conversão funcionam sem.)
- **ai-layer** — `ai/copy` (voz da marca), tradução, send-time optimization (pós-MVP). (Para copy IA; envio manual funciona sem.)
- **auth-rbac** — permissões: quem pode enviar campanha, gastar orçamento (custo), conceder gift, editar supressão. (Bloqueante.)
- **webhooks** — emite `message.*`/`gift.*`. (Pós-core.)
- **public-api / mcp** — expõem o domínio (dogfooding). (Paralelo.)
- **security-lgpd** — consentimento por canal, base legal transacional vs. marketing, DPA com provedores (e-mail/push/WhatsApp/LLM), minimização de PII em índices. (Bloqueante p/ go-live.)
- **observability-qa** — métricas de fila/throttling, DLQ de envio, monitor de bounce-rate/complaint-rate (reputação), webhooks de provedor. (Operacional/forte — deliverability é risco.)
- **integrations-framework** — padrão de `connection` para provedores (e-mail/push/WhatsApp) com credenciais cifradas. (Forte.)

---

### 8. Riscos & decisões técnicas

- **Double-send (risco nº 1):** dois workers re-disparando a mesma campanha. Mitigação: lock + `SKIP LOCKED` no pgmq, flag de estado idempotente em `campaigns`, unique `(campaign_id, member_id, channel)` em recipients (o banco impede duplicata mesmo se a app falhar).
- **Provedor de e-mail/push indefinido:** isolado pelo **channel adapter** — a decisão (§30 item 7) não bloqueia o desenho. Recomendação e-mail: Resend ou SES (custo) com Postmark como alternativa premium de deliverability; push: Web Push/VAPID nativo no PWA (sem custo de terceiro). **Decisão de produto pendente (openQuestion).**
- **WhatsApp = friction máxima:** template precisa de **aprovação prévia da Meta** (horas a dias), categorias com preços distintos, janela de 24h, qualidade do número (messaging tier) limita volume. Não dá para "mandar WhatsApp livre em massa". O produto precisa educar o admin (status do template, aviso de janela). Risco de rejeição/pausa de template → fallback de canal.
- **Throttling & reputação de e-mail:** estourar rate/volume queima reputação de domínio → spam folder. Warm-up obrigatório, monitorar bounce/complaint rate (alertar e **pausar automaticamente** acima de threshold — proteção). DKIM/SPF/DMARC do domínio da org (ou subdomínio Stanbase) — configuração de envio.
- **Fuso horário:** usar tz database (DST), nunca offset fixo; `local_window` agrupa por TZ; membro sem TZ → default org. Edge: janela cruzando meia-noite, campanha local agendada para horário já passado hoje.
- **Dedup multi-segmento:** unique duro no banco + dedup por `member_id` no build; cross-channel escolhe um canal efetivo. Frequency cap concilia campanhas concorrentes.
- **Métrica de abertura é mentira parcial:** Apple MPP e bloqueio de imagens inflam/zeram aberturas. UI deve rotular abertura como estimativa e destacar **clique/conversão** como sinais reais. Não tomar decisão de negócio só por open rate.
- **Atribuição de conversão:** last-touch no MVP (simples e suficiente); multi-touch é over-engineering inicial. Janela configurável; `campaign_ref`/UTM propagado ao checkout é a cola. Risco de sobre-creditar campanhas.
- **Consentimento como gate (LGPD):** marketing exige opt-in por canal; transacional usa base legal de contrato. **Nunca misturar** — separação por `kind`/`category` da mensagem. Gate roda 2× (build+despacho) porque consent muda no meio. Opt-out e complaint revogam consent. DPA com cada subprocessador.
- **PII em alto volume:** `message_recipients` não guarda email/phone em claro em índices (hash/normalizado); corpo renderizado com PII não persiste após envio (re-render do template). Webhooks crus em `comm_events_raw` podem conter PII → retenção curta + acesso restrito.
- **Custo descontrolado:** WhatsApp/SMS custam por mensagem; campanha grande sem cap pode gerar fatura alta. Hard cap por campanha/mês + estimativa pré-envio obrigatória + quem paga é decisão de negócio (openQuestion).
- **Gift físico ≠ reversível:** drop/gift entregue é terminal (espelha tiers-perks §09 §449); pendente é cancelável. Endereço ausente não some — fica `awaiting_address`. Estoque esgotado falha graciosamente.
- **Campanha grande não cabe na janela:** dispatcher distribui no tempo (não falha) respeitando throttling e messaging tier do WhatsApp.
- **Snapshot de audiência:** congelado no envio (reprodutibilidade + idempotência), reusando a mecânica de snapshot do CRM — evita audiência mudando durante o disparo.

---

### 9. Escopo MVP vs. depois

**MVP (Fase 2 §29 — "Comunicação (e-mail/push), campanhas por segmento, presentes"):**
- **Canais:** e-mail + push (Web Push/PWA). **WhatsApp pode entrar no MVP** dado §30 ("sempre API Oficial"), mas como **fast-follow** se a aprovação Meta/onboarding BSP atrasar (não bloquear o MVP de e-mail/push).
- Campanhas `direct` e `campaign` a partir de segmentos/listas (reusa CRM) + dedup multi-segmento.
- Templates multi-locale (pt-BR/en-US/es) + variáveis.
- Agendamento `now` e `fixed`; **`local_window` (TZ)** desejável no MVP (envio civilizado importa), mas pode ser fast-follow.
- Gate de consentimento + supressão por canal; unsubscribe one-click; tratamento de bounce/complaint.
- Métricas de funil (entregue/aberto/clicado) + timeline no CRM; atribuição de conversão last-touch básica.
- Throttling básico + warm-up de e-mail; estimativa de custo simples.
- **Presentes:** gift digital (código/entitlement) + físico com coleta de endereço e estado manual; cortesia (gift pago = pós-MVP).
- Copy por IA no compositor (depende de ai-layer; se a IA atrasar, editor manual cobre).

**Depois:**
- WhatsApp completo com gestão de aprovação de templates Meta e categorias/preços (se não couber no MVP).
- `send_time_optimization` por IA (melhor horário por membro).
- Atribuição multi-touch; preferências granulares por **tipo** de mensagem (além de canal).
- Frequency capping avançado, supressão global Stanbase, A/B testing de copy/assunto.
- Inbox do membro (histórico de mensagens na área do membro), SMS como canal.
- Fulfillment de gift físico via integração de logística (rastreio automático), gift pago (compre p/ outro membro).
- Send-time analytics e coortes de campanha, automações disparadas por evento ("welcome series", "win-back").
