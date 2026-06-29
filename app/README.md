# Stanbase — v0 (protótipo rodável)

Protótipo navegável do **loop de valor completo** da Stanbase (membership multi-tenant),
construído a partir de `../docs`. Demonstra: dono cria tiers/perks → fã faz checkout com a
**matemática real de comissão/parcelamento** → vira membro com **Member ID** → ganha
carteirinha + perks → **Passport** com QR → **validação pública** → **check-in** na portaria.

> O front-end roda **mock-backed por padrão** (store em `localStorage`) para a demo. A infra real
> já existe e é plugável por env (`VITE_SUPABASE_URL`/`ANON_KEY` → `hasBackend()` em `src/lib/supabase.ts`):
> **app servido pelo Cloudflare Pages**, **domínios próprios via Cloudflare for SaaS**, **backend + DB no
> Supabase Cloud** (Edge Functions `/v1` em `../supabase/functions`, RLS por `org_id`, Asaas real).

## Como rodar

```bash
cd app
npm install
npm run dev      # http://localhost:5173
npm test         # golden numbers de billing + Member ID (27 testes)
npm run build    # typecheck + build de produção
```

## Superfícies (uma SPA, por rota)

| Rota | O quê |
|---|---|
| `/` | Landing institucional (port fiel de `stanbase.html`) — CTA **"Criar minha base"** |
| `/onboarding` | **Cadastro self-service + wizard** que monta o membership (você → vertical → marca → tiers → perks+integrações → publicar) |
| `/admin` | Painel padronizado do dono (Dashboard, CRM, Tiers&Perks, **Página do membro** (page builder), Receita, Eventos, Validação, **Integrações**, Config/Tema). Chrome da identidade, **não temável**. |
| `/m/:slug` | Front de membro **temável** (white-label): **landing montada por blocos**, planos, checkout, área do membro, passport, perfil |
| `/verify/:memberId` | Validação pública (níveis L0/L1/L2 de PII) |
| `/checkin` | Console de portaria (operador) |
| `/superadmin` | Staff Stanbase: orgs, billing global, GMV |

Roteiro de demo (criar a própria base): `/` → **Criar minha base** → wizard (escolha um modelo
de vertical) → publicar → admin novo com tiers configurados → **Integrações** (conectar Discord/etc.)
→ `/m/{slug}` assinar um plano → carteirinha/perks → `/m/{slug}/passport` → QR → `/verify/...` → `/checkin`.

Há uma org demo pré-pronta (**Aurora Esports**, `/m/aurora`) com membros, transações e integrações já conectadas.
Botão **"Resetar demo"** (rodapé do admin) recria os dados de fábrica.

## O que é REAL (lógica de domínio correta)

- **Cadastro + onboarding** (`createAccountAndOrg` em `src/lib/api.ts`, templates em `src/lib/templates.ts`) — cria conta+org+tiers+perks+conexões a partir de **10 modelos de vertical** prontos (esports, clube de carro, time/torcida, balada, creator, empresa, fitness, curso/escola, igreja/comunidade, podcast/newsletter), slug único, owner logado.
- **Domínio próprio** (`src/lib/api.ts` `addCustomDomain`/`verifyCustomDomain`, Edge `../supabase/functions/v1-domains`) — white-label via Cloudflare for SaaS: CNAME → `cname.stanbase.app`, emissão de SSL automática, máquina de estados `pending_dns→dns_ok→ssl_issued→active`; configurável em **Config → Domínio**.
- **Configurações do membership** (`surfaces/admin/pages/Settings.tsx`) — Geral (nome/vertical/tagline/logo + URL do membro), Marca & Tema, Domínio, Equipe, Faturamento, LGPD.
- **Page builder da LP** (`src/lib/blocks.ts` + `surfaces/member/blocks/`, editor em `surfaces/admin/pages/PageBuilder.tsx`) — catálogo curado de blocos (hero, texto, texto+imagem, imagem, destaques, perks, planos, números, depoimentos, FAQ, vídeo, galeria, CTA, divisor); add/reorder/edit/delete com preview ao vivo; publica em `org.landing` (§24, com limites de customização do §23.1.4).
- **Member ID** (`src/lib/ids.ts`) — §7.5: CSPRNG, alfabeto sem ambíguos, padrão LNLNLNLN, único, blocklist.
- **Billing** (`src/lib/billing.ts`) — §13.3: comissão base 7,99%, tabela Price a 3,49% a.m.,
  parcelamento ≤12× só em tri/semestral/anual, spread vs. antecipação. Golden numbers testados
  (anual R$600/12× → R$744,70; comissão R$47,94; 24,1%).
- **Entitlements** (`src/lib/entitlements.ts`) — acúmulo tier→perks; grandfathering = perde por padrão (Q52).
- **Theming** (`src/lib/theme.ts`) — override semântico por org + contraste WCAG + derivação de `*-contrast`.
- **Token do QR** (`src/lib/verify-token.ts`) — assinatura (mock) + expiração ~12h.

## O que é MOCK / STUB (REPLAN)

| Área | v0 | Replanejar para |
|---|---|---|
| Banco / RLS | store em `localStorage` (`src/lib/store.ts`) por padrão | **Supabase Postgres + RLS por `org_id` já escrito** (`../supabase/migrations`); plugável por env |
| API | fachada `src/lib/api.ts` (mesma assinatura) | **Edge Functions `/v1` já escritas** (`../supabase/functions/v1-*`: members, tiers, subscriptions, events, connections, theme, team, dashboard, passport, domains) + `api.remote.ts` |
| Pagamento | checkout simulado (matemática real) | **adapter Asaas real + Edge `checkout`/`asaas-webhook` escritos**; cobrança ao vivo exige deploy (`supabase login` + ref) |
| Passport | render do card + "Adicionar à Wallet" mock | `.pkpass` Apple (certificado) + Google Wallet JWT |
| Auth / cadastro | signup sem senha + persona picker (mock) | Supabase Auth (OTP + Google/Apple/X) |
| Integrações | **funcionais mock** (`src/lib/connectors.ts` + `connectIntegration`): catálogo, connect/disconnect/map, estado de provisão refletido nos perks | OAuth real + provisão/sync (grant de cargo etc.) + reconcile de drift |
| QR | faux-QR (não escaneável) clicável | encoder real (`qrcode`) + JWT assinado em Edge |
| Fontes | Google Fonts via CDN | self-host woff2 (LGPD §23.1.9) |
| Drag-and-drop de tiers | setas ↑/↓ | dnd real |
| Preview de tema | `<MemberCard/>` + amostra | iframe do member-app real + republish de passes |
| Fora da v0 | IA, MCP, webhooks, conteúdo, comunidade, Hall of Fame, eventos avançados, i18n en-US/es | Roadmap V1/V2/V3 (`docs/plan/90-roadmap.md`) |

## Estrutura

```
src/
├── lib/        ids · billing · entitlements · theme · verify-token · perk-catalog · store · api · session · cn
├── types/      domain.ts (§25)
├── seed/       seed.ts (Aurora Esports: 4 tiers, 12 perks, ~40 membros, 1 evento)
├── components/ ui/* (design system) · MemberCard (3D) · Qr
└── surfaces/   marketing/ · admin/ · member/ · verify/ · superadmin/
```

## Decisões (docs como fonte da verdade)

Seguem `docs/STANBASE.md` §30 e `docs/PERGUNTAS-ABERTAS.md`: `mode` live/test em todo registro (Q2),
reuso de Member ID na reativação (Q19), LTV = valor do plano sem juros (Q29), grace mantém acesso (Q27/Q69),
PII mínima na rota pública / foto OFF (Q70), 1 membership por org. Onde a doc não especifica, escolheu-se
o caminho mais simples (anotado como REPLAN).
