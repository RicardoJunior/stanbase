## 10. Pagamentos, Assinaturas & Billing (Asaas)

> Domínio que transforma toda transação em receita previsível e contabilizada: checkout (Pix, cartão à vista, cartão parcelado até 12×, Pix Automático), assinaturas recorrentes, split marketplace, parcelamento com juros pass-through (modelo Hotmart, regra `max(Hotmart, Asaas)`), dunning, reembolsos, chargebacks, payouts e conciliação. PSP de lançamento: **Asaas** (decidido), com camada **PSP-agnóstica** (adapter) para troca/escala futura.
>
> Fonte de verdade: `STANBASE.md` §13 (e §3, §12, §25.3). Decisões imutáveis assumidas aqui: PSP = Asaas; comissão base **7,99%**; juros parcelado ao cliente **3,49% a.m.** (regra `max`); parcelamento só em tri/sem/anual até **12×**; **plano parcelado não auto-renova**; 1 membership por org; uma Conta possui N orgs.

---

### 10.1 Como funciona

#### 10.1.1 Princípios de produto que viram regra de código

1. **All-in 7,99%** — a comissão base é fixa (7,99% do **valor do plano**, sem juros), padrão Stanbase, **não configurável por org**. O custo do PSP (Pix, MDR de cartão) sai **de dentro** dos 7,99% → é margem da Stanbase, nunca cobrado a mais do dono.
2. **Juros de parcelamento é pass-through** — o membro paga os juros no checkout (transparente, modelo Hotmart). A org recebe o valor **antecipado** sem absorver juros. A Stanbase fica com o **spread** = juros cobrados do cliente − custo de antecipação do Asaas.
3. **`max(Hotmart, Asaas)`** — a taxa de juros ao cliente é o maior entre Hotmart (3,49% a.m.) e a antecipação Asaas negociada. Hoje = **3,49% a.m.** (Hotmart vence). É **parâmetro global de plataforma** (`platform_billing_settings`), revalidável contra o contrato Asaas.
4. **Mensal nunca parcela.** Parcelamento só em tri/semestral/anual, teto fixo **12×** (não amarra ao nº de meses do plano).
5. **Plano parcelado é compra avulsa** — libera acesso pelo período do plano; **não auto-renova**. Parcelas podem ultrapassar a duração do acesso sem conflito (acesso e cobrança são linhas do tempo independentes).
6. **A Stanbase não toca em dado de cartão** — tokenização/PCI 100% no Asaas. Guardamos só `psp_ref`, bandeira, últimos 4 dígitos, token de cartão do Asaas (referência opaca).

#### 10.1.2 Modelo de dinheiro — contabilidade por transação

Toda transação registra a decomposição completa (campos em `transactions`, §10.2):

```
gross                = valor do plano + customer_interest (o que o cliente paga no total)
customer_interest    = juros pass-through (0 em Pix/à vista; > 0 em parcelado)
base_commission      = 7,99% × valor_do_plano   (NÃO incide sobre juros)
psp_fee              = MDR/tarifa Asaas da transação (Pix fixo, ou % do cartão)
psp_anticipation_fee = custo de antecipação Asaas (só parcelado; ~1,25% a.m. × meses)
financing_spread     = customer_interest − psp_anticipation_fee   (receita Stanbase de financiamento)
net_org              = valor_do_plano − base_commission           (o que a org recebe, antecipado)
stanbase_revenue     = base_commission + financing_spread − psp_fee  (margem líquida da plataforma)
```

Regras de cálculo concretas:

- **`base_commission` incide sobre o valor do plano, não sobre os juros.** Ex.: anual R$ 600 em 12× → cliente paga ~R$ 744,70; `base_commission` = 7,99% × **600** = R$ 47,94 (não sobre 744,70).
- **Juros (tabela Price), composto a 3,49% a.m.** O coeficiente de parcela é pré-calculado (§10.2 `installment_coefficients`), não calculado em runtime, para evitar divergência de centavos com o checkout do Asaas.
- **Pix e à vista:** `customer_interest = 0`, `psp_anticipation_fee = 0`, `financing_spread = 0`. `psp_fee` = tarifa Pix (fixo) ou MDR cartão à vista.
- **Idempotência financeira:** todo POST de escrita financeira exige `Idempotency-Key` (§STANBASE 21.1). Webhook do Asaas é deduplicado por `event_id` do Asaas.

#### 10.1.3 Máquina de estados — Subconta Asaas (por org)

Cada **org** (não Conta) tem **uma subconta Asaas** (split/marketplace). KYC é por org porque o repasse e o CNPJ/CPF são por base.

```
none → kyc_pending → kyc_submitted → kyc_under_review → active
                                          │                  │
                                          ├→ kyc_rejected ───┤ (corrige e reenvia)
                                          │
        active → suspended (Asaas bloqueia) → active
        active → disabled (org encerra base)
```

Regras:
- Org **só pode publicar tiers pagos / receber checkout** quando subconta = `active`. Antes disso, checkout fica bloqueado com CTA "Complete seu cadastro de recebimento".
- `kyc_rejected` mostra o motivo retornado pelo Asaas e permite reenvio dos documentos pendentes.
- Mudança de status chega por **webhook do Asaas** (`accountStatus`) + job de reconciliação diário (fallback se webhook falhar).

#### 10.1.4 Máquina de estados — Assinatura (recorrente, à vista/Pix Automático/cartão)

```
                   ┌─────────────────────────────────────────────┐
                   ▼                                             │
trialing → active → past_due → (retry/dunning) → active         │
                       │                                         │
                       ├──────────→ unpaid (grace expirou) ──────┘ (revoga acesso)
                       │
active → paused → active
active → canceled (fim do período ou imediato)
active → expired (não-renovação manual)
```

- `current_period_end` define quando o acesso e a próxima cobrança vencem.
- **`trialing`**: acesso liberado, sem cobrança; ao fim do trial, gera a 1ª cobrança → `active` se paga, `past_due` se falha.
- **`past_due`**: cobrança da renovação falhou. Acesso **ainda mantido** durante o **grace period** configurável (default sugerido 3 dias). Entra no **dunning** (retries do Asaas + comunicação).
- **`unpaid`**: grace expirou sem pagamento → acesso revogado (entitlements suspensos, cargos Discord removidos, passport com status "inativo" via push). Assinatura permanece reativável se o pagamento entrar depois (grace de reativação configurável).
- **`paused`**: org pausa cobrança e acesso (ex.: a pedido do membro); não gera cobrança; `current_period_end` congela.
- **`canceled`**: membro/org cancela. Default: **acesso até o fim do período já pago** (`cancel_at_period_end = true`); cancelamento imediato com/sem reembolso é opção.

#### 10.1.5 Máquina de estados — Plano parcelado (compra avulsa, não-recorrente)

Parcelado tem **duas linhas do tempo independentes**: (a) **acesso** ao membership pelo período do plano; (b) **cobranças** das N parcelas no cartão.

```
ACESSO:    granted (na 1ª parcela confirmada) → active_until(period_end) → expired
COBRANÇA:  installment_plan: pending → in_progress → completed
                                          │
                                          ├→ delinquent (parcela falhou) → in_progress (retomou)
                                          └→ defaulted (parcela inadimplente após retries)
```

Regra-chave (edge case central — ver §10.8): **o que fazer com o acesso se o cliente parar de pagar parcelas no meio?** Decisão recomendada e implementada como default configurável: **acesso segue até o fim do período do plano mesmo com parcela em atraso** (porque a org já recebeu antecipado e o risco de inadimplência é da Stanbase, que financiou). A Stanbase persegue a cobrança via dunning sobre o cartão, mas **não revoga o acesso** do membro por parcela atrasada — diferente da assinatura recorrente. Esta é uma **open question de produto** (§10.x openQuestions) — manter configurável.

#### 10.1.6 Fluxo passo a passo — Checkout Pix à vista

1. Front chama `POST /v1/subscriptions` (ou `/v1/checkout`) com `tier_id`, `method=pix`, `Idempotency-Key`.
2. Edge Function valida: subconta Asaas da org `active`; tier publicado; vaga disponível (capacity); cupom (se houver).
3. Cria cobrança no Asaas com **split** (7,99% → walletId Stanbase; restante → subconta org). Cria cobrança Pix → retorna `qrCode`, `copia_e_cola`, `expiresAt`.
4. Persiste `transactions` (status `pending`), `subscriptions` (status `pending`/`incomplete`).
5. Front exibe QR + copia-e-cola + contador de expiração.
6. **Webhook Asaas `PAYMENT_RECEIVED`** → marca `transactions.paid`, ativa `subscription` (`active`), concede entitlements, dispara passport push, webhook de saída `subscription.payment_succeeded`.
7. **Pix expirado** (sem pagamento até `expiresAt`): webhook `PAYMENT_OVERDUE`/expiração → `transactions.expired`, `subscription.incomplete_expired`. Front oferece **gerar novo Pix** (nova cobrança, novo `Idempotency-Key`).

#### 10.1.7 Fluxo passo a passo — Checkout Cartão parcelado (até 12×)

1. Front pede a **simulação** de parcelamento: `GET /v1/checkout/installment-quote?tier_id=&installments=` → retorna, para cada nº de parcelas (2..12), `valor_parcela`, `total`, `customer_interest`, `coeficiente`. (Tabela Price pré-calculada — §10.2.)
2. Membro escolhe N parcelas; tokeniza o cartão **direto no Asaas** (tokenização client-side / iframe Asaas — a Stanbase não recebe PAN).
3. `POST /v1/subscriptions` com `method=credit_card`, `installments=N`, `card_token`, `Idempotency-Key`.
4. Edge cria no Asaas **cobrança parcelada** (installment) com split aplicado **em cada parcela** (7,99% sobre o valor do plano rateado; juros não entram na base de comissão) e solicita **antecipação** (org recebe à vista; Stanbase paga custo de antecipação ao Asaas).
5. Persiste `transactions` com decomposição completa (gross, customer_interest, base_commission, psp_fee, psp_anticipation_fee, financing_spread, net_org), `installment_plan`, `subscription` com `auto_renew=false`.
6. 1ª parcela confirmada → acesso `granted` até `period_end`; webhook de saída.
7. Parcelas seguintes cobradas pelo Asaas mês a mês → cada `PAYMENT_RECEIVED` registra recebimento; falha → `delinquent` + dunning (sobre o cartão), **sem revogar acesso** por default.

#### 10.1.8 Fluxo passo a passo — Pix Automático (recorrência sem cartão)

- Para planos **recorrentes** (mensal/tri/sem/anual à vista recorrente), oferecer **Pix Automático** quando disponível na conta Asaas (maior margem: recorrência sem MDR de cartão — lever estratégico §13.2.2).
- Fluxo: cria autorização de Pix Automático no Asaas → membro autoriza no app do banco → Asaas cobra automaticamente a cada ciclo. Webhooks de cada ciclo atualizam a assinatura.
- Fallback: se o banco do membro não suporta Pix Automático, oferece **cartão recorrente** ou **Pix manual com lembrete** a cada ciclo.

#### 10.1.9 Dunning / inadimplência (recorrente)

- Asaas faz retries de cartão automaticamente; configuramos uma **régua de dunning** própria por cima:
  - D+0 falha → `past_due`, e-mail/push "atualize seu pagamento", início do grace period.
  - D+1, D+3, D+5 → novas tentativas + lembretes (e-mail/WhatsApp/push), CTA **trocar cartão** / **pagar via Pix agora**.
  - Fim do grace (default D+3, configurável por org) → `unpaid` → revoga acesso.
- **Troca de cartão durante past_due:** membro atualiza cartão (`POST /v1/subscriptions/{id}/payment-method`) → dispara cobrança imediata do valor em aberto → se paga, volta a `active`.

#### 10.1.10 Reembolsos, chargebacks e conciliação

- **Reembolso total:** `POST /v1/transactions/{id}/refund` → Asaas estorna. **Reverte o split**: a Stanbase devolve a comissão e o Asaas estorna ao cliente; `net_org` é debitado da org (saldo/futuros payouts). Acesso é revogado conforme política (imediato ou fim do período).
- **Reembolso parcial:** valor < gross. Recalcula proporcionalmente comissão estornada. Edge case: parcial **não** zera entitlements automaticamente — exige decisão (manter acesso? reduzir período?). Configurável; default = manter acesso até fim do período pago.
- **Chargeback (contestação de cartão):** webhook Asaas `PAYMENT_CHARGEBACK_REQUESTED` → marca transação `disputed`, congela payout do valor, notifica org, abre tarefa no CRM. Se perdido (`CHARGEBACK_DISPUTE_LOST`) → debita org/Stanbase conforme responsabilidade, revoga acesso, registra perda. Reúne evidências (logo de entrega de acesso, IP, etc.) para contestar.
- **Conciliação:** job diário compara `transactions`/`payouts` da Stanbase com o extrato Asaas (transfers, settlements, antecipações, estornos). Divergências → fila `reconciliation_exceptions` para revisão manual.

#### 10.1.11 Payouts / repasses

- O split do Asaas já credita o `net_org` na **subconta da org** em cada transação. "Payout" aqui = **saque/transferência** da subconta para a conta bancária da org (configurada no KYC).
- Frequência configurável (diário/semanal) ou on-demand; registra `payouts` (amount, period, status, psp_ref).
- Saldo bloqueado por disputas/reembolsos pendentes é descontado do disponível.

#### 10.1.12 NF / fiscal

- A Stanbase **não emite NF pela org** no MVP (responsabilidade fiscal da org). Provê dados para conciliação e exportação. Pós-MVP: integração de emissão de NFS-e (Asaas tem módulo de NF) e NF da **comissão Stanbase** para a org. Ver openQuestions.

---

### 10.2 Modelo de dados

Tabelas novas/tocadas (todas com `org_id` + RLS, exceto parâmetros globais de plataforma). Reusa e expande §25.3 do STANBASE.

#### 10.2.1 Parâmetros de plataforma (global, sem org_id)

```sql
-- platform_billing_settings: linha única (singleton), padrão Stanbase global
platform_billing_settings (
  id                         int primary key default 1,  -- singleton
  base_commission_rate       numeric(6,4) not null default 0.0799,   -- 7,99%
  installment_interest_rate_am numeric(6,4) not null default 0.0349, -- 3,49% a.m. (max Hotmart/Asaas)
  psp_anticipation_rate_am   numeric(6,4) not null,                  -- custo Asaas negociado
  max_installments           int not null default 12,
  min_installment_amount     numeric(12,2) not null default 5.00,    -- piso por parcela (Asaas exige mínimo)
  grace_period_days_default  int not null default 3,
  hotmart_reference_rate_am  numeric(6,4) not null default 0.0349,   -- p/ regra max
  updated_at                 timestamptz default now(),
  updated_by                 uuid
)

-- installment_coefficients: tabela Price pré-calculada (2x..12x), evita drift de centavos
installment_coefficients (
  installments  int primary key,           -- 2..12
  interest_rate_am numeric(6,4) not null,  -- snapshot da taxa usada
  coefficient   numeric(12,8) not null,    -- multiplicador sobre o principal p/ valor da parcela
  total_markup  numeric(6,4) not null,     -- acréscimo total (ex.: 12x = 0,241)
  computed_at   timestamptz default now()
)
```

#### 10.2.2 Subcontas Asaas (por org)

```sql
asaas_subaccounts (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  asaas_account_id text,            -- id da subconta no Asaas
  asaas_wallet_id  text,            -- walletId p/ receber o split (org)
  api_key_ref   text,              -- referência cifrada (vault), nunca o valor cru
  status        text not null default 'none',  -- none|kyc_pending|kyc_submitted|kyc_under_review|active|kyc_rejected|suspended|disabled
  kyc_rejection_reason text,
  payout_bank_account jsonb,        -- dados bancários (cifrado)
  payout_schedule text default 'daily',  -- daily|weekly|on_demand
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique(org_id)                    -- 1 subconta por org
)
```

#### 10.2.3 Assinaturas, transações, parcelas, payouts

```sql
-- subscriptions (expande §25.3)
subscriptions (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id),
  member_id          uuid not null references members(id),
  tier_id            uuid not null references tiers(id),
  period             text not null,        -- monthly|quarterly|semiannual|annual|one_time|lifetime
  kind               text not null,        -- recurring | installment  (installment = não auto-renova)
  status             text not null,        -- incomplete|trialing|active|past_due|unpaid|paused|canceled|expired|incomplete_expired
  method             text not null,        -- pix|pix_automatic|credit_card|boleto
  installments       int default 1,        -- 1 = à vista
  auto_renew         boolean not null default true,  -- SEMPRE false se kind=installment
  current_period_start timestamptz,
  current_period_end   timestamptz,        -- fim do acesso pago
  cancel_at_period_end boolean default true,
  grace_period_days  int,                  -- override do default global
  trial_end          timestamptz,
  coupon_id          uuid,
  asaas_subscription_ref text,             -- p/ recorrente
  asaas_installment_ref  text,             -- p/ parcelado
  canceled_at        timestamptz,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
)
-- índices: (org_id, status), (member_id), (current_period_end) p/ jobs de renovação/expiração

-- transactions: contabilidade por transação (1 por cobrança individual)
transactions (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references organizations(id),
  member_id            uuid not null references members(id),
  subscription_id      uuid references subscriptions(id),
  type                 text not null,      -- subscription|ticket|drop|gift|upgrade|renewal|installment_charge
  method               text not null,
  installments         int default 1,
  installment_number   int,                -- 1..N (qual parcela, se aplicável)
  plan_amount          numeric(12,2) not null,   -- valor do plano (base da comissão)
  customer_interest    numeric(12,2) not null default 0,
  gross                numeric(12,2) not null,   -- plan_amount + customer_interest
  base_commission      numeric(12,2) not null,   -- 7,99% × plan_amount
  psp_fee              numeric(12,2) not null default 0,
  psp_anticipation_fee numeric(12,2) not null default 0,
  financing_spread     numeric(12,2) not null default 0,  -- customer_interest - psp_anticipation_fee
  net_org              numeric(12,2) not null,   -- plan_amount - base_commission
  stanbase_revenue     numeric(12,2),            -- base_commission + financing_spread - psp_fee
  currency             text not null default 'BRL',
  status               text not null,      -- pending|paid|expired|failed|refunded|partially_refunded|disputed|chargeback_lost
  refunded_amount      numeric(12,2) default 0,
  asaas_payment_id     text,               -- psp_ref
  asaas_event_dedup    text,               -- p/ idempotência de webhook
  idempotency_key      text,
  paid_at              timestamptz,
  created_at           timestamptz default now(),
  unique(idempotency_key),
  unique(asaas_payment_id)
)
-- índices: (org_id, created_at), (subscription_id), (status), (asaas_payment_id)

-- installment_plans: agrupa as N parcelas de um parcelado
installment_plans (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id),
  subscription_id uuid not null references subscriptions(id),
  installments    int not null,            -- N
  plan_amount     numeric(12,2) not null,
  total_charged   numeric(12,2) not null,  -- com juros
  status          text not null,           -- pending|in_progress|completed|delinquent|defaulted
  access_until    timestamptz not null,    -- fim do acesso (independe das parcelas)
  asaas_installment_ref text,
  created_at      timestamptz default now()
)

-- payouts / repasses
payouts (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  amount        numeric(12,2) not null,
  period        tstzrange,
  status        text not null,             -- scheduled|processing|paid|failed|on_hold
  hold_reason   text,                      -- dispute|reconciliation|kyc
  asaas_transfer_id text,
  created_at    timestamptz default now()
)

-- refunds
refunds (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  transaction_id uuid not null references transactions(id),
  amount        numeric(12,2) not null,
  kind          text not null,             -- full|partial
  reason        text,
  commission_reversed numeric(12,2),
  access_policy text,                      -- keep_until_period_end|revoke_now|reduce_period
  asaas_refund_id text,
  status        text not null,             -- pending|done|failed
  created_at    timestamptz default now()
)

-- disputes (chargebacks)
disputes (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  transaction_id uuid not null references transactions(id),
  status        text not null,             -- requested|under_review|won|lost
  amount        numeric(12,2),
  evidence      jsonb,
  asaas_dispute_ref text,
  opened_at     timestamptz,
  resolved_at   timestamptz
)

-- webhook inbox (Asaas → idempotência + replay)
asaas_webhook_events (
  id            uuid primary key default gen_random_uuid(),
  asaas_event_id text not null,            -- dedup
  event_type    text not null,
  payload       jsonb not null,
  signature_ok  boolean,
  processed     boolean default false,
  processed_at  timestamptz,
  error         text,
  received_at   timestamptz default now(),
  unique(asaas_event_id)
)

-- conciliação
reconciliation_exceptions (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid,
  kind          text,                      -- missing_in_stanbase|missing_in_asaas|amount_mismatch|status_mismatch
  asaas_ref     text,
  internal_ref  uuid,
  details       jsonb,
  resolved      boolean default false,
  created_at    timestamptz default now()
)

-- cupons / descontos (billing)
coupons (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  code          text not null,
  kind          text not null,             -- percent|fixed
  value         numeric(12,2) not null,
  applies_to    text,                      -- first_charge|all|specific_tiers
  max_redemptions int,
  redeemed      int default 0,
  valid_until   timestamptz,
  status        text default 'active',
  unique(org_id, code)
)
```

Constraints/índices relevantes:
- `transactions.idempotency_key` UNIQUE e `asaas_payment_id` UNIQUE (anti-duplicação de webhook/retry).
- `asaas_webhook_events.asaas_event_id` UNIQUE (dedup de webhook).
- `asaas_subaccounts.org_id` UNIQUE (1 subconta por org).
- Constraint de check: `subscriptions.kind='installment' → auto_renew=false`.
- Constraint de check: `tiers.period='monthly' → installments_enabled=false` (mensal nunca parcela — já em §25.3).
- Índice em `subscriptions(current_period_end, status)` para o job de renovação/expiração.

---

### 10.3 API & Edge Functions

#### 10.3.1 Endpoints `/v1` (públicos/admin via API)

```
# Checkout & simulação
GET    /v1/checkout/installment-quote     # simula parcelas 2..12 (valor, juros, total, coeficiente)
POST   /v1/subscriptions                  # assinar tier (Pix / cartão / parcelado) — Idempotency-Key
GET    /v1/subscriptions/{id}
POST   /v1/subscriptions/{id}/cancel      # cancelar (period_end | imediato | c/ reembolso)
POST   /v1/subscriptions/{id}/pause
POST   /v1/subscriptions/{id}/resume
POST   /v1/subscriptions/{id}/change-tier # upgrade/downgrade c/ proração
POST   /v1/subscriptions/{id}/payment-method  # trocar cartão / re-tentar cobrança
POST   /v1/subscriptions/{id}/retry       # retry manual de cobrança (dunning)

# Transações / financeiro
GET    /v1/transactions                   # listar/filtrar
GET    /v1/transactions/{id}
POST   /v1/transactions/{id}/refund       # total ou parcial
GET    /v1/installment-plans/{id}         # estado das parcelas de um parcelado

# Payouts / repasses
GET    /v1/payouts
POST   /v1/payouts/withdraw               # saque on-demand da subconta

# Subconta / onboarding (admin)
POST   /v1/billing/subaccount             # criar subconta Asaas p/ a org
GET    /v1/billing/subaccount             # status do KYC/onboarding
POST   /v1/billing/subaccount/kyc         # enviar/atualizar documentos KYC
PATCH  /v1/billing/settings               # payout schedule, grace period override

# Cupons
GET    /v1/coupons
POST   /v1/coupons

# Relatórios financeiros
GET    /v1/reports/revenue                # MRR, churn de receita, comissão base vs spread
GET    /v1/reports/reconciliation         # status da conciliação

# Webhook de entrada (Asaas → Stanbase)
POST   /v1/webhooks/asaas                 # recebe eventos Asaas (verifica assinatura, dedup, enfileira)
```

#### 10.3.2 Edge Functions / Jobs

```
fn:asaas-webhook-handler     # valida assinatura, grava asaas_webhook_events, enfileira (pgmq)
fn:asaas-webhook-processor   # consome fila, aplica efeito (paga, ativa, revoga, dispara push/webhook out)
fn:checkout-create           # cria cobrança/assinatura/parcelado no Asaas com split + antecipação
fn:installment-quote         # calcula simulação via installment_coefficients
fn:subaccount-create         # cria subconta Asaas + inicia KYC
fn:subaccount-kyc-sync       # sincroniza status KYC (webhook + reconciliação)
fn:refund-process            # estorno total/parcial, reverte split, aplica política de acesso
fn:payout-withdraw           # saque/transferência da subconta
job:dunning-runner (cron)    # régua de retries/lembretes p/ past_due
job:renewal-runner (cron)    # gera cobranças de renovação (recorrentes), expira não-renovados
job:installment-monitor (cron) # acompanha parcelas, marca delinquent/defaulted
job:grace-expirer (cron)     # past_due → unpaid quando grace estoura → revoga acesso
job:reconciliation (cron)    # bate transactions/payouts × extrato Asaas → exceptions
job:coefficients-recompute   # recalcula tabela Price se a taxa global mudar
```

Eventos de **webhook de saída** disparados (§22 STANBASE): `subscription.payment_succeeded`, `subscription.payment_failed`, `subscription.canceled`, `subscription.renewed`, `transaction.refunded`, `transaction.chargeback`, `payout.paid`, `member.tier_changed` (em upgrade/downgrade).

Eventos **Asaas consumidos**: `PAYMENT_CREATED`, `PAYMENT_RECEIVED`, `PAYMENT_CONFIRMED`, `PAYMENT_OVERDUE`, `PAYMENT_REFUNDED`, `PAYMENT_CHARGEBACK_REQUESTED`, `PAYMENT_CHARGEBACK_DISPUTE`, `PAYMENT_DELETED`, `TRANSFER_*`, `ACCOUNT_STATUS_*`.

---

### 10.4 Telas / Front

#### 10.4.1 Admin (org)

- **Receita & Pagamentos > Dashboard:** MRR, receita do mês, ticket médio, receita de comissão base **vs.** spread de financiamento, churn de receita, próximos repasses.
- **Onboarding de recebimento (KYC):** wizard de criação da subconta Asaas — dados da empresa/CPF, conta bancária, upload de documentos, status do KYC ao vivo. Bloqueia publicação de tiers pagos até `active`.
- **Transações:** tabela filtrável (status, método, período, membro), detalhe com a decomposição contábil completa, ações **reembolsar** (total/parcial), ver no Asaas.
- **Assinaturas:** lista por status, detalhe (ciclos, próxima cobrança, parcelas restantes), ações cancelar/pausar/retomar/trocar tier.
- **Parcelados (installment plans):** acompanhamento das parcelas, status delinquent/defaulted, acesso x parcelas restantes.
- **Dunning / inadimplentes:** fila de `past_due`/`delinquent`, ações de cobrança, troca de cartão assistida.
- **Reembolsos & disputas:** chargebacks abertos, evidências, prazos.
- **Repasses:** extrato da subconta, saques, agendamento.
- **Conciliação:** divergências Asaas × Stanbase, resolução manual.
- **Configurações de billing:** grace period, payout schedule, cupons. (Comissão 7,99% e juros 3,49% **não** editáveis — são globais.)

#### 10.4.2 Membro (front hosted + SDK)

- **Página de tiers / checkout:** preços por período; toggle de parcelamento (tri/sem/anual) com **simulador de parcelas** (mostra valor da parcela, total e juros — transparência modelo Hotmart); seleção Pix / cartão / parcelado.
- **Tela de Pix:** QR + copia-e-cola + contador de expiração + botão "gerar novo Pix".
- **Tela de cartão:** iframe/tokenização Asaas (PCI no Asaas), parcelas, confirmação.
- **Área do membro > Pagamentos:** assinatura atual, próxima cobrança, método, histórico de transações/recibos, **trocar cartão**, **atualizar Pix Automático**, cancelar/pausar.
- **Estados de erro:** Pix expirado, cartão recusado, em atraso (CTA atualizar pagamento), parcela em atraso.
- **Componentes SDK:** `<TierCheckout/>` (modo híbrido/embed), simulador de parcelamento embutido.

---

### 10.5 Integrações externas

- **Asaas (core):** subcontas/marketplace (KYC, walletId, split), cobranças (Pix, cartão à vista, parcelado), antecipação de recebíveis, Pix Automático, assinaturas recorrentes, transferências/saques, estornos, webhooks. **Camada adapter PSP-agnóstica** (`PaymentProvider` interface) para futura troca (Pagar.me escala, Stripe internacional) sem reescrever a aplicação.
- **Supabase:** Postgres (RLS por `org_id`), pgmq (fila de webhooks/jobs), pg_cron (dunning, renovação, conciliação), Vault (cifrar `api_key_ref`, dados bancários), Realtime (status de pagamento ao vivo no checkout/admin).
- **Wallet (Apple/Google):** push de atualização de status do passport quando membership ativa/inativa por pagamento (depende do domínio passport).
- **Discord/Telegram/WhatsApp:** sync de entitlements/cargos quando acesso é concedido/revogado por pagamento (depende de community-channels).
- **Comunicação (e-mail/push/WhatsApp):** réguas de dunning, recibos, lembretes de Pix/renovação (depende de communication).
- **NFS-e (pós-MVP):** módulo de nota fiscal (Asaas ou provedor) para emissão pela org e NF da comissão Stanbase.

---

### 10.6 Épicos & tarefas

#### Épico E1 — Camada PSP-agnóstica + cliente Asaas
- T1.1 Definir interface `PaymentProvider` (charge, subscription, installment, refund, transfer, subaccount, webhook-verify). **M**
- T1.2 Implementar `AsaasProvider` (REST client, auth por API key da subconta, retries/timeout, mapeamento de erros). **L**
- T1.3 Vault/cifragem de credenciais Asaas (`api_key_ref`, dados bancários) + helpers. **M**
- T1.4 Sandbox Asaas: ambiente de testes, contas fake, seeds. **S**

#### Épico E2 — Subcontas & KYC/onboarding
- T2.1 `fn:subaccount-create` + tabela `asaas_subaccounts` + estados. **M**
- T2.2 Wizard de KYC no admin (form + upload documentos + status ao vivo). **L**
- T2.3 `fn:subaccount-kyc-sync` (webhook `ACCOUNT_STATUS_*` + job reconciliação). **M**
- T2.4 Gate: bloquear checkout/publicação de tier pago se subconta ≠ `active`. **S**

#### Épico E3 — Tabela Price / parcelamento (cálculo)
- T3.1 `platform_billing_settings` (singleton) + seed dos parâmetros. **S**
- T3.2 Gerador da tabela `installment_coefficients` (Price, regra `max(Hotmart,Asaas)`). **M**
- T3.3 `fn:installment-quote` + `GET /v1/checkout/installment-quote`. **M**
- T3.4 Testes de paridade de centavos com o checkout Asaas (golden tests). **M**

#### Épico E4 — Checkout & criação de cobranças
- T4.1 `fn:checkout-create` (Pix à vista) + split 7,99%. **L**
- T4.2 Cartão à vista (tokenização Asaas client-side + cobrança c/ split). **M**
- T4.3 Cartão parcelado (installment + split por parcela + antecipação). **L**
- T4.4 Pix Automático (autorização + recorrência) + fallback. **L**
- T4.5 Cupons/descontos no checkout. **M**
- T4.6 Capacity/vagas + idempotência (`Idempotency-Key`). **M**
- T4.7 Telas de checkout (Pix QR/expiração, cartão, simulador de parcelas). **L**

#### Épico E5 — Contabilidade por transação
- T5.1 Engine de cálculo (gross, customer_interest, base_commission, psp_fee, psp_anticipation_fee, financing_spread, net_org, stanbase_revenue). **L**
- T5.2 Persistência em `transactions`/`installment_plans` + constraints/índices. **M**
- T5.3 Testes unitários da decomposição (Pix, à vista, 2x..12x, com cupom). **M**

#### Épico E6 — Webhooks Asaas (entrada)
- T6.1 `fn:asaas-webhook-handler` (verificação de assinatura, dedup `asaas_event_id`, enfileira). **M**
- T6.2 `fn:asaas-webhook-processor` (aplica efeitos por tipo de evento) + DLQ/replay. **L**
- T6.3 Idempotência fim-a-fim (webhook duplicado não duplica efeito). **M**

#### Épico E7 — Assinaturas & ciclo de vida
- T7.1 `POST/GET/cancel/pause/resume/change-tier` + máquina de estados. **L**
- T7.2 Proração de upgrade/downgrade (meio de ciclo). **L**
- T7.3 `job:renewal-runner` (renova recorrentes; expira parcelados/não-renováveis). **M**
- T7.4 Troca de cartão (`payment-method`) + cobrança imediata do em-aberto. **M**

#### Épico E8 — Dunning & inadimplência
- T8.1 `job:dunning-runner` (régua D+0/1/3/5, lembretes multicanal). **M**
- T8.2 `job:grace-expirer` (past_due → unpaid → revoga acesso/entitlements). **M**
- T8.3 `job:installment-monitor` (delinquent/defaulted; política de acesso). **M**
- T8.4 Tela admin de inadimplentes + ações. **M**

#### Épico E9 — Reembolsos, chargebacks, conciliação, payouts
- T9.1 `fn:refund-process` (total/parcial, reverte split, política de acesso). **L**
- T9.2 Chargebacks (`disputes`, congelar payout, evidências, ganho/perda). **L**
- T9.3 `fn:payout-withdraw` + `payouts` + agendamento. **M**
- T9.4 `job:reconciliation` (bate Stanbase × Asaas → exceptions) + tela. **L**

#### Épico E10 — Relatórios financeiros & front membro
- T10.1 `GET /v1/reports/revenue` (MRR, churn receita, comissão vs spread). **M**
- T10.2 Dashboard admin Receita & Pagamentos. **M**
- T10.3 Área do membro > Pagamentos (histórico, recibos, trocar cartão, cancelar). **M**

#### Épico E11 — NF/fiscal (pós-MVP)
- T11.1 Emissão NFS-e via Asaas/provedor (pela org). **L**
- T11.2 NF da comissão Stanbase para a org. **M**

---

### 10.7 Dependências

| Depende de | Por quê |
|---|---|
| **fundacao** | Postgres, RLS por `org_id`, pgmq, pg_cron, Vault, migrations, esqueleto API `/v1`/OpenAPI. |
| **auth-rbac** | Permissões por org (quem reembolsa, quem configura billing, quem saca); JWT/escopos da API. |
| **member-identity** | `member_id` e relação pessoa×org — transação/assinatura referem um member. |
| **tiers-perks** | Preço, período, `installments_enabled`, capacity, entitlements concedidos/revogados por pagamento. |
| **integrations-framework** | Connection cifrada da subconta Asaas (padrão de credenciais/OAuth/tokens). |
| **webhooks** | Webhooks de saída (`subscription.payment_*`, `payout.paid`) e infra de entrega confiável. |
| **communication** | Réguas de dunning, recibos, lembretes de Pix/renovação (e-mail/push/WhatsApp). |
| **passport** | Push de atualização do passe quando o status do membership muda por pagamento. |
| **community-channels** | Sync de cargos/grupos quando acesso é concedido/revogado por pagamento/inadimplência. |
| **crm** | Timeline (pagamentos, reembolsos, chargebacks), LTV/MRR, próxima cobrança, inadimplência no perfil 360º. |
| **public-api / mcp** | Expor checkout/assinaturas/transações como contrato `/v1` e tools MCP (paridade headless). |
| **security-lgpd** | PCI delegado ao Asaas, cifragem de credenciais, preservação de registros financeiros em anonimização. |
| **observability-qa** | Monitorar webhooks/jobs/DLQ, conciliação, alertas de falha de cobrança. |

Domínios que dependem de **payments-billing**: events-tickets (venda de ingressos usa o mesmo motor de transação/split), communication (gifts pagos), content-gating/tiers (acesso condicionado a pagamento ativo).

---

### 10.8 Riscos & decisões técnicas

1. **Paridade de centavos (juros) com o Asaas.** Calcular juros nós mesmos e o Asaas calcular diferente gera divergência no que o cliente paga. **Mitigação:** tabela Price pré-computada + golden tests contra o sandbox Asaas; idealmente, deixar o Asaas calcular o parcelamento e nós apenas refletir, ou travar a fórmula contratualmente. **Decisão pendente** (openQuestion).
2. **Idempotência de webhooks.** Asaas pode reenviar eventos; sem dedup, dupla cobrança/dupla ativação. **Mitigação:** `asaas_event_id` UNIQUE + `asaas_payment_id` UNIQUE + processamento via fila idempotente.
3. **Split sobre juros vs. sobre plano.** A comissão 7,99% incide só sobre o **valor do plano**, não sobre os juros. Configurar o split do Asaas para refletir isso por parcela é delicado (o Asaas aplica % por cobrança). **Mitigação:** modelar split em valor absoluto por parcela quando possível; validar com Asaas.
4. **Antecipação: risco de crédito é da Stanbase.** Org recebe antecipado; se o cliente para de pagar parcelas, a Stanbase come o prejuízo (já contabilizado no spread). Decidir política de acesso do parcelado inadimplente (§10.1.5) — recomendado **manter acesso** (org já foi paga), perseguir cobrança no cartão.
5. **Pix Automático maturidade.** Cobertura por banco ainda irregular em 2026. **Mitigação:** fallback automático para cartão recorrente / Pix manual com lembrete.
6. **Revalidar 3,49% a.m. contra contrato Asaas** (openQuestion §30.1 STANBASE) — se a antecipação negociada subir acima de 3,49%, a regra `max` eleva o juros ao cliente. Parâmetro global recomputável (`job:coefficients-recompute`).
7. **Proração de downgrade no meio do ciclo** — crédito vira saldo/desconto na próxima cobrança ou não há reembolso? Edge case de produto (openQuestion).
8. **Reembolso parcial × acesso** — parcial não deve zerar acesso automaticamente; política configurável.
9. **Chargeback após acesso consumido** — reunir evidências de entrega (logs de acesso, login, consumo de conteúdo) para contestar.
10. **KYC reprovado bloqueia receita** — comunicar claramente e oferecer caminho de correção; não deixar a org "presa".
11. **Fuso/competência fiscal** — transações em UTC; relatórios fiscais por competência local (America/Sao_Paulo).
12. **Conciliação como rede de segurança** — webhooks falham; o job de reconciliação diário é a fonte de verdade de último recurso.

---

### 10.9 Escopo MVP vs. depois

**MVP (Fase 1 — STANBASE §29):**
- Subconta Asaas por org + KYC/onboarding (gate de checkout).
- Checkout: **Pix à vista** + **cartão à vista** + **cartão parcelado até 12×** (tabela Price + simulador).
- Assinaturas recorrentes (mensal/tri/sem/anual) à vista/cartão recorrente; **plano parcelado = compra avulsa sem auto-renovação**.
- Split 7,99% + antecipação + contabilidade por transação completa.
- Webhooks Asaas (entrada) idempotentes + máquina de estados de assinatura/parcela.
- Dunning + grace period + revogação de acesso; troca de cartão; Pix expirado → novo Pix.
- Reembolso total e parcial; payouts/repasses; conciliação básica.
- Relatórios financeiros básicos + área do membro (histórico, trocar cartão, cancelar).

**Depois (pós-MVP):**
- **Pix Automático** para recorrência (assim que cobertura/contrato permitir) — alta prioridade pela margem.
- **Chargebacks** com fluxo de evidências completo (MVP: registrar e congelar).
- **NF/fiscal** (emissão NFS-e pela org + NF da comissão Stanbase).
- Boleto (opcional).
- Conciliação avançada / automações de exceção.
- Cupons avançados, trials sofisticados.
- Multi-PSP real (Pagar.me/Stripe) — a interface adapter já fica pronta no MVP, mas só Asaas é implementado.
