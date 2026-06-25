# Stanbase — Plano Completo de Desenvolvimento

> Documento de engenharia: **como** construir a plataforma inteira, domínio a domínio, com modelo de dados, API, telas, épicos→tarefas, dependências, riscos e corte de MVP. Complementa o `STANBASE.md` (o **o quê**) com o **como**.

| | |
|---|---|
| **Versão** | 1.0 |
| **Data** | 2026-06-24 |
| **Base** | `docs/STANBASE.md` v1.3 (spec do produto) |
| **Stack** | React + TypeScript · Supabase (Postgres + RLS + Auth + Storage + Realtime) · Edge Functions (TS/Deno) · Asaas · OpenAPI/Swagger · MCP |
| **Perguntas abertas** | `docs/PERGUNTAS-ABERTAS.md` (225 perguntas, agrupadas e priorizadas) |

---

## Como este plano foi construído

Cada um dos **24 domínios** foi planejado em profundidade por um arquiteto dedicado, em paralelo; depois um agente de **roadmap/sequenciamento** consolidou o grafo de dependências e o corte de MVP, e um agente de **produto** consolidou todas as perguntas abertas. O resultado é exaustivo por design — leia por domínio conforme for executar.

## Como ler

1. **§03 — Princípio central (Perks & Integrações plugáveis).** Leia primeiro: é a decisão que atravessa o produto.
2. **§05–§28 — Os 24 domínios.** Cada um: *Como funciona → Modelo de dados → API & Edge Functions → Telas → Integrações → Épicos & tarefas → Dependências → Riscos → Escopo MVP*.
3. **§85 — Oportunidades de Integração.** Catálogo de ~186 integrações em ondas (o backlog de expansão).
4. **§90 — Roadmap.** Grafo de dependências, caminho crítico, milestones, linha de corte do MVP, riscos, paralelização e time.
5. **§95 — Perguntas abertas.** Tudo que precisa de decisão sua (também em `PERGUNTAS-ABERTAS.md`).

## Mapa dos domínios (e corte de MVP)

| # | Domínio | MVP? | Esforço | # | Domínio | MVP? | Esforço |
|---|---|---|---|---|---|---|---|
| 05 | Fundação & Arquitetura | ✅ | XL | 18 | Camada de IA | ❌ V2 | XL |
| 06 | Auth, Contas, Orgs & RBAC | ✅ | XL | 19 | Framework de Integrações | ✅ | XL |
| 07 | Identidade & Member ID | ✅ | L | 20 | API REST & OpenAPI | ✅ | L |
| 08 | CRM / Customers | ✅* | XL | 21 | Webhooks & Automação | ✅* | L |
| 09 | Tiers, Perks & Entitlements | ✅ | XL | 22 | MCP Server | ❌ V2 | L |
| 10 | Pagamentos & Billing (Asaas) | ✅ | XL | 23 | Design System & Theming | ✅ | L |
| 11 | Passport (Apple+Google) | ✅ | L | 24 | Admin App | ✅ | XL |
| 12 | Validação & Check-in | ✅ | XL | 25 | Member App (PWA) | ✅ | XL |
| 13 | Eventos & Ingressos | ❌ V1 | XL | 26 | Super-admin Stanbase | ✅ | L |
| 14 | Conteúdo Gated | ❌ V1 | L | 27 | Segurança & LGPD | ✅ (transversal) | XL |
| 15 | Comunidade & Canais | ❌ V1 | L | 28 | Observabilidade & QA | ✅ (transversal) | L |
| 16 | Comunicação & Campanhas | ❌ V1 | XL | | | | |
| 17 | Hall of Fame | ❌ V3 | L | | | | |

`✅* = subset no MVP, completo depois.` Detalhe e justificativa do corte em **§90.4**.

## Decisões já travadas (âncoras do plano)

- **PSP = Asaas** (split nativo via subcontas), arquitetura PSP-agnóstica.
- **Member ID** = 8 caracteres, alternando letra/dígito, alfabeto sem ambíguos, **sem dígito verificador**.
- **Passport** = Apple Wallet **+** Google Wallet, os dois desde o MVP.
- **1 membership por org**; várias bases = várias orgs sob a mesma Conta.
- **Parcelamento** até 12×, só em tri/semestral/anual, **juros ao cliente = 3,49% a.m.** (max Hotmart×Asaas), pass-through, **sem renovação automática** de plano parcelado.
- **Perks & Integrações = sistema de plugins** self-service e extensível (§03).

## Calendário-alvo (time de 6–8 pessoas, ver §90.7)

**M0 Fundação** ~2 sem → **MVP** ~4–6 sem → **V1** ~4 sem → **V2** ~4 sem → **V3** ~3 sem.
O **MVP é o caminho crítico**: fundação → auth → identidade → tiers → Asaas → passport → validação → apps. Os dois maiores riscos de prazo (integração Asaas e certificados Apple/Google) são atacados **em paralelo já na semana 1**.

## 🔴 Top decisões bloqueantes (resolver antes de codar — detalhe em §95)

1. **i18n:** pt-BR no MVP com arquitetura i18n-ready (locale no JWT/perfil, campos traduzíveis em JSONB), ou três idiomas plenos no go-live? → *Rec.: pt-BR com schema i18n-ready.*
2. **Coluna `mode` (live/test)** em todas as tabelas desde o início (mesmo com sandbox completo só na V2)? → *Rec.: sim, nasce em todo o schema.*
3. **Reativação de membro** (cancelado→ativo): reusa o mesmo Member ID e histórico, ou gera ID novo? → *Rec.: reusa o ID, preserva histórico e "membro desde".*
4. **Definição de LTV:** valor do plano (bruto, sem juros), com `total_paid` e `net_org` separados; juros de parcelamento nunca entram no LTV. → *Confirmar.*
5. **Fonte de verdade dos juros de parcelamento:** Stanbase calcula (tabela Price, valor fixo ao Asaas) vs. Asaas. → *Rec.: Stanbase calcula, com golden tests de centavos no sandbox.*
6. **Acesso em inadimplência/grace:** mantém perks/conteúdo/canal/passe/porta até o fim do grace (default 3 dias) e só então revoga tudo? → *Rec.: sim, coerente em todos os domínios.*
7. **Fronteira de PII na validação pública:** foto OFF por padrão (só staff vê), operador nunca vê financeiro. → *Confirmar.*
8. **Confirmação de escrita por IA/MCP:** leitura direto; escrita vira proposta; financeiro/envio em massa/anonimização exigem 2ª confirmação; allowlist curada. → *Confirmar.*

---
