## 09. Engine de Tiers, Perks & Entitlements

> Domínio que define **o que** o membro compra (Tiers), **quais vantagens** isso destrava (Perks), e **quais direitos ativos** ele tem em cada momento (Entitlements). É o coração da engine de membership: tudo (billing, passport, integrações, conteúdo gated, canais, hall of fame) consome o estado produzido aqui. Referência canônica: STANBASE.md §12 (engine), §13.3 (períodos/parcelamento), §25.1–25.2 (modelo de dados), §4 (glossário: 1 membership por org).

---

### 1. Como funciona

#### 1.1 Conceitos e separação de responsabilidades

Três entidades distintas, propositalmente desacopladas:

- **Tier** — o "produto" vendável: nome, descrição, preço, período (mensal/tri/sem/anual + único/vitalício como casos especiais), capacidade (vagas), ordem, cor/arte, trial, lote, status. É a oferta.
- **Perk** — a "vantagem" reutilizável do catálogo da org (conteúdo, evento, canal/cargo, desconto, brinde/drop, reconhecimento, nicho, custom). Definido **uma vez** e atribuído a **N tiers** via `tier_perks`. O perk descreve o benefício e **como ele se materializa** (config jsonb + tipo).
- **Entitlement** — o **direito ativo concreto** de UM membro a UM perk, num intervalo de tempo. É o **estado derivado** que o resto da plataforma lê para decidir "esse membro pode?". Origem: `tier` (derivado da assinatura ativa) ou `manual` (cortesia/concessão avulsa).

> **Princípio:** Tier e Perk são *configuração* (mutáveis pelo admin, raros). Entitlement é *estado por membro* (alto volume, alta frequência de mudança). Nunca decidir acesso lendo `tier_perks` em tempo real para um membro — sempre ler `entitlements` materializados, pois entitlement carrega exceções (cortesia, grandfathering, expiração programada) que `tier_perks` não conhece.

#### 1.2 Regra estrutural herdada (imutável)

- **1 membership por org** (§4). Logo: um membro tem **no máximo 1 tier ativo por vez** dentro da org. Não existe "carrinho de múltiplos tiers". Mudar de tier = upgrade/downgrade, nunca acumular.
- Member ID é por relação pessoa×org. Tier sempre escopado a `org_id`. RLS por `org_id` em todas as tabelas deste domínio.

#### 1.3 Máquina de estados — Tier

```
draft ──publish──► active ──archive──► archived
  ▲                  │  ▲                   │
  └──unpublish───────┘  └──unarchive(*)─────┘
                       │
                 sold_out (derivado: capacity atingida; NÃO é coluna,
                           é estado computado capacity - taken <= 0)
```

- `draft` — criado, não comprável, não aparece no checkout público. Editável livremente (preço, período, perks).
- `active` — publicado, comprável (se houver vaga e janela de lote válida).
- `archived` — não vendável a novos membros; **membros existentes mantêm o tier** (não some debaixo deles). Não pode ser reativado para venda sem virar `active` de novo; reativar exige revalidar capacidade.
- `sold_out` — **estado derivado**, não persistido: `capacity IS NOT NULL AND taken_count >= capacity`. UI mostra "Esgotado". Continua `active` no banco.

**Regra dura:** nunca deletar tier com membros/assinaturas vinculadas (apenas `archive`). Delete físico só se `draft` e sem nenhuma assinatura histórica.

#### 1.4 Máquina de estados — Entitlement

```
        grant (tier ativa OU manual)
                │
                ▼
   ┌────────► active ──────────────┐
   │            │                   │
   │   suspend (inadimplência/      │ expire (expires_at <= now)
   │   grace expirado)              │ OR revoke (downgrade/cancel/admin)
   │            ▼                   ▼
   │        suspended ──reinstate──► (volta active se motivo cessar)
   │                                 │
   └─────────────────────────────────┘
                                  revoked / expired  (terminal, mas auditável)
```

- `active` — direito vigente; integrações devem refletir (cargo Discord presente, VOD liberada).
- `suspended` — direito **temporariamente** inativo (ex.: pagamento falhou e está em grace, ou admin pausou). Integrações **removem o acesso** mas o registro fica para reinstatement rápido. Diferente de `revoked`.
- `expired` — `expires_at` venceu (cortesia temporária ou janela programada). Terminal.
- `revoked` — removido por downgrade, cancelamento ou ação de admin. Terminal.

> `suspended` vs `revoked`: suspended preserva intenção de retorno (dunning); revoked é decisão definitiva. Ambos removem acesso externo, mas o reconcile trata diferente.

#### 1.5 Fluxo: derivação de entitlements ao assinar/mudar de tier (o "resolver")

Função central **`resolveEntitlements(member_id)`** — idempotente, é a fonte da verdade:

1. Lê a **assinatura ativa** do membro (1 por org) e o `tier_id` resultante.
2. Lê `tier_perks` do tier → conjunto **desejado** de perks de origem `tier`.
3. Lê entitlements **manuais** (cortesias) ativos e não expirados → preserva sempre (independem de tier).
4. Aplica **grandfathering**: se o membro tem flag de tier "congelado" (ver §1.10), usa o snapshot de perks do momento da compra, não o tier atual.
5. **Diff** entre estado desejado e `entitlements` atuais de origem `tier`:
   - perks no desejado e não em entitlements → **criar** (active).
   - perks em entitlements (origem tier) e não no desejado → **revogar** (downgrade/troca de tier).
   - perks em ambos → manter (não tocar — evita churn de integração).
6. Enfileira eventos de sync para cada delta (ver §1.6) — **só para os deltas**, nunca full resync desnecessário.
7. Registra na `interactions` (timeline CRM) e dispara webhook `member.entitlements_changed`.

> **Idempotência crítica:** `resolveEntitlements` pode ser chamada N vezes (retry de webhook Asaas, replay) e deve convergir ao mesmo estado sem efeitos colaterais duplicados. Cada entitlement tem chave natural `(member_id, perk_id, source)` para upsert.

#### 1.6 Sincronização com integrações ao mudar de tier

Entitlement não fala direto com Discord/YouTube; ele **produz intenções de sync** consumidas pelo domínio `integrations-framework`:

- Cada delta de entitlement de tipo sincronizável (canal/cargo, conteúdo, desconto) enfileira uma `entitlement_sync_jobs` (pgmq) com `{member_id, perk_id, action: grant|revoke, provider}`.
- Worker consome, chama o connector (atribui cargo Discord, libera playlist), grava resultado em `entitlement_sync_state` com `status: pending|synced|failed|skipped`.
- **Falha parcial:** se Discord falhar mas YouTube ok, entitlement permanece `active` (o direito existe); só o **sync state daquele provider** fica `failed` e entra em retry/DLQ. O membro **não** perde o direito por falha de integração externa.
- **Ordem importa no upgrade:** primeiro **conceder** novos perks, depois **revogar** os antigos — evita janela onde o membro fica sem cargo durante upgrade. No downgrade, ordem inversa não importa tanto, mas conceder-antes-revogar é a regra geral segura.
- Job de **reconciliação periódica** (cron) compara `entitlements active` vs estado real no provider e corrige drift (ex.: alguém removeu cargo manualmente no Discord).

#### 1.7 Fluxo: upgrade com proração

1. Membro no Tier A (período P, valor pago V_A, ciclo atual com `current_period_end`).
2. Escolhe Tier B (preço V_B > V_A), mesmo período ou diferente.
3. Calcula **crédito não usado** de A: `credito = V_A * (dias_restantes / dias_total_ciclo)` (proração linear pró-rata-die).
4. **Valor a cobrar agora** = `V_B_prorata_ate_fim_do_ciclo - credito` (se positivo) → cobra a diferença imediatamente via Asaas; se negativo (raro em upgrade), vira crédito.
5. **Acesso muda na hora** (não espera fim do ciclo): `resolveEntitlements` roda imediatamente → ganha perks de B, ordem conceder-antes-revogar.
6. Atualiza `subscriptions` (tier_id, valor, mantém `current_period_end` ou recalcula conforme política — ver Open Questions).
7. Passport push (tier mudou) + webhook `member.tier_changed`.

> **Casos de borda de proração:** (a) upgrade de mensal→anual: tratar como **nova compra** do anual com crédito do mensal abatido, pois ciclo muda de duração. (b) Tier parcelado (tri/sem/anual): proração com plano parcelado é não-trivial — ver Open Questions §8 e Riscos §8.

#### 1.8 Fluxo: downgrade e perda de perks

Duas políticas possíveis (decisão de produto — Open Questions):

- **Downgrade imediato:** muda já, com crédito prorata (espelho do upgrade). Perde perks de A não presentes em B **na hora**.
- **Downgrade ao fim do ciclo (recomendado):** membro mantém Tier A (e seus perks) até `current_period_end`; agenda `pending_tier_change` para B; no virar do ciclo, `resolveEntitlements` aplica B. Evita "paguei e perdi acesso" e evita reembolso.

**Perda de perks no downgrade — tratamento por tipo:**
- **Canal/cargo:** revoga (remove role Discord) na efetivação.
- **Conteúdo:** perde acesso a VODs do tier superior. **Edge case:** conteúdo já "em consumo" / drop já entregue — não se "desfaz" um drop físico enviado. Brinde/drop **consumido** é terminal (não revoga); brinde **pendente** é cancelado.
- **Evento/ingresso:** ingresso já emitido com base no perk → **honra-se o ingresso já emitido** (não cancela ticket vendido); só não dá direito a novos.
- **Reconhecimento/badge:** badges conquistados são **permanentes** por padrão (hall of fame); badge "ativo enquanto for tier X" é revogável (config do perk).
- **Desconto:** some imediatamente para novas compras; compras já feitas não revertem.

#### 1.9 Fluxo: capacidade / vagas limitadas (lote fundador)

- Tier com `capacity = N`. `taken_count` = assinaturas ativas + reservas em checkout (hold).
- **Reserva no checkout:** ao iniciar checkout, cria **hold** com TTL (ex.: 15 min) que conta contra a capacidade → evita overselling sob concorrência. Hold expira → libera vaga.
- **Concorrência:** decremento de vaga sob `SELECT ... FOR UPDATE` ou constraint/contador atômico (`UPDATE tiers SET ... WHERE taken_count < capacity RETURNING`) — **nunca** checar-depois-inserir sem lock (race condition clássica de oversell).
- **Esgotado:** `taken_count >= capacity` → estado `sold_out` derivado; checkout bloqueia novos; UI mostra "Esgotado" + opção waitlist (pós-MVP).
- **Liberação de vaga:** cancelamento/expiração devolve vaga? **Decisão de produto** — lote fundador geralmente é "100 vagas vitalícias, não volta ao pool". Ver Open Questions.
- **Lote fundador:** combinação de `capacity` (limite) + janela temporal opcional (`available_from`/`available_until`) + preço especial. Modelado como atributos do tier (ou sub-entidade `tier_batches` se múltiplos lotes — ver §2).

#### 1.10 Grandfathering de preço

- Org reajusta preço do Tier de R$50 → R$70. Membros já assinantes **continuam pagando R$50** (preço congelado) até cancelarem.
- Implementação: a **`subscriptions` guarda o `price` efetivo** no momento da assinatura (snapshot), **não** referencia `tiers.price` em tempo de cobrança. Renovação recorrente usa o preço da subscription, não o do tier.
- Flag `subscriptions.price_grandfathered = true` + `subscriptions.tier_snapshot` (jsonb opcional) para auditoria/UI ("você tem preço de fundador").
- **Política configurável:** ao mudar preço, admin escolhe "aplicar só a novos" (default, grandfather) ou "aplicar a todos no próximo ciclo" (raro, comunicar). Ver Open Questions.
- Grandfathering de **perks** (não só preço): se org remove um perk do tier, membros antigos perdem ou mantêm? Ver §1.5 passo 4 e Open Questions.

#### 1.11 Trials, cupons, preço promocional

- **Trial:** tier com `trial_days > 0`. Ao assinar, entitlements são concedidos imediatamente (acesso durante trial) e a 1ª cobrança é agendada para `now + trial_days`. Se trial expira sem pagamento → subscription `past_due`/`canceled` → `resolveEntitlements` revoga. Regra anti-abuso: 1 trial por membro por tier (ou por org — Open Questions).
- **Cupom:** entidade `coupons` (desconto %/fixo, validade, max usos, restrição por tier/período). Aplicado no checkout → afeta `transactions` e o `price` snapshot da subscription. **Cupom não muda o perk-set**, só o preço. Cupom recorrente (vale para sempre) vs one-time (só 1ª cobrança) — Open Questions.
- **Preço promocional:** janela temporal de preço reduzido no tier; tecnicamente igual a cupom automático/lote. Pode ser modelado como `tier_batches` ou campos `promo_price` + `promo_until`.

#### 1.12 Perk com regra própria (custom) e perks de nicho

- `perks.type = 'custom'` com `config` jsonb contendo a **regra** (ex.: "validar conta Steam com X horas", "reconhecer modelo de carro Y"). A regra pode exigir uma **avaliação** (verification) que não é só "tem o tier".
- Entitlement de perk custom pode nascer `pending` até a regra ser satisfeita (ex.: membro precisa conectar conta de jogo). Estado extra: `pending_requirement`.
- Perks de nicho (Steam/Riot/validação de sócio) dependem do domínio `integrations-framework` + `verification-checkin` para resolver a condição.

#### 1.13 Concessão manual / cortesia temporária

- Admin concede perk avulso a um membro (ex.: dar VOD premium a um membro free por 7 dias).
- Cria entitlement `source = manual`, `expires_at` opcional, `granted_by` (audit).
- **Independente de tier:** não some em mudança de tier (passo 3 do resolver). Job de expiração (`pg_cron`) varre `expires_at <= now` e revoga + sync.
- Cortesia pode ser de perk **não pertencente a nenhum tier** (perk avulso do catálogo) — válido.

---

### 2. Modelo de dados

Todas as tabelas carregam `org_id` (exceto `platform_billing_settings` que é global) e RLS por `org_id`.

#### 2.1 Tabelas tocadas/estendidas

**`tiers`** (estende §25.1)
| Coluna | Tipo | Nota |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK | RLS |
| `name`, `description` | text | |
| `price` | numeric(12,2) | preço base do período |
| `currency` | text default 'BRL' | |
| `period` | enum `tier_period` | `monthly\|quarterly\|semiannual\|annual\|one_time\|lifetime` |
| `installments_enabled` | bool | **forçado false se period=monthly** (constraint) |
| `position` | int | ordem drag-drop, único por org (ver índice) |
| `color` | text | hex |
| `art_url` | text | arte do member card |
| `capacity` | int null | null = ilimitado |
| `taken_count` | int default 0 | contador materializado (vagas ocupadas + holds) |
| `trial_days` | int default 0 | |
| `available_from` / `available_until` | timestamptz null | janela de venda (lote) |
| `status` | enum `tier_status` | `draft\|active\|archived` |
| `created_at`/`updated_at` | timestamptz | |

Constraints:
- `CHECK (period <> 'monthly' OR installments_enabled = false)`
- `CHECK (capacity IS NULL OR capacity > 0)`
- `CHECK (trial_days >= 0)`
- `UNIQUE (org_id, position) DEFERRABLE INITIALLY DEFERRED` (reordenação em lote sem violar no meio do swap)
- Índice `idx_tiers_org_status` em `(org_id, status)`.

**`tier_batches`** (nova — opcional para múltiplos lotes; MVP pode embutir em `tiers`)
| `id`, `tier_id` FK, `name` (ex.: "Fundador"), `price`, `capacity`, `taken_count`, `available_from`, `available_until`, `position`, `status` |
- Permite "Tier Sócio: lote fundador 100 vagas R$X → lote regular R$Y". MVP: 1 lote = o próprio tier; lotes múltiplos pós-MVP.

**`perks`** (estende §25.1)
| Coluna | Tipo | Nota |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK | |
| `type` | enum `perk_type` | `content\|event\|channel\|discount\|drop\|recognition\|niche\|custom` |
| `name`, `description` | text | |
| `config` | jsonb | específico do tipo (ver §2.3) |
| `is_syncable` | bool | true para channel/content/discount (gera sync job) |
| `is_revocable` | bool | false para drop consumido/badge permanente |
| `status` | enum | `active\|archived` |

**`tier_perks`** (estende §25.1) — `tier_id` FK, `perk_id` FK, PK composta `(tier_id, perk_id)`, `created_at`. Índices em ambos os FKs.

**`entitlements`** (estende §25.2)
| Coluna | Tipo | Nota |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid | denormalizado p/ RLS |
| `member_id` | uuid FK | |
| `perk_id` | uuid FK | |
| `source` | enum `ent_source` | `tier\|manual` |
| `source_ref` | uuid null | tier_id ou null (cortesia); audita origem |
| `status` | enum `ent_status` | `active\|suspended\|expired\|revoked\|pending_requirement` |
| `granted_by` | uuid null | user (cortesia) ou null (derivado) |
| `granted_at` | timestamptz | |
| `expires_at` | timestamptz null | concessão temporária/janela |
| `revoked_at` | timestamptz null | |
| `tier_snapshot` | jsonb null | grandfathering de perk-set |

Constraints/índices:
- `UNIQUE (member_id, perk_id, source)` — chave natural p/ upsert idempotente do resolver.
- Índice parcial `idx_ent_active` em `(member_id) WHERE status = 'active'` — leitura quente de "perks ativos do membro".
- Índice `idx_ent_expiring` em `(expires_at) WHERE status='active' AND expires_at IS NOT NULL` — job de expiração.

**`entitlement_sync_state`** (nova)
| `id`, `entitlement_id` FK, `provider` (discord/youtube/...), `external_ref`, `status` (`pending\|synced\|failed\|skipped`), `last_attempt_at`, `attempts`, `error` | — 1 linha por (entitlement × provider). Índice em `(status, provider)` p/ worker.

**`tier_holds`** (nova — reserva de vaga no checkout)
| `id`, `tier_id`, `batch_id` null, `member_id` null, `session_ref`, `expires_at`, `status` (`held\|consumed\|released`) | — TTL job libera holds vencidos. Conta contra `taken_count`.

**`coupons`** (nova) e **`coupon_redemptions`**
| `coupons`: `id`, `org_id`, `code` (unique por org), `type` (`percent\|fixed`), `value`, `applies_to` (jsonb: tiers/periods), `recurrence` (`one_time\|recurring`), `max_uses`, `used_count`, `valid_from`, `valid_until`, `status` |
| `coupon_redemptions`: `id`, `coupon_id`, `member_id`, `subscription_id`, `redeemed_at` | — UNIQUE `(coupon_id, member_id)` se 1 uso/membro.

#### 2.2 Tabelas de outros domínios tocadas

- **`subscriptions`** (billing, §25.3): adicionar `price` (snapshot grandfathered), `price_grandfathered` bool, `tier_snapshot` jsonb, `pending_tier_change` (jsonb: `{tier_id, effective_at}`), `trial_ends_at`. Necessário aqui porque tier/grandfathering/downgrade-ao-fim-do-ciclo vivem na subscription.
- **`interactions`** (CRM, §25.2): escreve eventos `tier_changed`, `entitlement_granted`, `coupon_redeemed`.

#### 2.3 Forma do `perks.config` por tipo (jsonb)

- `content`: `{ content_item_ids:[], min_tier_implicit:true }`
- `event`: `{ event_id, access:'early|included|member_price', discount_pct }`
- `channel`: `{ provider:'discord', role_id } / { provider:'telegram', group_id }`
- `discount`: `{ scope:'store|partner', percent, code }`
- `drop`: `{ sku, fulfillment:'physical|digital', limited_qty }`
- `recognition`: `{ badge_id, permanent:bool, hall_position }`
- `niche`: `{ requirement:'steam_connected|car_model_verified', params }`
- `custom`: `{ rule_engine:'...', requires_verification:bool, ... }`

---

### 3. API & Edge Functions

#### 3.1 Endpoints `/v1` (REST pública — admin/headless)

**Tiers**
```
GET    /v1/tiers                         # listar (filtros: status, period)
POST   /v1/tiers                         # criar (draft)
GET    /v1/tiers/{id}
PATCH  /v1/tiers/{id}                    # editar (preço, período, capacidade, cor)
POST   /v1/tiers/{id}/publish            # draft -> active
POST   /v1/tiers/{id}/archive            # active -> archived
POST   /v1/tiers/reorder                 # body: [{id, position}] reordenação em lote
GET    /v1/tiers/{id}/availability       # vagas restantes, sold_out, janela de lote
POST   /v1/tiers/{id}/batches            # (pós-MVP) criar lote
```

**Perks & tier_perks**
```
GET    /v1/perks
POST   /v1/perks                         # criar perk no catálogo
PATCH  /v1/perks/{id}
DELETE /v1/perks/{id}                    # bloqueia se vinculado a tier ativo (409)
POST   /v1/tiers/{id}/perks/{perkId}     # vincular perk ao tier (-> dispara resolve em massa async?)
DELETE /v1/tiers/{id}/perks/{perkId}     # desvincular (grandfathering check)
```

**Entitlements**
```
GET    /v1/members/{memberId}/entitlements          # estado ativo
POST   /v1/members/{memberId}/entitlements          # concessão manual/cortesia (source=manual, expires_at?)
DELETE /v1/members/{memberId}/entitlements/{id}     # revogar cortesia
POST   /v1/members/{memberId}/entitlements/resolve  # forçar re-resolve (idempotente, admin/debug)
```

**Cupons**
```
GET    /v1/coupons
POST   /v1/coupons
POST   /v1/coupons/{code}/validate       # checkout valida elegibilidade (tier/período/usos)
```

> Mudança de tier em si (`change-tier`, proração) vive em **Assinaturas** (§13/billing): `POST /v1/subscriptions/{id}/change-tier` — mas **consome** o resolver deste domínio.

#### 3.2 Edge Functions / Jobs internos

| Função | Tipo | Descrição |
|---|---|---|
| `resolve-entitlements` | função | Núcleo idempotente: deriva entitlements de subscription ativa + manuais + grandfathering; enfileira deltas de sync. Chamada por webhook Asaas, change-tier, cron. |
| `entitlement-sync-worker` | consumer pgmq | Consome `entitlement_sync_jobs`, chama connectors (Discord/YouTube/...), grava `entitlement_sync_state`, retry/DLQ. |
| `entitlement-expiry-cron` | pg_cron | Varre `expires_at <= now AND status=active` → expira + enfileira revoke sync. |
| `tier-hold-reaper` | pg_cron | Libera `tier_holds` vencidos, devolve `taken_count`. |
| `entitlement-reconcile-cron` | pg_cron | Compara entitlements active vs estado real nos providers; corrige drift. |
| `apply-pending-tier-change` | pg_cron | No fim do ciclo, aplica downgrade agendado (`pending_tier_change`). |
| `tier-capacity-guard` | função/RPC | Decremento atômico de vaga (FOR UPDATE / UPDATE...RETURNING) usado no checkout. |

---

### 4. Telas / Front

#### 4.1 Admin (painel padronizado §10.1 → módulo "Tiers & Perks")

- **Lista de Tiers (drag-drop):** cards reordenáveis (position), cada um com cor/arte, preço, período, badge de status (draft/active/archived/esgotado), contador de vagas `taken/capacity`. Ações: editar, publicar, arquivar, duplicar.
- **Editor de Tier (drawer/form):** nome, descrição, preço, **seletor de período** (mensal/tri/sem/anual; toggle "habilitar parcelamento até 12×" **desabilitado se mensal**), capacidade/vagas, janela de lote (from/until), trial_days, cor + upload de arte, status. Mostra preview do member card.
- **Editor de Capacidade/Lote:** define vagas, mostra ocupação em tempo real (Realtime), aviso "X vagas restantes".
- **Catálogo de Perks:** lista por tipo, criar/editar perk (formulário muda conforme `type` — config dinâmico). Indicador "usado em N tiers".
- **Matriz Tier × Perk:** grid de checkboxes (tier nas colunas, perk nas linhas) para vincular/desvincular rápido. Aviso ao desvincular perk de tier com membros ("X membros perderão este perk — aplicar imediatamente / no próximo ciclo / manter grandfathered").
- **Cupons:** CRUD, código, tipo, validade, restrições, contador de usos.
- **Concessão de cortesia (na ficha do membro/CRM):** botão "Conceder perk" → escolhe perk + expiração opcional → cria entitlement manual. Lista de entitlements do membro com origem (tier/manual), status e expiração.
- **Auditoria de mudança:** ao editar preço, modal de grandfathering ("manter preço dos atuais / aplicar a todos").

#### 4.2 Membro (front hosted temável §24.2)

- **Página de Tiers / Checkout:** cards de tier ordenados, cor/arte, preço, "X vagas restantes" / "Esgotado", badge de trial/promo, lista de perks. Botão assinar → checkout (com cupom).
- **Área do membro:** tier atual + **lista de perks ativos** (lidos de entitlements, não de tier_perks), com estados (ativo, expira em N dias para cortesias). Selo "preço de fundador" se grandfathered.
- **Upgrade/Downgrade:** comparador de tiers com cálculo de proração visível ("você paga R$X agora, acesso imediato" / "downgrade vale a partir de DD/MM, você mantém perks até lá").
- **Aviso de perda de perks no downgrade:** lista explícita "você perderá: cargo Discord X, VOD Y" antes de confirmar.

---

### 5. Integrações externas

Este domínio **não chama** serviços externos diretamente; **produz intenções** que o `integrations-framework` executa. Mapeamentos:

| Perk type | Provider | Ação no sync |
|---|---|---|
| `channel` | Discord | atribuir/remover role por tier (§16) |
| `channel` | Telegram | invite/kick de grupo |
| `channel` | WhatsApp | add/remove de grupo/comunidade (API Oficial) |
| `content` | YouTube/Twitch/Vimeo | liberar/revogar acesso a VOD/playlist (signed URL / membership-level, §15) |
| `discount` | Loja/parceiro | gerar/revogar código de desconto |
| `niche` | Steam/Riot | resolver requisito (conta conectada) antes de ativar entitlement |
| `event` | Sympla/Ingresse/nativo | direito a lote de membro / acesso antecipado (§14) |
| (todos) | Asaas | **upstream**: webhook de pagamento dispara `resolveEntitlements` |
| (tier change) | Apple/Google Wallet | push de atualização do passe (tier mudou) |

Contratos: cada delta vira `entitlement_sync_jobs` consumido pelo worker → connector. Reconcile cron compara estado. Falha de provider não derruba o entitlement (§1.6).

---

### 6. Épicos & tarefas

#### Épico A — Modelo de dados & RLS (fundação do domínio)
- A1 (M) Migration `tiers` estendida (period enum, installments_enabled, capacity, taken_count, trial, lote, status) + constraints + índices.
- A2 (S) Migration `perks` + enum `perk_type` + `tier_perks` PK composta + índices.
- A3 (M) Migration `entitlements` (source, status, expires_at, tier_snapshot, unique natural) + índices parciais.
- A4 (S) Migration `entitlement_sync_state`, `tier_holds`.
- A5 (M) Migration `coupons` + `coupon_redemptions`.
- A6 (S) Alterar `subscriptions`: price snapshot, grandfathered, pending_tier_change, trial_ends_at.
- A7 (M) Políticas RLS por org_id em todas as novas tabelas + testes de isolamento.

#### Épico B — CRUD de Tiers
- B1 (M) Endpoints `/v1/tiers` CRUD + publish/archive (máquina de estados).
- B2 (S) `POST /v1/tiers/reorder` com unique deferrable.
- B3 (M) Validações de negócio: mensal-não-parcela, capacity>0, transições de status válidas.
- B4 (S) `GET /v1/tiers/{id}/availability` (vagas/sold_out/janela).
- B5 (M) Admin: lista drag-drop + editor de tier + preview member card.

#### Épico C — Catálogo de Perks & tier_perks
- C1 (M) Endpoints `/v1/perks` CRUD + config dinâmico por tipo (validação por schema do tipo).
- C2 (S) Vincular/desvincular `tier_perks` + bloqueio de delete de perk em uso (409).
- C3 (M) Admin: catálogo + matriz Tier×Perk + formulário dinâmico por tipo.

#### Épico D — Engine de Entitlements (núcleo)
- D1 (L) `resolveEntitlements(member_id)` idempotente: desejado vs atual, diff, upsert por chave natural, ordem conceder-antes-revogar.
- D2 (M) Concessão manual/cortesia: endpoints + expires_at + audit (granted_by).
- D3 (M) `entitlement-expiry-cron` (pg_cron) + revoke sync ao expirar.
- D4 (S) `GET /members/{id}/entitlements` + leitura quente (índice parcial).
- D5 (M) Grandfathering de perk-set: tier_snapshot, flag, lógica no resolver.

#### Épico E — Sync com integrações
- E1 (M) Fila `entitlement_sync_jobs` (pgmq) + enqueue dos deltas no resolver.
- E2 (L) `entitlement-sync-worker`: consumer, chama connector, grava sync_state, retry/backoff/DLQ.
- E3 (M) `entitlement-reconcile-cron`: drift detection vs providers.
- E4 (S) Falha-parcial-isolada: entitlement permanece active; só sync_state falha.
- E5 (S) Passport push ao mudar tier (hook para domínio passport).

#### Épico F — Mudança de tier & proração (interface com billing)
- F1 (L) `POST /v1/subscriptions/{id}/change-tier`: cálculo de proração (upgrade/downgrade), crédito prorata-die.
- F2 (M) Downgrade ao fim do ciclo: `pending_tier_change` + `apply-pending-tier-change` cron.
- F3 (M) Lista de "perks que serão perdidos" (preview de diff antes de confirmar).
- F4 (M) Tratamento por tipo na perda de perk (drop entregue, ingresso emitido, badge permanente).
- F5 (M) Edge case mensal↔anual (mudança de duração de ciclo = nova compra com crédito).

#### Épico G — Capacidade, lotes, holds
- G1 (M) `tier-capacity-guard`: decremento atômico (FOR UPDATE/RETURNING) anti-oversell.
- G2 (M) `tier_holds` + reserva no checkout (TTL) + `tier-hold-reaper` cron.
- G3 (S) Estado `sold_out` derivado + UI Realtime de vagas.
- G4 (S) Política de devolução de vaga ao cancelar (config).
- G5 (M) Lote fundador: janela + preço + capacidade (MVP no próprio tier; `tier_batches` pós-MVP).

#### Épico H — Trials, cupons, promoções
- H1 (M) Trial: trial_days, acesso imediato, 1ª cobrança adiada, expiração sem pagamento → revoga; anti-reabuso.
- H2 (M) Cupons: CRUD + validate no checkout + redemptions + recurring vs one_time.
- H3 (S) Preço promocional / grandfathering de preço (snapshot na subscription).

#### Épico I — Webhooks/eventos de saída
- I1 (S) Emitir `member.tier_changed`, `member.entitlements_changed` para webhooks-out (§22).
- I2 (S) Registrar tudo em `interactions` (timeline CRM) + audit_logs.

---

### 7. Dependências

| Depende de | Por quê |
|---|---|
| **fundacao** | Schema base, org_id, RLS, pg_cron/pgmq, convenções de migration. |
| **auth-rbac** | Permissões de admin para criar tiers/perks/conceder cortesia; escopo por org. |
| **member-identity** | `members`/`member_id`; entitlement é por membro. |
| **payments-billing** | `subscriptions`, proração, snapshot de preço, webhook Asaas que dispara o resolver; change-tier vive lá e chama o resolver daqui. |
| **integrations-framework** | Executa os syncs (Discord/YouTube/...); este domínio só enfileira intenções. |
| **passport** | Push de atualização do passe ao mudar tier/perk. |
| **crm** | `interactions`/timeline registra mudanças; cortesia parte da ficha do membro. |
| **content-gating** | Perk `content` resolve acesso a VOD lendo entitlements. |
| **community-channels** | Perk `channel` aplica cargo/grupo lendo entitlements. |
| **events-tickets** | Perk `event` (lote de membro, acesso antecipado, ingresso incluso). |
| **hall-of-fame** | Perk `recognition` (badge, posição). |
| **webhooks** | Emite `member.tier_changed` etc. |
| **design-system / admin-app / member-app** | Telas de tiers/perks/checkout/cortesia. |

> Dependência mais crítica e bidirecional: **payments-billing** (subscription é a origem do entitlement de tier; proração e grandfathering moram parcialmente lá).

---

### 8. Riscos & decisões técnicas

1. **Oversell em lote limitado (race condition).** Sob concorrência, dois checkouts pegam a última vaga. Mitigação: decremento atômico com lock/`UPDATE...WHERE taken_count<capacity RETURNING` + holds com TTL. **Nunca** check-then-insert sem lock. Testar com carga concorrente.
2. **Janela sem acesso durante upgrade.** Se revogar antes de conceder, membro fica sem cargo por segundos. Regra fixa: **conceder-antes-revogar**.
3. **Falha de integração não pode revogar direito.** Discord fora do ar não deve tirar o perk do membro; isolar sync_state do entitlement. DLQ + reconcile.
4. **Idempotência do resolver.** Webhooks Asaas reenviam; replay/retry. `resolveEntitlements` precisa convergir; chave natural `(member_id, perk_id, source)` para upsert. Sem isso, duplica entitlements e sync.
5. **Proração com plano parcelado.** Upgrade de um tier anual parcelado em 12× é matematicamente complexo (parcelas futuras já contratadas, sem auto-renovação §13.3.2). Recomendação: **restringir change-tier em planos parcelados** no MVP (ou tratar como nova compra com crédito do não-consumido), explicitar na UI. **Bloqueante de produto.**
6. **Grandfathering de perks vs preço.** Preço congelado é claro (snapshot na subscription). Perks congelados (membro mantém perk removido do tier) exige `tier_snapshot` e desvia o resolver — risco de complexidade. Decidir cedo (Open Questions).
7. **Drop/brinde já entregue no downgrade.** Não se "desfaz" envio físico. `is_revocable=false` + estado consumed. Ingresso já emitido também se honra. Falhar aqui gera disputa com membro.
8. **Devolução de vaga ao cancelar.** Se vaga volta ao pool, lote fundador "100 vagas" pode ter rotatividade infinita (fura escassez). Recomendação: vaga **não** volta (lote é histórico). Mas para tier comum com capacidade, talvez volte. Config por tier.
9. **Trial abuse.** Membro cancela e reassina para novo trial. Anti-abuso: 1 trial por (member×tier) ou por org; verificar histórico de subscriptions.
10. **Mudança de período (mensal→anual) e proração.** Ciclos de duração diferente quebram proração linear simples; tratar como nova compra com crédito. Documentar.
11. **Reordenação concorrente (drag-drop).** Dois admins reordenam ao mesmo tempo → unique(org_id,position) viola. `DEFERRABLE INITIALLY DEFERRED` + reorder transacional em lote.
12. **Consistência entitlement ↔ estado externo (drift).** Alguém edita cargo no Discord manualmente. Reconcile cron é a única defesa; definir frequência e se "fonte da verdade" é sempre a Stanbase (recomendado: sim, Stanbase manda).

---

### 9. Escopo MVP vs. depois

#### MVP (Fase 1 — §29 "MVP do membership")
- Tiers CRUD completos: nome, descrição, preço, período (mensal/tri/sem/anual), **drag-drop ordem**, cor/arte, **capacidade/vagas + lote fundador (no próprio tier)**, status draft/active/archived.
- Toggle de parcelamento (até 12×, bloqueado em mensal) — flag; a lógica de juros vive em billing.
- Catálogo de Perks com os 8 tipos + `config` jsonb + `tier_perks` (matriz).
- **Engine de Entitlements**: resolver idempotente (derivado de tier), concessão manual/cortesia, expiração programada.
- **Sync ao mudar de tier** com integrações do MVP (Discord cargo + conteúdo); falha-parcial isolada; reconcile básico.
- Upgrade/downgrade com proração **para planos à vista/recorrentes** (não-parcelados).
- Capacidade com anti-oversell (lock atômico) + holds de checkout.
- Trials e cupons básicos (one_time).
- Grandfathering **de preço** (snapshot na subscription).

#### Depois (Fases 2+)
- `tier_batches` (múltiplos lotes por tier, ex.: fundador→regular automático).
- Waitlist quando esgotado.
- Proração de planos **parcelados** (ou política definitiva de bloqueio).
- Grandfathering **de perks** (manter perk removido).
- Cupons recorrentes + regras avançadas (stacking, primeira-compra-only).
- Perks de nicho com `pending_requirement` (Steam/Riot/validação) — depende de integrations avançadas.
- Reconcile sofisticado + dashboard de drift de sync.
- Devolução de vaga configurável + analytics de capacidade.
