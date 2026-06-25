## 90. Roadmap, Sequenciamento & Estimativas

> Documento de planejamento de engenharia. Consolida o grafo de dependências entre os 24 domínios (`05-fundacao` … `28-observability-qa`), define o **caminho crítico**, organiza o trabalho em **milestones (M0 → MVP → V1 → V2 → V3)**, traça a **linha de corte do MVP** e mapeia **riscos de cronograma**, **paralelização** e **composição de time**.
>
> Fontes de verdade: §29 (Roadmap e fases) e §30 (Decisões) do `STANBASE.md`, mais o `dependsOn` de cada domínio. Onde §29 propõe semanas, este documento refina em ondas paralelizáveis com a equipe real.
>
> **Decisões já travadas que ancoram o sequenciamento** (não são pontos de design abertos aqui):
> - **PSP de lançamento = Asaas** (split nativo via subcontas), arquitetura **PSP-agnóstica**.
> - **Member ID = 8 caracteres, sem dígito verificador**, alfabeto sem ambíguos, alternando letra/dígito.
> - **Passport = Apple Wallet + Google Wallet, os dois desde o MVP.**
> - **1 membership por org** (quem quer vários cria várias orgs sob a mesma Conta).
> - **Parcelamento até 12×**, só em tri/semestral/anual, **juros ao cliente = max(Hotmart 3,49% a.m.; Asaas) = 3,49% a.m.**, pass-through, **sem renovação automática** de plano parcelado.
> - **Stack:** monorepo, Supabase (Postgres + Auth + RLS multi-tenant + Storage + Realtime), Edge Functions (TS/Deno), React+TS, OpenAPI/Swagger, MCP.
> - **i18n:** pt-BR, en-US, es desde a fundação (impacta schema/tokens cedo).
> - **Sem app nativo na v0** (PWA + Passport nativo via Wallet bastam).

---

### 90.1 Grafo de dependências & ordem de construção

O `dependsOn` declarado nos domínios é **muito denso e parcialmente circular** (ex.: `crm` depende de `payments-billing` e vice-versa; `tiers-perks` ↔ `payments-billing` ↔ `passport`). Isso reflete acoplamento de *runtime/feature* ("usa dados de"), **não** ordem de build estrita. Para sequenciar, separamos dois tipos de dependência:

- **Dependência dura (build-blocking):** B não compila/não roda sem o contrato de A. Define a ordem.
- **Dependência mole (feature/runtime):** B consome dados de A em produção, mas pode ser construído contra uma interface/stub e integrado depois. Quebra os ciclos.

#### 90.1.1 Camadas topológicas (ordem de construção)

Reduzindo os ciclos às dependências duras, emergem **camadas**. Tudo numa camada pode (em tese) começar quando a camada anterior expõe contratos estáveis.

```
CAMADA 0 — Chão de fábrica (nada antes)
  fundacao ───────────────────────────────┐
                                           │ (monorepo, Supabase, RLS por org_id,
                                           │  geração de tipos DB→TS e OpenAPI→SDK,
                                           │  CI/CD, pgmq/filas, Member ID generator)
CAMADA 1 — Identidade & contrato base
  auth-rbac ◄── fundacao
  design-system ◄── fundacao            (tokens, theming white-label, primitives)

CAMADA 2 — Núcleo do domínio
  member-identity ◄── fundacao, auth-rbac        (Member ID, perfil, 1 membership/org)
  public-api      ◄── fundacao, auth-rbac        (/v1, OpenAPI, Swagger)

CAMADA 3 — Monetização & entitlements (o coração)
  tiers-perks      ◄── member-identity, auth-rbac
  payments-billing ◄── tiers-perks, member-identity (Asaas, split, parcelamento 12×)
    └─ ciclo tiers-perks ↔ payments-billing resolvido com contrato de
       "entitlement" + eventos (assinatura paga → ativa entitlement do tier)

CAMADA 4 — Credencial & validação física
  passport            ◄── member-identity, tiers-perks, payments-billing
  verification-checkin ◄── passport, member-identity

CAMADA 5 — Apps & superfícies (consomem tudo acima)
  admin-app  ◄── design-system, auth-rbac, public-api, crm, tiers, payments, ...
  member-app ◄── design-system, auth-rbac, member-identity, tiers, payments, passport
  crm        ◄── member-identity, payments, tiers (timeline/segmentos)

CAMADA 6 — Distribuição de valor (features de engajamento)
  content-gating, community-channels, events-tickets,
  communication, integrations-framework

CAMADA 7 — Plataforma para devs & automação
  webhooks ◄── public-api, integrations-framework
  superadmin ◄── auth-rbac, payments, crm

CAMADA 8 — Inteligência & extensões (pós-V1)
  ai-layer, mcp, hall-of-fame

CAMADA TRANSVERSAL (atravessa todas, desde a Camada 0):
  security-lgpd  — RLS, criptografia, consentimento, DSR. Começa na fundação.
  observability-qa — logs/traces/métricas, testes, dashboards. Começa na fundação.
```

> **Regra prática de sequenciamento:** `security-lgpd` e `observability-qa` **não são fases finais** — são esteiras transversais. O domínio entregável é o "fechamento" (auditoria de conformidade, dashboards consolidados, gate de QA), mas suas *fundações* (RLS, segredo nunca no browser, logging estruturado, idempotência) já nascem na Camada 0. Tratá-los como "depois" é o erro clássico que vira dívida impagável.

#### 90.1.2 Como quebramos os ciclos do `dependsOn`

| Ciclo declarado | Como destravamos |
|---|---|
| `tiers-perks` ↔ `payments-billing` | `tiers-perks` define o **contrato de entitlement** (tier → perks). `payments-billing` emite **evento de cobrança paga**; um handler ativa o entitlement. Constrói-se tiers com pagamento *stubbed*, depois liga. |
| `crm` ↔ `payments-billing`/`tiers`/`communication` | CRM consome via **views/eventos** (timeline alimentada por eventos de pagamento, tier, comunicação). CRM básico (lista + perfil + tags) não bloqueia ninguém; CRM 360º entra em V1. |
| `member-identity` ↔ (quase tudo, incl. `crm`, `admin-app`) | O `dependsOn` largo de `member-identity` é runtime. O **núcleo** (Member ID + perfil + 1 membership/org) só precisa de `fundacao` + `auth-rbac`. Constrói cedo. |
| `passport` ↔ `verification-checkin` ↔ `events-tickets` | Passport gera o `.pkpass`/objeto Google com um `member_id` + QR. Verificação lê o QR via Edge Function pública. Eventos/ingressos reaproveitam o mesmo passe depois — não bloqueiam o passe de membership. |
| `design-system` ↔ `admin-app`/`member-app` | Design system entrega tokens+primitives; os apps consomem. O `dependsOn` reverso (DS → apps) é só para harvesting de componentes; constrói-se DS primeiro com um set mínimo e cresce com os apps. |
| Tudo ↔ `webhooks`/`public-api` | API e webhooks expõem o que já existe. São **horizontais tardias** — a cada domínio novo, adiciona-se rota/evento. O *framework* (router `/v1`, assinatura HMAC, retry/DLQ) nasce cedo (na fundação/Camada 2); a *cobertura* cresce incrementalmente. |

---

### 90.2 Caminho crítico

O caminho crítico é a cadeia de dependências **duras** mais longa que precisa estar pronta para **lançar o MVP com valor** (cobrar e entregar credencial validável). Tudo fora dele pode, em princípio, ser paralelizado ou cortado.

```
fundacao
   └─► auth-rbac
          └─► member-identity (Member ID, 1 membership/org)
                 └─► tiers-perks (engine de entitlements)
                        └─► payments-billing (Asaas: split, assinatura, parcelamento 12×)
                               └─► passport (Apple + Google Wallet)
                                      └─► verification-checkin (rota pública + check-in)
                                             └─► member-app + admin-app (fechamento E2E)
```

**Itens de risco no caminho crítico (não comprimíveis por dinheiro/gente):**

1. **`payments-billing` (Asaas).** É o nó mais pesado (effort XL) e o mais cheio de incógnitas externas: onboarding de subcontas (split), KYC, webhooks do Asaas, conciliação, e a **regra de parcelamento até 12× com juros = max(3,49% a.m.; Asaas)**. A decisão em aberto §30.1 ("revalidar 3,49% contra o contrato Asaas") é uma **dependência externa de negócio** que precisa ser resolvida antes do go-live de cobrança. Mitigação: começar a integração Asaas em sandbox **já na Camada 2** (em paralelo a tiers-perks), antes de o caminho crítico chegar nela.
2. **`passport`.** Depende de **certificados externos**: Apple `Pass Type ID` (decisão §30.6: Stanbase como publisher, um Pass Type ID com arte por org) e credenciais Google Wallet. Provisionar esses certificados/contas é *lead time* externo (dias a semanas na Apple). Mitigação: abrir as contas Apple Developer / Google Wallet API **na semana 1**, em paralelo à fundação.
3. **`verification-checkin`.** Rota pública (decisão §30.4: `verify.stanbase.com/{id}`) que lê com role anônima — superfície de segurança sensível. Precisa de design de RLS/Edge Function que exponha **só o mínimo**. Está no caminho crítico porque é o "momento da verdade" do produto (porteiro valida o membro).

> **Caminho crítico ≈ MVP.** Por construção, o MVP foi desenhado como o próprio caminho crítico. Toda a Camada 6+ (community, events, communication, integrations, AI, hall-of-fame, mcp) está **fora** dele.

---

### 90.3 Fases / Milestones

Estimativas em **semanas-dev** (esforço total somado; com paralelização o *calendário* é menor — ver §90.6) e **T-shirt** por domínio (S≈1, M≈2, L≈3–4, XL≈6–8 semanas-dev). O calendário-alvo assume o time da §90.7.

#### M0 — Fundação & Arquitetura
**Domínios:** `fundacao` (XL) · fundações transversais de `security-lgpd` e `observability-qa` · provisionamento externo (Asaas sandbox, Apple Pass Type ID, Google Wallet).

| | |
|---|---|
| **Critério de entrada** | Doc aprovado (§30 resolvido o suficiente). Contas de cloud/Supabase criadas. |
| **Escopo** | Monorepo + Supabase (DB, Auth, RLS multi-tenant por `org_id`). Modelo de dados núcleo. **Gerador de Member ID** (8 chars, sem DV). Esqueleto `/v1` + OpenAPI + Swagger. Geração de tipos DB→TS e OpenAPI→SDK. CI/CD. Infra de filas (`pgmq`) + idempotência. Logging estruturado + tracing base. RLS "isolamento por org é inviolável" como teste de regressão. |
| **Critério de saída** | Um app interno consegue: autenticar (stub), criar org, gerar Member ID, e uma Edge Function `/v1` responde com `org_id` derivado da credencial. Pipeline de migrations roll-forward funcionando. Testes de isolamento cross-org passando. |
| **Esforço** | ~6–8 semanas-dev. **Calendário: ~2 semanas** (alinhado a §29 Fase 0). |
| **Provisionamentos externos disparados aqui** | Asaas (contrato + sandbox + revalidar 3,49%), Apple Developer + Pass Type ID, Google Wallet API. |

#### MVP — Membership monetizável e validável (linha de corte em §90.4)
**Domínios:** `auth-rbac` (XL) · `design-system` (L, set mínimo) · `member-identity` (L) · `public-api` (L, cobertura do núcleo) · `tiers-perks` (XL) · `payments-billing` (XL, Asaas) · `passport` (L) · `verification-checkin` (XL) · `admin-app` (XL, módulos do núcleo) · `member-app` (XL) · `superadmin` (L, mínimo p/ operar) · CRM **básico** (subset de `crm`).

| | |
|---|---|
| **Critério de entrada** | M0 fechado. Asaas sandbox respondendo a webhooks. Pass Type ID e Google Wallet provisionados. Tokens de design da 1ª org. |
| **Escopo (fluxo E2E)** | Conta cria org → configura **tiers & perks** → membro faz login (social) → **checkout de tier** (Asaas, com split e parcelamento até 12× nos períodos elegíveis) → assinatura ativa → entitlement liberado → **Passport** emitido (Apple + Google) → membro mostra QR → porteiro **valida na rota pública** e faz **check-in**. Admin vê membros, tiers, receita básica. |
| **Critério de saída** | Uma org real cobra um membro real em produção, o passe aparece na Wallet, e a validação pública funciona offline-resiliente. Conciliação Asaas confere. RLS auditada. Smoke E2E verde no CI. Runbook de incidente de pagamento. |
| **Esforço** | ~38–46 semanas-dev. **Calendário: ~4–6 semanas** com o time paralelizado (alinhado a §29 Fase 1, com folga). |

#### V1 — CRM 360º, comunicação e canais de valor
**Domínios:** `crm` completo (XL) · `communication` (XL) · `content-gating` (L) · `community-channels` (L) · `events-tickets` (XL) · `integrations-framework` (XL) · `webhooks` (L) · fechamento de `security-lgpd` (XL) e `observability-qa` (L).

| | |
|---|---|
| **Critério de entrada** | MVP em produção com ≥1 org pagante. Eventos de domínio (pagamento, tier, check-in) já emitidos e disponíveis para o CRM consumir. |
| **Escopo** | CRM 360º (timeline, tags, segmentos por regra, notas, import/export, LTV/RFM). Comunicação (e-mail/push), campanhas por segmento, presentes. Conteúdo gated. Comunidade/canais (Discord). Eventos & ingressos (reaproveitando Passport). Framework de integrações + 1ª leva (Sympla/Ingresse, YouTube/Twitch). Webhooks públicos + assinatura HMAC + retry/DLQ. Conformidade LGPD fechada (DSR, consentimento, retenção). |
| **Critério de saída** | Org consegue segmentar a base e disparar campanha; vender ingresso de evento usando o mesmo passe; publicar conteúdo gated por tier; receber webhook de assinatura. Auditoria LGPD assinada. Dashboards de observabilidade consolidados. |
| **Esforço** | ~30–38 semanas-dev. **Calendário: ~4 semanas** (alinhado a §29 Fases 2 e parte da 4). |

#### V2 — Inteligência (IA-first) & plataforma para devs
**Domínios:** `ai-layer` (XL) · `mcp` (L) · ampliação de `public-api`/`webhooks` (SDKs, Zapier) · cobertura completa de OpenAPI.

| | |
|---|---|
| **Critério de entrada** | V1 estável com volume de dados suficiente (membros, pagamentos, eventos) para alimentar modelos. Provedor de LLM definido com DPA/LGPD (§30.7). |
| **Escopo** | Segmentação automática, churn score, sugestão de perk, copy na voz da marca, qualificação. Copilot do admin. MCP server. API pública estável + webhooks + Zapier + SDKs. Modo headless/embeds documentado. |
| **Critério de saída** | Admin recebe sugestões acionáveis da IA; um terceiro integra via API/MCP/Zapier sem suporte humano. |
| **Esforço** | ~16–20 semanas-dev. **Calendário: ~4 semanas** (alinhado a §29 Fases 3–4). |

#### V3 — Engajamento avançado & refinamentos
**Domínios:** `hall-of-fame` (L) · perks de nicho (Steam/Riot via integrations) · domínio próprio · avaliação de app nativo.

| | |
|---|---|
| **Critério de entrada** | V2 entregue; demanda de mercado por gamificação/ranking validada. |
| **Escopo** | Rankings, conquistas, gamificação. Integrações de nicho. Domínio próprio por org. Reavaliar app nativo (PWA bastou até aqui). |
| **Critério de saída** | Hall of Fame ativo em ≥1 org; decisão go/no-go de app nativo registrada. |
| **Esforço** | ~8–12 semanas-dev. **Calendário: ~3 semanas** (alinhado a §29 Fase 5). |

---

### 90.4 Linha de corte do MVP

**Princípio:** o MVP é o mínimo que permite a uma comunidade **cobrar receita recorrente e entregar uma credencial validável** — o loop de valor completo. Tudo que não fecha esse loop fica fora.

#### ✅ Dentro do MVP (o loop mínimo de valor)

| Domínio | Por que é mínimo viável |
|---|---|
| `fundacao` | Sem chão não há nada. |
| `auth-rbac` | Conta, orgs, papéis, seletor de org (1 Conta ↔ N orgs). |
| `member-identity` | Member ID (8 chars, sem DV) + perfil + **1 membership/org**. É a identidade que tudo referencia. |
| `tiers-perks` | A engine de monetização: define o que se vende e o que se entrega (entitlements). |
| `payments-billing` (Asaas) | Cobrar de verdade: assinatura, **split nativo via subconta**, **parcelamento até 12× a 3,49% a.m.**, sem renovação automática de plano parcelado. |
| `passport` (Apple+Google) | A credencial na carteira — o "produto físico" percebido pelo membro. Os dois desde o MVP (decisão travada). |
| `verification-checkin` | A rota pública `verify.stanbase.com/{id}` + check-in: o momento da verdade na portaria. |
| `admin-app` (núcleo) | Org, tiers/perks, membros, receita básica. Só os módulos do loop. |
| `member-app` (PWA) | Login social, checkout, área do membro, passe. Sem app nativo (PWA basta na v0). |
| `crm` **básico** | Lista de membros + perfil + tags. (O 360º é V1.) |
| `superadmin` (mínimo) | Stanbase precisa operar/dar suporte às orgs no dia 1. |
| `public-api` (núcleo) | Esqueleto `/v1` + OpenAPI; cobertura só do que o MVP expõe. |
| `design-system` (mínimo) | Tokens + primitives white-label para vestir 1 org. |
| **transversais** | Fundações de `security-lgpd` (RLS, segredos fora do browser, consentimento básico) e `observability-qa` (logs, smoke E2E). |

#### ❌ Fora do MVP (corte explícito)

| Domínio / capacidade | Entra em | Justificativa do corte |
|---|---|---|
| `crm` 360º (timeline, segmentos por regra, LTV/RFM, import/export) | V1 | CRM básico já sustenta o loop; o 360º precisa de histórico de eventos acumulado. |
| `communication` (campanhas, e-mail/push, presentes) | V1 | Não é pré-requisito para cobrar/validar. Alto valor, mas posterior. |
| `content-gating` (conteúdo exclusivo) | V1 | Perk adicional; o tier já entrega valor via passe/perks físicos. |
| `community-channels` (Discord etc.) | V1 | Integração externa; não bloqueia o loop. |
| `events-tickets` | V1 | Reaproveita o Passport; sofisticação que vem depois do membership funcionar. |
| `integrations-framework` (Sympla/Ingresse/YouTube/Twitch) | V1 | Framework + 1ª leva; nada no loop mínimo depende dele. |
| `webhooks` públicos (cobertura) | V1 | O *framework* nasce cedo; a *exposição pública* contratada com parceiros é V1. |
| `ai-layer` | V2 | Precisa de dados acumulados + LLM/DPA definido (§30.7). `mvpIncluded:false`. |
| `mcp` | V2 | Depende de `public-api` madura + `ai-layer`. `mvpIncluded:false`. |
| `hall-of-fame` | V3 | Engajamento avançado, não monetização. `mvpIncluded:false`. |
| App nativo iOS/Android | reavaliar V3 | PWA + Passport nativo na Wallet bastam na v0 (§30.2). |
| WhatsApp (API oficial) | V1+ (dentro de `communication`) | Lead time de aprovação de templates BSP; e-mail/push cobrem o MVP. |
| i18n en-US/es **na UI** | progressivo | Schema e tokens já nascem multi-idioma em M0; tradução completa da UI é incremental. |

---

### 90.5 Riscos de cronograma

| # | Risco | Camada/Domínio | Impacto | Mitigação |
|---|---|---|---|---|
| R1 | **Lead time de certificados Apple/Google** (Pass Type ID, Wallet API) trava `passport`, que está no caminho crítico. | Camada 4 | Atraso direto no MVP. | Abrir contas e provisionar certificados **na semana 1** (M0), antes de chegar o turno de `passport`. |
| R2 | **Integração Asaas mais complexa que o previsto** (onboarding de subcontas, KYC, conciliação, edge cases de split). XL no caminho crítico. | Camada 3 | Maior fonte de derrapagem do MVP. | Começar em sandbox **em paralelo a `tiers-perks`** (Camada 2/3). Isolar atrás de interface PSP-agnóstica para não acoplar o domínio à API do Asaas. |
| R3 | **Regra de juros `max(3,49% a.m.; Asaas)` ainda não revalidada** contra o contrato (§30.1) — dependência externa de negócio. | payments-billing | Bloqueia go-live de cobrança parcelada. | Resolver a negociação **durante M0/MVP-início**; codar a taxa como parâmetro configurável (`platform_billing_settings`) para absorver mudança sem redeploy. |
| R4 | **Rota pública de validação** é superfície anônima sensível; erro de RLS vaza dados de membros (incidente sev-máx). | verification-checkin | Segurança + reputação. | Expor só o mínimo via Edge Function/view dedicada; teste de regressão de vazamento cross-org; revisão de segurança obrigatória antes do go-live. |
| R5 | **Ciclos no `dependsOn`** levam o time a esperar por dependências que poderiam ser stubbed. | tiers↔payments, crm↔* | Serialização desnecessária → calendário infla. | Contratos/eventos primeiro (§90.1.2); construir contra stubs; integrar por último. |
| R6 | **`security-lgpd` / `observability-qa` tratados como fase final.** | transversais | Dívida impagável; retrabalho de RLS/logging. | Fundações transversais já em M0; "domínio" só fecha auditoria/dashboards. |
| R7 | **Apps (admin/member) viram gargalo** por dependerem de quase tudo (Camada 5). | admin-app, member-app | Frente de front sobrecarregada no fim do MVP. | Frente de front começa o shell/design-system em M0/MVP-início e integra cada domínio assim que seu contrato `/v1`/`supabase-js` estabiliza. |
| R8 | **Provedores definitivos de e-mail/push e LLM** indefinidos (§30.7). | communication, ai-layer | Bloqueia V1/V2, não o MVP. | Decidir durante o MVP; abstrair atrás de adapter. |
| R9 | **i18n retrofit** se schema/tokens não nascerem multi-idioma. | transversal | Retrabalho amplo. | Modelar pt-BR/en-US/es desde M0 (decisão travada). |

---

### 90.6 Oportunidades de paralelização

A densidade do grafo engana: várias frentes rodam em paralelo se os contratos forem definidos cedo.

- **M0:** enquanto a frente de **plataforma** monta monorepo/Supabase/RLS/CI, a frente de **front** já levanta o `design-system` (tokens, primitives) e o **shell** do admin (seletor de org, navegação stub). Provisionamentos externos (Asaas, Apple, Google) correm em background sem ocupar dev.
- **MVP (3 trilhas em paralelo após `member-identity` estabilizar):**
  - **Trilha A — Monetização:** `tiers-perks` → `payments-billing` (Asaas sandbox começa cedo). É o caminho crítico; recebe os devs mais sêniores.
  - **Trilha B — Credencial:** `passport` (assim que Member ID existe) → `verification-checkin`. Depende de A só para o entitlement, mas o passe básico de membership não espera o checkout estar 100%.
  - **Trilha C — Superfícies:** `admin-app` + `member-app` integram A e B incrementalmente; `crm` básico e `superadmin` mínimo entram aqui.
- **V1:** `crm` 360º, `communication`, `content-gating`, `community-channels`, `events-tickets`, `integrations-framework` são **largamente independentes entre si** — consomem eventos do núcleo. É a fase mais paralelizável: até 5 frentes simultâneas limitadas só por gente.
- **Transversais:** `security-lgpd` e `observability-qa` rodam continuamente; idealmente um(a) responsável dedicado(a) cruzando todas as frentes.

**Limites de paralelização:** o caminho crítico `payments-billing` é **serial e XL** — jogar mais gente nele tem retorno decrescente (Brooks). O ganho de paralelização está em B e C, não em comprimir A.

---

### 90.7 Composição de time sugerida

Time enxuto de produto, full-stack TS (React + Supabase/Deno), organizado por **frentes**, não por camadas.

| Papel | Qtd | Foco principal | Frente |
|---|---|---|---|
| **Tech Lead / Arquiteto** | 1 | Fundação, contratos `/v1`, RLS, revisão cross-frente, caminho crítico. Owner do grafo. | Plataforma + crítico |
| **Eng. Plataforma/Backend** | 1 | `fundacao`, filas/idempotência, `public-api`, geração de tipos, CI/CD. | Plataforma |
| **Eng. Pagamentos (sênior)** | 1 | `payments-billing` (Asaas, split, parcelamento), `tiers-perks` engine. **Dono do caminho crítico.** | Trilha A |
| **Eng. Credencial/Mobile-web** | 1 | `passport` (Apple+Google), `verification-checkin`, PWA do member-app. | Trilha B |
| **Eng. Front (×2)** | 2 | `design-system`, `admin-app`, `member-app`, `crm` UI. | Trilha C |
| **Eng. Full-stack (V1)** | +1–2 | `communication`, `events-tickets`, `community`, `integrations` (entram a partir do MVP tardio/V1). | V1 |
| **Segurança/QA (parcial)** | ~0.5 | `security-lgpd` + `observability-qa` transversais, gates de release. | Transversal |

**Como as frentes se montam por milestone:**

- **M0 (~2 sem):** TL + Eng. Plataforma na fundação; 1 Eng. Front no design-system/shell; Eng. Pagamentos já abrindo Asaas sandbox; Eng. Credencial provisionando Apple/Google. → ~4 pessoas ativas.
- **MVP (~4–6 sem):** Trilha A (Eng. Pagamentos + TL revisando) ‖ Trilha B (Eng. Credencial) ‖ Trilha C (2 Eng. Front) ‖ Plataforma sustentando `/v1` e CRM básico. QA/Sec cruzando. → 6 pessoas.
- **V1 (~4 sem):** abrir 1–2 full-stack para as frentes paralelas (communication/events/integrations); front migra para admin 360º/CRM. → 7–8 pessoas.
- **V2/V3:** 1 frente de IA/plataforma-devs (pode ser especialista de IA contratado) + manutenção do núcleo.

**Heurística de alocação:** sempre 2 pessoas no caminho crítico (Trilha A) com o(a) TL revisando para evitar bus-factor 1 no domínio mais arriscado (Asaas). Nunca deixar `security-lgpd`/`observability-qa` sem dono — mesmo que parcial.

---

### 90.8 Resumo executivo

- **Ordem de build:** `fundacao` → `auth-rbac`/`design-system` → `member-identity`/`public-api` → `tiers-perks`/`payments-billing` → `passport`/`verification-checkin` → apps/`crm`. `security-lgpd` e `observability-qa` são transversais desde o dia 1.
- **Caminho crítico:** fundação → auth → identidade → tiers → **Asaas** → **passport** → validação → apps. Os dois maiores riscos de prazo (Asaas e certificados Apple/Google) são atacados **em paralelo, na semana 1**.
- **MVP = o caminho crítico** = membership cobrável (Asaas, 12×, sem renovação auto) + passe Apple/Google + validação pública + admin/member front + auth/orgs + CRM básico. Fora: CRM 360º, comunicação, eventos, conteúdo, comunidade, integrações, IA, MCP, Hall of Fame, app nativo.
- **Calendário-alvo:** M0 ~2 sem · MVP ~4–6 sem · V1 ~4 sem · V2 ~4 sem · V3 ~3 sem, com um time de 6–8 pessoas paralelizando 3 trilhas no MVP e até 5 frentes no V1.
