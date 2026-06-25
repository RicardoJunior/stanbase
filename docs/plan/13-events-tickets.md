## 13. Eventos & Ingressos

> **Domínio:** ciclo de vida de eventos (CRUD com data, local, capacidade, tipos de ingresso, lotes), venda nativa de ingresso que vira **passport pass**, lote de membro / acesso antecipado / preço por tier, **drops e ativações exclusivas** na área de membro, importação/sincronização com **Sympla/Ingresse**, e a alimentação do **CRM** e do **Hall of Fame** a partir do check-in.
> **Fontes de verdade no STANBASE.md:** §14 (Eventos e ingressos — escopo), §8.5 (ingresso no passport), §9 (validação/check-in), §12.2 (perks `event` e `drop`), §20 (integração Sympla/Ingresse), §21.2 (endpoints `/v1/events`, `/v1/tickets`), §25.4 (`events`, `tickets`, `checkins`, `passes`), §13 (split/comissão sobre ingresso), §11/§18 (CRM e Hall of Fame consomem presença).
> **Decisões imutáveis aplicáveis:** PSP = **Asaas** (todo ingresso pago passa pelo split 7,99% como qualquer transação — §13.2; tipo `transactions.type = ticket`); Member ID = 8 chars sem dígito verificador (todo ingresso de membro ancora no `member_id`); Passport = **Apple + Google** (cada ingresso é um `eventTicket`); **1 membership por org** (lote/preço de membro é por tier da própria org); uma Conta possui N orgs.
> **Fronteira com `verification-checkin`:** este domínio **cria e administra** `events`/`tickets`/lotes/drops; o domínio `verification-checkin` **valida e dá check-in** (scanner, anti-reuso, offline, token do QR). A máquina de estados do `ticket` é **co-propriedade**: este domínio é dono de `issued/valid/void/refunded/transferred`; `verification-checkin` é dono da transição `valid→used` (check-in). Não duplicar a lógica de portaria aqui.

---

### 13.1 Como funciona

#### 13.1.1 Os objetos do domínio

| Objeto | O que é | Vendável? |
|---|---|---|
| **Event** | Um acontecimento com data/janela, local (presencial/online/híbrido), capacidade total e política de check-in. | — |
| **Ticket Type** (tipo de ingresso) | Uma categoria vendável dentro do evento (ex.: "Pista", "Camarote", "Meia"). Tem preço-base, capacidade própria, e regras de elegibilidade (público / só-membro / por-tier). | sim |
| **Batch / Lote** | Uma faixa temporal+quantidade de um ticket type com preço próprio (ex.: "1º lote", "Lote de membro", "Last call"). Vende-se sempre dentro do **lote ativo**. | sim |
| **Ticket** (ingresso) | A instância comprada/emitida: vinculada a `event` + `ticket_type` + `batch`, opcionalmente a um `member_id`, com `holder_name` para convidado/não-membro. Vira **um passport pass** (`eventTicket`) com QR. | — |
| **Drop / Ativação** | Item exclusivo (físico/digital) ou ação liberada na área de membro por tier (ex.: brinde limitado, NFT-like, sorteio, "garanta seu lugar"). Pode ou não estar atrelado a evento. | sim (se pago) |
| **Waitlist entry** | Pessoa na lista de espera de um ticket type/lote esgotado, com posição e janela de conversão quando vaga abre. | — |

> **Relação com `tiers-perks` (§12.2):** o perk `event` (`{ event_id, access:'early|included|member_price', discount_pct }`) é a **ponte** entre tier e evento. Ele **não duplica** a venda — ele concede *direitos* (acesso antecipado, lote de membro, preço de membro, ingresso incluso) que este domínio **lê** no checkout. O drop nativo na área de membro materializa o perk `drop` (`{ sku, fulfillment, limited_qty }`).

#### 13.1.2 Máquina de estados — `event.status`

```
draft ──publish──▶ published ──┬── (vendas abrem por lote) ──▶ on_sale
  ▲                            │
  └── unpublish ──────────────┘
published/on_sale ── sold_out (DERIVADO: capacidade total atingida; não é coluna)
published/on_sale ──postpone──▶ postponed ──reschedule──▶ published (nova data)
published/on_sale ──cancel────▶ canceled  (dispara fluxo de reembolso em massa, §13.8.4)
published/on_sale ── (starts_at passou) ──▶ live ──(ends_at passou)──▶ finished
finished ──▶ archived
```

- `draft`: editável livremente, não vende, não aparece para o membro.
- `published`: visível; vende quando há **lote ativo** + vaga.
- `on_sale`/`sold_out`: estados **derivados** da soma de capacidade dos ticket types/lotes vs. emitidos (não persistidos como coluna — computados; igual ao `sold_out` de tiers em §1.8 de tiers-perks).
- `postponed`: data adiada. **Ingressos permanecem válidos** (não cancela tickets); membro é notificado; passport pass é atualizado via push (nova data). Política de reembolso opcional para quem não pode na nova data (§13.8.4).
- `canceled`: dispara reembolso em massa + void de todos os tickets + revogação dos passes + notificação. Terminal.
- `live`/`finished`: derivados de `starts_at`/`ends_at` (cron `event-lifecycle` materializa para facilitar query).

#### 13.1.3 Máquina de estados — `ticket.status` (co-propriedade)

```
                       ┌──────────────── transfer ───────────────┐
                       ▼                                          │
reserved ──pay/issue──▶ valid ──check-in (verification-checkin)──▶ used
   │  (hold TTL)          │                                       │
   └── expire ──▶ void    ├── refund ──────────▶ refunded         └─(reentrada: política do evento, ver verification-checkin §12.8.3)
   └── cancel ──▶ void    ├── transfer_out ─────▶ transferred (gera novo ticket valid p/ destinatário)
                          └── event_canceled ───▶ void (+ refund se pago)
```

- **`reserved`** (hold): vaga segurada durante o checkout, com **TTL** (default 10 min). Conta como ocupação para evitar oversell (§13.8.1). `expire` libera a vaga.
- **`valid`**: pago/emitido. Gera o **pass** (`eventTicket`) no passport. É o estado-base do ingresso ativo.
- **`used`**: check-in efetivo — **escrito pelo domínio `verification-checkin`** (transição `valid→used`, idempotente, anti-reuso). Este domínio só **lê** `used` para relatórios/Hall of Fame.
- **`refunded`**: estorno (§13.8.3) — reverte split via payments-billing, revoga o pass.
- **`transferred`**: titularidade transferida (§13.8.5) — o ticket original vira `transferred` (tombstone) e um **novo** ticket `valid` nasce para o destinatário (com novo pass/QR — o QR antigo é revogado para anti-reuso).
- **`void`**: cancelado antes do uso (hold expirado, cancelamento de pedido, evento cancelado sem pagamento).

> **Princípio:** este domínio **nunca** escreve `used` diretamente. Anti-reuso, lock de linha (`SELECT FOR UPDATE`), offline e token do QR vivem em `verification-checkin`. Aqui garantimos só que o `ticket` existe, é `valid`, pertence ao evento e tem pass emitido.

#### 13.1.4 Elegibilidade do ticket type — quem pode comprar o quê

Cada `ticket_type` tem `audience`:

| `audience` | Quem compra | Preço | Edge cases |
|---|---|---|---|
| `public` | qualquer pessoa (membro ou não) | preço-base do lote ativo | não-membro vira **lead/member** sem login (§13.8.2) |
| `member_only` | só quem tem membership **ativa** na org | preço-base; pode ter `member_price` | bloqueia não-membro; oferece CTA "vire membro para comprar" |
| `tier_gated` | só membros de tiers em `allowed_tiers` | preço-base ou `member_price` por tier | downgrade após compra **honra o ingresso** (§12.2 / tiers-perks §1.8) |
| `included` | membros de tiers cujo perk `event.access=included` | **R$ 0** (ingresso incluso) | limite por membro (1 incluso?) — §13.8.6 |

- **Lote de membro / acesso antecipado:** modelado como um **batch** com `audience` restrito + `available_from` anterior à abertura pública. Ex.: ticket type "Pista" tem o batch "Lote Sócio Ouro" (`tier_gated`, `available_from = D-7`) e o batch "Geral" (`public`, `available_from = D-0`). O perk `event.access='early'` concede ao membro a visibilidade do lote antecipado.
- **Preço de membro (`member_price`):** desconto aplicado quando o comprador é membro elegível, resolvido no checkout via entitlement do perk `event` (`discount_pct` ou `member_price` fixo).

#### 13.1.5 Fluxo passo a passo — venda nativa de ingresso (membro)

1. Membro abre a página do evento na área de membro. Front chama `GET /v1/events/{id}` → recebe ticket types **filtrados por elegibilidade** (resolvida server-side a partir dos entitlements do membro — não confiar no front).
2. Membro escolhe ticket type + quantidade (respeitando `max_per_member`, §13.8.6). Front chama `POST /v1/events/{id}/tickets/reserve` → cria N tickets `reserved` (hold TTL) **com decremento atômico de vaga** (anti-oversell, §13.8.1).
3. Se o ticket type é pago → o checkout reusa o **domínio payments-billing**: cria `transaction` (`type=ticket`), aplica split 7,99% (§13.2), Pix/cartão à vista (ingresso **não** parcela por padrão — §13.8.7). Membro paga.
4. Webhook do Asaas `payment_confirmed` → payments-billing → evento interno `ticket.paid` → este domínio transita `reserved→valid`, gera o **pass** (chama domínio `passport` → `eventTicket` Apple/Google), escreve `interaction` no CRM (`ticket_purchased`), emite webhook de saída `ticket.issued`.
5. Se **gratuito/incluso** (`R$ 0`): pula o pagamento, vai direto `reserved→valid` + pass.
6. Membro adiciona ao Wallet ("Adicionar ao Wallet" no pass) → no dia, escaneia na portaria → `verification-checkin` faz `valid→used`.

#### 13.1.6 Fluxo passo a passo — venda para não-membro

1. Não-membro acessa a página pública do evento (link compartilhável `eventos.suacomunidade.com/{event_slug}` ou rota hosted).
2. Compra um ticket type `public`. Como não há login obrigatório, o sistema **cria um `member` "lead" sem login** (member-identity §7: e-mail não obrigatório; `source='event'`), gerando Member ID. Captura nome + contato (e-mail/telefone) para o ingresso e o CRM.
3. Checkout normal (payments-billing). Pass emitido vinculado ao member-lead. O ingresso é entregue por **e-mail/WhatsApp** + link "Adicionar ao Wallet" (não exige PWA logado).
4. No check-in, vira interação no CRM do lead → **funil de conversão** "compareceu ao evento → vire membro". Hall of Fame pode contabilizar (se a org optar por incluir leads).

> **Decisão de produto pendente (Q):** não-membro com ingresso conta como `member` (lead) com Member ID desde a compra, ou só vira member ao se cadastrar? Recomendação: **criar member-lead na compra** (alimenta CRM e check-in unificado) — ver Open Questions.

#### 13.1.7 Fluxo passo a passo — Drop / ativação exclusiva

1. Org cria um **drop** (admin): nome, tipo (`physical`/`digital`/`action`), SKU, quantidade limitada (`limited_qty`), preço (0 = brinde, >0 = pago), elegibilidade por tier, janela (`available_from/until`), e (opcional) vínculo a um evento.
2. Drop aparece na **área de membro** só para tiers elegíveis (gating via entitlement do perk `drop`).
3. Membro "resgata"/compra → decremento atômico de `limited_qty` (anti-oversell), cria `drop_claim`. Se pago, passa por payments-billing (`transaction.type=drop`).
4. Fulfillment: `physical` → vira **gift** pendente (integra com Comunicação/§17, endereço de entrega); `digital` → libera asset (signed URL); `action` → executa ação (ex.: reserva de vaga, voto, sorteio).
5. Resgate vira `interaction` no CRM + pode dar conquista no Hall of Fame.

> Drops compartilham o **mesmo motor de capacidade atômica** dos ticket types (§13.8.1) e o **mesmo padrão de gating por entitlement** de content-gating. Não reimplementar.

#### 13.1.8 Fluxo passo a passo — Lista de espera (waitlist)

1. Ticket type/lote esgota (`sold_out` derivado). Front mostra CTA "Entrar na lista de espera".
2. `POST /v1/events/{id}/waitlist` → cria `waitlist_entries` com `position` (sequencial por ticket_type) e canal de notificação.
3. Vaga abre (refund, hold expirado que **devolve ao pool**, ou aumento de capacidade) → job `waitlist-promoter` notifica o **primeiro da fila** com um **link de compra com hold reservado** e janela de conversão (`claim_deadline`, ex.: 30 min).
4. Se não converte na janela → passa para o próximo. Conversão = compra normal.
5. **Anti-abuso:** 1 entrada de waitlist por pessoa por ticket type; link de claim é single-use e expira.

#### 13.1.9 Regras de negócio concretas

- **Capacidade em dois níveis:** `event.capacity` (teto total do venue) **e** `ticket_type.capacity` (cota por categoria) **e** `batch.capacity` (cota por lote). O menor vínculo manda; a soma das cotas de ticket types pode ser ≤ capacidade do evento (sobra = buffer) ou exatamente igual. Oversell é checado **em todos os níveis** atomicamente.
- **Ingresso = pass (sempre).** Todo `ticket valid` tem exatamente um `pass` (`type=ticket`, `platform` apple/google conforme o device do membro; pode haver os dois). Cancelar/transferir/estornar **revoga** o pass (push).
- **Ingresso não parcela** (default): ingresso é compra avulsa de baixo ticket; parcelamento é feature de plano (§13.3). Configurável por org para eventos de alto valor (ver Q). Se habilitado, segue a mesma regra `max(Hotmart, Asaas)` de payments-billing.
- **Comissão 7,99% incide sobre todo ingresso pago** (§13.2) — `transactions.type='ticket'`. Ingresso gratuito/incluso não gera transação.
- **Lote de membro nunca é "público antecipado":** se um não-membro tenta comprar um batch `tier_gated`/`member_only` por adivinhação de URL, o checkout **revalida elegibilidade server-side** e bloqueia (defesa contra burlar acesso antecipado).
- **Downgrade/cancelamento de membership após compra:** o ingresso **já emitido é honrado** (não cancela ticket vendido — §12.2 tiers-perks §1.8); o membro só perde direito a *novos* ingressos de lote de membro.
- **Importado (Sympla/Ingresse):** ticket com `source='sympla'|'ingresse'` é `valid` mas **read-only** quanto a preço/lote (a venda aconteceu lá); pode virar pass e ser check-in-ado aqui (§13.5).
- **Member ID no ingresso de membro** alimenta a portaria (mostra tier do membro no check-in — §14 doc) e o Hall of Fame.

---

### 13.2 Modelo de dados

Reaproveita §25.4 (`events`, `tickets`, `checkins`, `passes`) e expande para ticket types, lotes, drops, waitlist e importação.

#### 13.2.1 Tabelas tocadas (já existentes no doc)

**`events`** (§25.4) — expandir:
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK | RLS |
| `name` | text | |
| `slug` | text | único por org, para URL pública |
| `description` | text | |
| `cover_url` | text | Storage |
| `kind` | enum `in_person`/`online`/`hybrid` | |
| `venue` | jsonb | nome, endereço, lat/lng, ou URL (online) |
| `starts_at` / `ends_at` | timestamptz | janela do evento |
| `timezone` | text | exibição correta para o membro |
| `capacity` | int null | teto total (null = ilimitado/online) |
| `status` | enum `draft`/`published`/`postponed`/`canceled`/`finished`/`archived` | máquina §13.1.2 |
| `visibility` | enum `public`/`members_only`/`unlisted` | quem vê a página |
| `created_at` / `updated_at` | timestamptz | |

**`tickets`** (§25.4 / também tocada em verification-checkin §12.2.1) — expandir/confirmar:
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `event_id` | uuid FK | |
| `ticket_type_id` | uuid FK | (NOVO vínculo) |
| `batch_id` | uuid FK null | lote aplicado |
| `member_id` | text FK null | nulo só p/ pendência de atribuição; lead-member preenche |
| `org_id` | uuid FK | RLS |
| `pass_id` | uuid FK→passes null | preenchido quando `valid` |
| `transaction_id` | uuid FK null | nulo p/ gratuito/incluso/importado |
| `tier_pricing` | jsonb | lote/preço/desconto de membro aplicado (snapshot) |
| `holder_name` | text null | nome impresso (convidado/não-membro) |
| `status` | enum `reserved`/`valid`/`used`/`refunded`/`transferred`/`void` | máquina §13.1.3 |
| `source` | enum `native`/`sympla`/`ingresse`/`manual`/`comp` | origem |
| `external_ref` | text null | id do ingresso na Sympla/Ingresse |
| `transferable` | bool | herda do ticket_type; permite transferência |
| `transferred_to_ticket_id` | uuid null | tombstone de transferência |
| `hold_expires_at` | timestamptz null | TTL do `reserved` |
| `created_at` / `updated_at` | timestamptz | |

**`checkins`** (§25.4) — **não tocada aqui** (é do domínio `verification-checkin`). Apenas lemos para relatórios/Hall of Fame.

**`passes`** (§25.4) — **não tocada aqui** (domínio `passport`). Disparamos emissão/revogação via evento interno.

#### 13.2.2 Tabelas novas

**`ticket_types`** — categorias vendáveis do evento:
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `event_id` | uuid FK | |
| `org_id` | uuid FK | RLS |
| `name` | text | "Pista", "Camarote" |
| `description` | text | |
| `audience` | enum `public`/`member_only`/`tier_gated`/`included` | §13.1.4 |
| `allowed_tiers` | jsonb null | tiers elegíveis (quando `tier_gated`/`included`) |
| `base_price` | numeric | preço-base (lote pode sobrescrever) |
| `member_price` | numeric null | preço de membro (se aplicável) |
| `capacity` | int null | cota da categoria (null = limitada só pelo evento) |
| `taken_count` | int default 0 | emitidos+reservados (contador atômico) |
| `max_per_member` | int default 1 | limite por membro/pessoa (§13.8.6) |
| `position` | int | ordem de exibição |
| `status` | enum `active`/`hidden`/`archived` | |
| `created_at` / `updated_at` | timestamptz | |

**`ticket_batches`** — lotes (faixa temporal+preço+cota) de um ticket type:
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `ticket_type_id` | uuid FK | |
| `event_id` | uuid FK | denormalizado p/ query |
| `org_id` | uuid FK | RLS |
| `name` | text | "1º lote", "Lote Sócio", "Last call" |
| `price` | numeric | preço do lote (sobrescreve base) |
| `capacity` | int null | cota do lote |
| `taken_count` | int default 0 | contador atômico |
| `audience_override` | enum null | restringe lote (ex.: lote só de membro) |
| `allowed_tiers` | jsonb null | restrição de tier do lote |
| `available_from` / `available_until` | timestamptz null | janela do lote (acesso antecipado) |
| `position` | int | ordem de ativação |
| `status` | enum `scheduled`/`active`/`exhausted`/`closed` | derivado de janela+cota, materializado por cron |
| `created_at` | timestamptz | |

**`drops`** — drops/ativações exclusivas:
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK | RLS |
| `event_id` | uuid FK null | opcional (drop pode existir sem evento) |
| `name` / `description` | text | |
| `kind` | enum `physical`/`digital`/`action` | |
| `sku` | text null | |
| `price` | numeric default 0 | 0 = brinde |
| `limited_qty` | int null | null = ilimitado |
| `claimed_count` | int default 0 | contador atômico |
| `allowed_tiers` | jsonb null | gating por tier |
| `max_per_member` | int default 1 | |
| `available_from` / `available_until` | timestamptz null | |
| `fulfillment_config` | jsonb | asset URL (digital), regra (action), gift template (physical) |
| `status` | enum `draft`/`active`/`exhausted`/`closed` | |
| `created_at` | timestamptz | |

**`drop_claims`** — resgates de drop:
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `drop_id` | uuid FK | |
| `member_id` | text FK | |
| `org_id` | uuid FK | RLS |
| `transaction_id` | uuid FK null | se pago |
| `fulfillment_status` | enum `pending`/`fulfilled`/`shipped`/`failed`/`canceled` | |
| `fulfillment_data` | jsonb | endereço (physical), asset liberado (digital) |
| `gift_id` | uuid FK null | vínculo com `gifts` (§17) p/ physical |
| `created_at` | timestamptz | |

**`waitlist_entries`** — lista de espera:
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `event_id` | uuid FK | |
| `ticket_type_id` | uuid FK | |
| `org_id` | uuid FK | RLS |
| `member_id` | text FK null | lead-member ou membro |
| `contact` | jsonb | e-mail/telefone p/ notificação |
| `position` | int | ordem na fila (sequencial por ticket_type) |
| `status` | enum `waiting`/`offered`/`claimed`/`expired`/`canceled` | |
| `offered_at` | timestamptz null | quando recebeu o link de claim |
| `claim_deadline` | timestamptz null | janela de conversão |
| `claim_token` | text null | link single-use de compra |
| `created_at` | timestamptz | |

**`event_imports`** — controle de sincronização Sympla/Ingresse:
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK | |
| `connection_id` | uuid FK→connections | credencial da integração (§20.1) |
| `provider` | enum `sympla`/`ingresse` | |
| `external_event_id` | text | id do evento no provedor |
| `event_id` | uuid FK null | evento Stanbase espelhado |
| `sync_mode` | enum `import_once`/`continuous` | importar uma vez vs. sincronizar |
| `last_synced_at` | timestamptz null | |
| `cursor` | text null | paginação/checkpoint do provedor |
| `status` | enum `pending`/`active`/`error`/`disabled` | |
| `error_detail` | text null | |
| `created_at` | timestamptz | |

#### 13.2.3 Índices & constraints relevantes

- `events(org_id, status, starts_at)` — listar eventos futuros/passados do admin e do membro.
- `events(org_id, slug)` **UNIQUE** — URL pública.
- `ticket_types(event_id, position)` — render ordenado.
- `ticket_batches(ticket_type_id, available_from)` — resolver lote ativo.
- **Anti-oversell (crítico):** o decremento de vaga em `ticket_types.taken_count`/`ticket_batches.taken_count`/`drops.claimed_count` usa o **mesmo padrão atômico de tiers-perks §1.9**: `UPDATE ... SET taken_count = taken_count+1 WHERE taken_count < capacity RETURNING` (ou `SELECT FOR UPDATE`). **Nunca** check-then-insert sem lock. `CHECK (taken_count <= capacity)` como defesa em profundidade.
- `tickets(event_id, status)` — manifesto de check-in (consumido por verification-checkin §12.2.3).
- `tickets(member_id, event_id)` — "meus ingressos" + limite por membro.
- `tickets(member_id, event_id) WHERE status IN ('reserved','valid','used')` — **constraint de limite por membro** combinado com `max_per_member` validado em código (não dá pra expressar `max_per_member` puro em índice; ver §13.8.6).
- `tickets(external_ref, source)` **UNIQUE** (parcial, onde `source != native`) — idempotência da importação Sympla/Ingresse (não duplicar ingresso importado).
- `tickets(hold_expires_at) WHERE status='reserved'` — cron de expiração de hold.
- `waitlist_entries(ticket_type_id, position)` **UNIQUE** + `UNIQUE(ticket_type_id, member_id) WHERE status IN ('waiting','offered')` — 1 entrada por pessoa.
- `drop_claims(drop_id, member_id)` **UNIQUE** (quando `max_per_member=1`) — anti-duplo-resgate.
- `event_imports(connection_id, external_event_id)` **UNIQUE** — não importar o mesmo evento 2×.
- **RLS:** todas com `org_id` sob RLS por `org_id` (§26). Página pública do evento (não-membro) lê via Edge Function com role de serviço montando DTO público (mesmo padrão da rota pública de validação §12.2.3) — nunca expõe a linha crua.

---

### 13.3 API & Edge Functions

#### 13.3.1 Endpoints REST `/v1`

Expande o catálogo de §21.2 (`/v1/events`, `/v1/events/{id}/tickets`, `/v1/tickets/{id}`, `/v1/tickets/{id}/validate`).

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| `GET` | `/v1/events` | JWT/admin ou público (filtra por `visibility`) | Lista eventos da org (admin vê tudo; membro vê elegíveis; público vê `public`). |
| `POST` | `/v1/events` | admin | Cria evento (draft). |
| `GET` | `/v1/events/{id}` | conforme visibility | Detalhe + ticket types **filtrados por elegibilidade** do solicitante. |
| `PATCH` | `/v1/events/{id}` | admin | Edita (validações por status — §13.8.8). |
| `POST` | `/v1/events/{id}/publish` | admin | draft→published. |
| `POST` | `/v1/events/{id}/postpone` | admin | Adia (nova data) → atualiza passes, notifica. |
| `POST` | `/v1/events/{id}/cancel` | admin | Cancela → reembolso em massa + void + revoga passes. |
| `POST` | `/v1/events/{id}/ticket-types` | admin | Cria ticket type. |
| `PATCH` | `/v1/ticket-types/{id}` | admin | Edita (audience, preço, capacidade, max_per_member). |
| `POST` | `/v1/ticket-types/{id}/batches` | admin | Cria lote (preço, cota, janela, restrição). |
| `GET` | `/v1/events/{id}/availability` | público/membro | Vagas restantes por ticket type/lote, lote ativo, `sold_out`. |
| `POST` | `/v1/events/{id}/tickets/reserve` | membro/público | Cria N holds (`reserved`) com decremento atômico; retorna intenção de checkout. |
| `POST` | `/v1/events/{id}/tickets` | membro/público | (compat §21.2) emite/vende ingresso → vira pass (gratuito direto; pago via checkout). |
| `GET` | `/v1/tickets/{id}` | dono do ticket/admin | Detalhe do ingresso (status, QR, evento). |
| `POST` | `/v1/tickets/{id}/transfer` | dono do ticket | Transfere titularidade (gera novo ticket+pass, revoga QR antigo). |
| `POST` | `/v1/tickets/{id}/refund` | admin (ou membro se org permitir) | Estorna ingresso (delega payments-billing) → void + revoga pass. |
| `POST` | `/v1/tickets/{id}/validate` | operator | (§21.2) valida ingresso sem marcar presença — delega a verification-checkin. |
| `GET` | `/v1/events/{id}/waitlist` | admin | Lista a fila. |
| `POST` | `/v1/events/{id}/waitlist` | membro/público | Entra na lista de espera. |
| `POST` | `/v1/drops` | admin | Cria drop. |
| `PATCH` | `/v1/drops/{id}` | admin | Edita drop. |
| `POST` | `/v1/drops/{id}/claim` | membro | Resgata/compra drop (decremento atômico). |
| `POST` | `/v1/integrations/{provider}/events/import` | admin | Importa evento Sympla/Ingresse (provider ∈ sympla,ingresse). |
| `POST` | `/v1/integrations/{provider}/events/{id}/sync` | admin | Força sync (ingressos/check-ins do provedor). |

#### 13.3.2 Edge Functions / Jobs

| Function/Job | Tipo | Descrição |
|---|---|---|
| `event-ticket-reserve` | Edge | Cria holds com decremento atômico multi-nível (event+type+batch), TTL, idempotência por `Idempotency-Key`. |
| `event-ticket-issue` | Edge | `reserved→valid` ao confirmar pagamento (consome evento interno `ticket.paid` de payments-billing); dispara emissão de pass (passport), interaction CRM, webhook `ticket.issued`. |
| `event-hold-reaper` | Cron (pg_cron) | Expira holds `reserved` vencidos (`hold_expires_at < now`), devolve vaga, dispara `waitlist-promoter`. |
| `event-lifecycle` | Cron | Materializa `live`/`finished` por `starts_at`/`ends_at`; ativa/encerra lotes por janela (`scheduled→active→exhausted/closed`). |
| `event-cancel` | Edge | Cancelamento em massa: void de tickets, refund batch (payments-billing), revoga passes, notifica, webhook `event.canceled`. |
| `ticket-transfer` | Edge | Transfere titularidade: cria novo ticket+pass p/ destinatário, revoga QR antigo, marca origem `transferred`, audita. |
| `waitlist-promoter` | Job (pgmq) | Quando abre vaga, oferta ao 1º da fila (link single-use + deadline), agenda expiração e passa adiante. |
| `drop-claim` | Edge | Resgate atômico de drop; roteia fulfillment (gift/asset/action). |
| `event-import-sympla` / `event-import-ingresse` | Edge + Cron | Importa/sincroniza eventos, ingressos e check-ins do provedor; upsert idempotente por `external_ref`; gera passes para ingressos importados se a org optar. |
| `event-checkin-aggregator` | Job | Lê `checkins` (de verification-checkin) → atualiza engajamento no CRM e dispara avaliação de conquistas (Hall of Fame). |

> **Dogfooding (§10.3):** o admin cria eventos pela **mesma** `/v1/events` que um parceiro headless usaria. A venda nativa reusa o checkout de payments-billing — sem caminho financeiro paralelo.

---

### 13.4 Telas/Front

#### 13.4.1 Admin — módulo "Eventos & Ingressos" (§10.1 #5)

- **Lista de eventos:** cards/tabela com status (draft/published/postponed/canceled/finished), data, % vendido, receita, taxa de check-in. Filtros (futuros/passados), busca, ações (publicar, duplicar, adiar, cancelar).
- **Editor de evento:** nome, descrição, capa (upload Storage), tipo (presencial/online/híbrido), local (mapa/endereço ou URL), data/hora + timezone, capacidade total, visibilidade.
- **Editor de ticket types + lotes:** lista de tipos (Pista/Camarote…), cada um com preço, capacidade, `max_per_member`, `audience` (público/só-membro/por-tier/incluso) e seletor de tiers elegíveis; dentro de cada tipo, **lotes** (nome, preço, cota, janela `from/until`, restrição de membro). Preview de "lote ativo agora". Aviso de soma de cotas vs. capacidade do evento.
- **Painel de vendas do evento (Realtime):** vendidos por tipo/lote, vagas restantes, receita, lista de compradores, taxa de check-in ao vivo (puxa contadores de verification-checkin).
- **Lista de espera:** fila por ticket type, ações (ofertar manualmente, remover), status de conversão.
- **Drops & ativações:** CRUD de drops, ocupação (`claimed/limited_qty`), fulfillment pendente (físico → fila de gifts).
- **Importação Sympla/Ingresse:** conectar conta, escolher evento externo, modo (importar uma vez / sincronizar contínuo), status de sync, conflitos.
- **Cancelar/adiar:** modal com política de reembolso (total/parcial/nenhum), preview do impacto (N ingressos, R$ a estornar), confirmação.

#### 13.4.2 Membro — Eventos & ingressos (§24.2)

- **Lista de eventos** (futuros) com badge "acesso antecipado disponível" para o tier do membro.
- **Página do evento:** descrição, local/mapa, data, ticket types **elegíveis** (com preço de membro/lote de membro destacado), CTA comprar / lista de espera (se esgotado).
- **Checkout de ingresso:** quantidade, resumo, pagamento (Pix/cartão à vista; reusa componentes de payments-billing), "Adicionar ao Wallet" após emissão.
- **Meus ingressos:** lista de tickets (valid/used), QR/pass, ações **transferir** (se `transferable`) e **pedir reembolso** (se org permitir).
- **Drops na área de membro:** vitrine de drops elegíveis, resgate/compra, status de fulfillment (ex.: "brinde a caminho").
- **Notificações:** evento adiado/cancelado, sua vez na lista de espera (link com countdown), ingresso utilizado (check-in).

#### 13.4.3 Página pública do evento (não-membro)

- Página temável (marca da org) acessível sem login: evento + compra de ticket types `public`. Captura nome/contato, entrega ingresso por e-mail/WhatsApp + "Adicionar ao Wallet". CTA "vire membro" pós-compra.

#### 13.4.4 Componentes/SDK

- `<EventCard/>`, `<TicketCheckout/>`, `<EventTicketPass/>` (reusa `<AddToWallet/>` de §24.3), `<WaitlistButton/>`, `<DropCard/>` — embutíveis no modo híbrido.

---

### 13.5 Integrações externas

| Serviço | Como integra |
|---|---|
| **Sympla** (API) | Importa eventos + ingressos vendidos lá (via `connections`/OAuth-token, §20.1). `sync_mode=continuous` puxa novos ingressos e **check-ins** periodicamente (cron) + webhook de entrada se disponível. Ingresso importado vira `ticket source=sympla`, read-only de preço, opcionalmente gera **pass** Stanbase para o membro escanear na nossa portaria. Mapeia comprador → member (por e-mail) ou cria lead. |
| **Ingresse** (API) | Idem Sympla (catálogo §20). Idempotência por `external_ref`; reconciliação por job. |
| **Asaas (payments-billing)** | Toda venda nativa paga passa pelo split 7,99% (`transaction.type=ticket`/`drop`). Reembolso de ingresso reverte split (§10.1.10). Este domínio **não chama o Asaas direto** — delega a payments-billing. |
| **Apple Wallet / Google Wallet (passport)** | Ingresso `valid` → `eventTicket` pass. Cancelamento/transferência/estorno → revoga/atualiza pass via push. Emissão é do domínio passport; aqui disparamos evento interno. |
| **verification-checkin** | Consome `tickets`/manifesto, faz `valid→used`, anti-reuso, offline, token do QR. Fronteira clara (§13 cabeçalho). |
| **Comunicação (§17)** | Notificações de evento (adiado/cancelado, vez na waitlist, ingresso emitido), e-mail/WhatsApp do ingresso para não-membro, fulfillment físico de drop → `gifts`. |
| **CRM (§11)** | Compra, check-in e resgate de drop viram `interactions` na timeline + engajamento + funil de conversão (lead de evento). |
| **Hall of Fame (§18)** | Presença (check-in) alimenta conquistas ("10 eventos", "presença perfeita") e rankings por presença. |
| **Storage** | Capas de evento, assets digitais de drop. |
| **Supabase Realtime** | Contadores de venda/vagas ao vivo no admin; "esgotou enquanto você comprava". |

---

### 13.6 Épicos & tarefas

#### Épico A — CRUD de eventos & ciclo de vida
- A1. Migration `events` estendida (slug, kind, venue jsonb, timezone, capacity, visibility, status) + constraints/índices. **(M)**
- A2. RPC/Edge CRUD `/v1/events` + RLS por org + validações por status. **(M)**
- A3. Transições publish/postpone/finish + cron `event-lifecycle` (live/finished, ativação de lotes). **(M)**
- A4. Página pública do evento (DTO por visibility, role de serviço, anti-leak). **(M)**
- **Esforço épico: M**

#### Épico B — Ticket types, lotes & elegibilidade
- B1. Migrations `ticket_types` + `ticket_batches` + índices + `CHECK` de capacidade. **(M)**
- B2. CRUD ticket types/lotes no admin + validação soma-de-cotas vs. capacidade. **(M)**
- B3. Resolução de **lote ativo** (janela + cota) e **elegibilidade** server-side (audience/allowed_tiers via entitlements). **(M)** *(depende de tiers-perks)*
- B4. `GET /v1/events/{id}/availability` (vagas por nível, sold_out derivado, Realtime). **(M)**
- **Esforço épico: M**

#### Épico C — Venda nativa & holds (anti-oversell)
- C1. `event-ticket-reserve`: decremento atômico multi-nível (event+type+batch) + hold TTL + idempotência. **(L)** *(crítico — race condition)*
- C2. Integração com checkout payments-billing (`transaction.type=ticket`, split 7,99%, Pix/à vista). **(L)** *(depende de payments-billing)*
- C3. `event-ticket-issue`: `reserved→valid` no `payment_confirmed` + emissão de pass (passport) + interaction CRM + webhook `ticket.issued`. **(M)** *(depende de passport, crm, webhooks)*
- C4. `event-hold-reaper` (cron) expira holds, devolve vaga, aciona waitlist. **(S)**
- C5. Fluxo gratuito/incluso (pula pagamento) + limite de incluso por membro. **(M)**
- **Esforço épico: L**

#### Épico D — Não-membro / lead de evento
- D1. Criação de **member-lead** sem login na compra pública (member-identity `source=event`). **(M)** *(depende de member-identity)*
- D2. Entrega de ingresso por e-mail/WhatsApp + link Wallet sem PWA logado. **(M)** *(depende de communication, passport)*
- D3. Funil de conversão "lead → membro" (interaction + CTA pós-evento). **(S)** *(depende de crm)*
- **Esforço épico: M**

#### Épico E — Transferência & reembolso de ingresso
- E1. `ticket-transfer`: novo ticket+pass p/ destinatário, revoga QR antigo, tombstone, audit. **(L)**
- E2. `POST /v1/tickets/{id}/refund` delegando payments-billing (reverte split) + void + revoga pass. **(M)** *(depende de payments-billing, passport)*
- E3. Política de reembolso por org/evento (quem pode pedir, janela, parcial). **(M)**
- **Esforço épico: L**

#### Épico F — Evento cancelado/adiado (em massa)
- F1. `event-cancel`: void em massa + refund batch + revoga passes + notifica + webhook. **(L)** *(depende de payments-billing, passport, communication)*
- F2. `postpone`: mantém tickets, atualiza passes (nova data), notifica, opção de reembolso para quem não puder. **(M)**
- **Esforço épico: L**

#### Épico G — Lista de espera
- G1. Migration `waitlist_entries` + posição sequencial + UNIQUE anti-duplicata. **(S)**
- G2. `POST /waitlist` + `waitlist-promoter` (oferta single-use + deadline + passa adiante). **(L)**
- G3. UI membro (entrar/ver vez) + admin (gerir fila). **(M)**
- **Esforço épico: M**

#### Épico H — Drops & ativações
- H1. Migrations `drops` + `drop_claims` + decremento atômico de `limited_qty`. **(M)**
- H2. `drop-claim` + roteamento de fulfillment (gift físico, asset digital, action). **(L)** *(depende de communication p/ gift, content-gating p/ asset)*
- H3. Admin (CRUD drops, ocupação, fulfillment) + vitrine na área de membro (gating por tier). **(M)** *(depende de tiers-perks)*
- **Esforço épico: M**

#### Épico I — Integração Sympla/Ingresse
- I1. Connectors `event-import-sympla`/`event-import-ingresse` (OAuth/token, listar eventos, upsert idempotente por `external_ref`). **(L)** *(depende de integrations-framework)*
- I2. Sync contínuo (cron + cursor) de ingressos e **check-ins** do provedor → tickets/checkins espelhados. **(L)**
- I3. Geração opcional de pass Stanbase p/ ingresso importado + mapeamento comprador→member/lead. **(M)** *(depende de passport, member-identity)*
- I4. Reconciliação/conflitos (ingresso cancelado lá, duplicata, comprador sem e-mail). **(M)**
- **Esforço épico: L**

#### Épico J — Relatórios, CRM & Hall of Fame
- J1. `event-checkin-aggregator`: presença → engajamento CRM + dispara conquistas. **(M)** *(depende de crm, hall-of-fame)*
- J2. Painel de vendas/check-in do evento (Realtime) no admin. **(M)** *(depende de observability)*
- J3. Webhooks de saída `event.published/canceled/postponed`, `ticket.issued/refunded/transferred`, `drop.claimed`. **(S)** *(depende de webhooks)*
- **Esforço épico: M**

---

### 13.7 Dependências

| Depende de | Por quê |
|---|---|
| **fundacao** | Edge Functions, RLS multi-tenant, pg_cron/pgmq (holds, lifecycle, waitlist, sync), Storage (capas/assets), Realtime (contadores). |
| **member-identity** | Todo ingresso de membro ancora no `member_id`; venda a não-membro cria **member-lead** (`source=event`); transferência/merge reapontam tickets. |
| **tiers-perks** | Perk `event` (lote de membro, acesso antecipado, preço/incluso) e perk `drop` definem elegibilidade que o checkout lê; entitlements resolvem audience/allowed_tiers. |
| **payments-billing** | Venda paga reusa checkout + split 7,99% (`transaction.type=ticket`/`drop`), reembolso reverte split, cancelamento de evento faz refund em massa. Ingresso **não** reimplementa pagamento. |
| **passport** | Ingresso `valid` vira `eventTicket` (Apple+Google); cancel/transfer/refund revoga/atualiza pass via push. |
| **verification-checkin** | Faz `valid→used` (check-in, anti-reuso, offline, token QR). Fronteira de responsabilidade definida no cabeçalho. |
| **crm** | Compra/check-in/resgate viram `interactions` + engajamento + funil de conversão de lead. |
| **hall-of-fame** | Presença alimenta conquistas e rankings por presença. |
| **communication** | Notificações de evento, entrega de ingresso a não-membro, fulfillment de drop físico (gifts), notificação de waitlist. |
| **content-gating** | Asset digital de drop (signed URL) reusa o gating de conteúdo. |
| **integrations-framework** | Sympla/Ingresse como `connections` (OAuth/token cifrado, sync, reconciliação). |
| **webhooks** | Eventos de saída (`event.*`, `ticket.*`, `drop.claimed`). |
| **public-api / mcp** | Expor eventos/ingressos como recursos `/v1` e tools MCP (criar evento, vender ingresso, listar presentes). |
| **design-system / admin-app / member-app** | Telas e componentes (`<TicketCheckout/>`, `<EventCard/>`, etc.). |
| **observability-qa** | Métricas de venda/check-in, testes de concorrência (oversell), testes de RLS. |
| **security-lgpd** | Página pública sem PII excessiva, consentimento de e-mail/WhatsApp do ingresso, anonimização que limpa tickets/leads. |

---

### 13.8 Riscos, decisões técnicas & edge cases

#### 13.8.1 Oversell / capacidade (edge case central)
- **Problema:** sob concorrência (drop de ingressos disputado), dois checkouts pegam a última vaga em qualquer um dos três níveis (event/type/batch).
- **Solução:** decremento **atômico** com `UPDATE ... SET taken_count = taken_count+qty WHERE taken_count + qty <= capacity RETURNING` (ou `SELECT FOR UPDATE`), **em cada nível**, dentro da **mesma transação** — se um nível falha, faz rollback de todos. **Nunca** check-then-insert. `CHECK (taken_count <= capacity)` como rede.
- **Holds:** vaga é reservada já no `reserved` (não só no pagamento) para não vender 2× durante o checkout. Hold com TTL devolve a vaga se o pagamento não confirma. Cuidado para o hold contar como ocupação na disponibilidade exibida.
- **Devolução de vaga:** hold expirado/refund/cancelamento devolve a vaga ao pool **e** dispara a waitlist. (Diferente do lote fundador de tier, que pode não devolver — aqui o default é devolver, pois evento é por ocupação física.)
- **Teste obrigatório:** carga concorrente disputando a última vaga (igual ao teste de tiers-perks §10.7).

#### 13.8.2 Ingresso para não-membro
- Não-membro compra ticket `public`. **Decisão (recomendada):** cria `member` "lead" sem login (`source=event`, e-mail não obrigatório — member-identity §7) na compra → ingresso, CRM e check-in ficam unificados. Alternativa: ticket "anônimo" sem member (mais simples, mas quebra CRM/Hall of Fame/check-in nominal). Ver Q.
- Edge: mesmo e-mail compra de novo → **dedup** com lead existente (não criar 2 leads). Lead que depois vira membro → **merge** (member-identity §150) reaponta os tickets.
- Entrega sem PWA: ingresso por e-mail/WhatsApp + link Wallet público (não exige login).

#### 13.8.3 Reembolso de ingresso
- **Quem pode pedir:** configurável (org sempre; membro só se a org liga "auto-reembolso" + dentro de janela, ex.: até D-2). Default: só admin.
- **Mecânica:** delega `payments-billing` (`/v1/transactions/{id}/refund`, §10.1.10) → reverte split (Stanbase devolve comissão, Asaas estorna), debita `net_org` da org. Ticket → `refunded`, pass revogado (push).
- **Ingresso já usado (`used`):** reembolso de ingresso já com check-in é **bloqueado por default** (já consumiu o acesso) — só com override admin auditado.
- **Parcial:** raro em ingresso (1 unidade); para compra de N ingressos, estorna por unidade.
- **Reembolso após evento cancelado:** automático e em massa (§13.8.4), não exige pedido.

#### 13.8.4 Evento cancelado / adiado
- **Cancelado:** `event-cancel` → void de todos os tickets `valid`/`reserved`, **refund batch** automático dos pagos (payments-billing), revoga todos os passes (push "evento cancelado"), notifica (communication), webhook `event.canceled`. Idempotente (re-execução não estorna 2×). Falha parcial de refund → fila de retry + relatório ao admin.
- **Adiado (`postponed`):** tickets **permanecem válidos** (não estorna). Atualiza passes com a nova data (push). Notifica. **Opção de reembolso** para quem não pode na nova data, dentro de uma janela (config). Edge: adiamento múltiplo; data nova no passado (validar).
- **Risco:** cancelar evento com ingressos importados da Sympla — não controlamos o reembolso lá; só fazemos void do pass Stanbase e avisamos que o estorno é no provedor de origem.

#### 13.8.5 Transferência de ingresso
- **Transferível** herda de `ticket_type.transferable`. Transferência: cria **novo ticket+pass** para o destinatário (member ou lead), **revoga o QR antigo** (anti-reuso — senão origem e destino entram), marca origem `transferred` (tombstone), audita.
- **Destinatário não-membro:** vira lead-member (mesmo fluxo de §13.8.2).
- **Ingresso `member_only`/`tier_gated`:** transferir para não-membro/tier inelegível? **Decisão:** bloquear transferência de ingresso restrito para inelegível (senão fura o lote de membro) — ou permitir como "convidado" sem o benefício. Ver Q.
- **Limite anti-revenda:** N transferências por ticket (default 1) para coibir cambismo.

#### 13.8.6 Múltiplos ingressos por membro
- `ticket_type.max_per_member` (default 1) limita quantos um membro/pessoa compra. Validado **em código** dentro da transação de reserva (índice puro não expressa o limite). Holds contam para o limite (senão dá pra furar abrindo N checkouts).
- **Ingresso incluso** (`included`): tipicamente **1 por membro** (o benefício do tier). Comprar adicionais paga o preço normal (outro ticket type/lote).
- **Comprar para terceiros:** um membro compra N ingressos `public` e os transfere/atribui `holder_name` — permitido se `max_per_member` permitir; cada ingresso vira pass nominal.

#### 13.8.7 Parcelamento de ingresso
- **Default: ingresso NÃO parcela** (compra avulsa de baixo ticket, Pix/à vista). Parcelamento é feature de **plano** (§13.3). Decisão de produto: habilitar parcelamento de ingresso de **alto valor** por org? Se sim, segue a mesma regra `max(Hotmart, Asaas)` (3,49% a.m.) de payments-billing. Ver Q.

#### 13.8.8 Edição de evento com vendas em andamento
- **Não pode** reduzir `capacity` abaixo do já vendido (validar). Mudar preço de lote ativo **não** afeta tickets já emitidos (preço é snapshot em `tier_pricing`). Mudar data = `postpone` (fluxo dedicado, não edição silenciosa). Mudar `audience` de público→restrito não revoga tickets já vendidos.

#### 13.8.9 Sympla/Ingresse — sincronização
- **Idempotência:** `UNIQUE(external_ref, source)` — re-sync não duplica ingresso. Cursor/checkpoint por `event_imports`.
- **Mapeamento comprador→member:** por e-mail; sem e-mail ou e-mail novo → cria lead. Risco de duplicar pessoa que é membro com outro e-mail (mitiga com dedup/merge).
- **Check-in dos dois lados:** se o evento tem check-in na Sympla **e** na Stanbase, há risco de dupla porta. Decisão: definir **fonte de verdade do check-in por evento** (Stanbase ou provedor) — não misturar. Importado read-only de preço/lote.
- **Reembolso lá:** cancelamento na Sympla deve refletir como void do pass aqui (via sync), mas o dinheiro é deles.

#### 13.8.10 Outros riscos
- **Página pública do evento é hot path** (link viral, pico pré-venda) — cache de leitura, rate-limit, DTO enxuto, não acoplar a queries pesadas de CRM (igual rota de validação §12.8.8).
- **Pass por ingresso × volume:** evento grande = milhares de passes emitidos de uma vez → emissão assíncrona (fila pgmq) para não estourar APNs/Google rate limits (coordenar com passport).
- **Relógio/timezone:** `starts_at` em UTC + `timezone` para exibição; janelas de lote e `live`/`finished` calculadas em UTC. Erro clássico de evento "ao vivo" na hora errada.
- **Drop físico sem endereço:** resgate de drop físico exige endereço; se faltar, fulfillment fica `pending` aguardando dado (não falha o resgate).

---

### 13.9 Escopo MVP vs. depois

Pela §29 do doc, eventos aparecem no **dashboard desde cedo** (§10.2: "eventos próximos, ingressos vendidos, taxa de check-in") e a **integração Sympla/Ingresse** está listada na **Fase 2** (semanas 7–10). O **check-in básico** está na Fase 1 (via verification-checkin). Portanto este domínio é **parcialmente MVP**: a espinha (criar evento, vender ingresso nativo que vira pass, check-in) acompanha a Fase 1/2; o resto é incremental.

**MVP (Fase 1–2, fatiado):**
- CRUD de eventos (data, local, capacidade, visibilidade) + ciclo publish/finish.
- Ticket types + **um lote** por tipo (lote de membro / acesso antecipado / preço de membro via perk `event`).
- Venda nativa de ingresso (Pix/à vista, split 7,99%) → **vira passport pass** + check-in (delegado a verification-checkin).
- Ingresso para **não-membro** (member-lead) + entrega por e-mail.
- Anti-oversell (holds atômicos) — **não negociável** mesmo no MVP.
- Evento **cancelado** com refund em massa (risco financeiro/legal alto — entra cedo).
- Presença → CRM (interaction/engajamento).

**Depois (Fase 2+):**
- **Múltiplos lotes** automáticos por ticket type (1º lote → 2º lote → last call).
- **Drops & ativações** completos (físico/digital/action) — depende de fulfillment/gifts maduros.
- **Lista de espera** (waitlist) com promoção automática.
- **Transferência de ingresso** (anti-cambismo, limites).
- **Importação/sync Sympla/Ingresse** (Fase 2 do doc) — connectors + reconciliação.
- **Reembolso self-service** pelo membro (org liga) + parcelamento de ingresso de alto valor.
- **Adiamento** com reembolso opcional + Hall of Fame por presença (conquistas).

---

### 13.10 Perguntas abertas de negócio (para o dono responder antes de desenvolver)

Ver objeto estruturado (`openQuestions`). Resumo das mais críticas: (1) não-membro com ingresso vira member-lead na compra? (2) ingresso parcela? (3) quem pode pedir reembolso e até quando? (4) vaga volta ao pool ao cancelar/expirar hold? (5) política de transferência (anti-cambismo) e transferência de ingresso restrito; (6) fonte de verdade do check-in quando importado da Sympla; (7) drops entram no MVP? (8) ingresso incluso por tier — quantos por membro?
