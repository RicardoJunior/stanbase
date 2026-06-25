# Stanbase — v0 (protótipo rodável)

Protótipo navegável do **loop de valor completo** da Stanbase (membership multi-tenant),
construído a partir de `../docs`. Demonstra: dono cria tiers/perks → fã faz checkout com a
**matemática real de comissão/parcelamento** → vira membro com **Member ID** → ganha
carteirinha + perks → **Passport** com QR → **validação pública** → **check-in** na portaria.

> v0 deliberada: **um app React, sem serviços externos**. Toda a lógica de domínio é real;
> a infraestrutura (Supabase, Asaas, Wallet, OAuth) é mockada e marcada como **REPLAN**.

## Como rodar

```bash
cd app
npm install
npm run dev      # http://localhost:5173
npm test         # golden numbers de billing + Member ID (27 testes)
npm run build    # typecheck + build de produção
```

## Superfícies (uma SPA, quatro superfícies por rota)

| Rota | O quê |
|---|---|
| `/` | Landing institucional (port fiel de `stanbase.html`) |
| `/admin` | Painel padronizado do dono (Dashboard, CRM, Tiers&Perks, Receita, Eventos, Validação, Config/Tema). Chrome da identidade, **não temável**. |
| `/m/aurora` | Front de membro **temável** (white-label): planos, checkout, área do membro, passport, perfil |
| `/verify/:memberId` | Validação pública (níveis L0/L1/L2 de PII) |
| `/checkin` | Console de portaria (operador) |
| `/superadmin` | Staff Stanbase: orgs, billing global, GMV |

Roteiro de demo: `/superadmin` → abrir Aurora → `/admin` (tiers, receita, CRM) →
`/m/aurora` → assinar um plano → ver carteirinha/perks → `/m/aurora/passport` → clicar no QR
→ `/verify/...` → `/checkin` valida o Member ID.

Botão **"Resetar demo"** (rodapé do admin) recria os dados de fábrica.

## O que é REAL (lógica de domínio correta)

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
| Banco / RLS | store em `localStorage` (`src/lib/store.ts`) | Supabase Postgres + RLS por `org_id` |
| API | fachada `src/lib/api.ts` (mesma assinatura) | Edge Functions `/v1` + OpenAPI/Swagger |
| Pagamento | checkout simulado (matemática real) | Asaas: split, subcontas, webhooks, golden tests de centavos |
| Passport | render do card + "Adicionar à Wallet" mock | `.pkpass` Apple (certificado) + Google Wallet JWT |
| Auth | persona picker / social mock | Supabase Auth (OTP + Google/Apple/X) |
| QR | faux-QR (não escaneável) clicável | encoder real (`qrcode`) + JWT assinado em Edge |
| Fontes | Google Fonts via CDN | self-host woff2 (LGPD §23.1.9) |
| Drag-and-drop de tiers | setas ↑/↓ | dnd real |
| Preview de tema | `<MemberCard/>` + amostra | iframe do member-app real + republish de passes |
| Fora da v0 | IA, MCP, webhooks, integrações (Discord/YouTube/Sympla), conteúdo, comunidade, comunicação, Hall of Fame, eventos avançados, domínio próprio + SSL, i18n en-US/es | Roadmap V1/V2/V3 (`docs/plan/90-roadmap.md`) |

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
