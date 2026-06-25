# Stanbase — Documentação Completa do Produto e Plataforma

> **A base de membros das maiores comunidades.**
> Proximidade, receita recorrente e IA — sob a marca de cada comunidade.

| | |
|---|---|
| **Versão do documento** | 1.4 — UI base Tailwind + shadcn/ui; decisões de planejamento resolvidas (i18n-ready pt-BR, modo test/live, reativação reusa ID, grace mantém acesso, sem app v0, WhatsApp API oficial) |
| **Data** | 2026-06-24 |
| **Autor** | ScaleUp / Stanbase |
| **Status** | 🟡 Em revisão — aprovar antes do primeiro desenvolvimento |
| **Stack-alvo** | React + TypeScript (front) · Supabase (Postgres + Auth + Storage + Realtime) · Supabase Edge Functions (TypeScript/Deno) · OpenAPI/Swagger · MCP |

---

## Sumário

1. [Visão geral do produto](#1-visão-geral-do-produto)
2. [Personas e papéis](#2-personas-e-papéis)
3. [Modelo de negócio e preço](#3-modelo-de-negócio-e-preço)
4. [Conceitos fundamentais (glossário)](#4-conceitos-fundamentais-glossário)
5. [Modos de operação da plataforma](#5-modos-de-operação-da-plataforma)
6. [Arquitetura e stack](#6-arquitetura-e-stack)
7. [Identidade do membro — o ID de 8 caracteres](#7-identidade-do-membro--o-id-de-8-caracteres)
8. [Passport — Apple Wallet & Google Wallet](#8-passport--apple-wallet--google-wallet)
9. [Rota pública de validação do membro](#9-rota-pública-de-validação-do-membro)
10. [Admin Stanbase (painel padronizado do dono)](#10-admin-stanbase-painel-padronizado-do-dono)
11. [CRM / Base de customers](#11-crm--base-de-customers)
12. [Engine de tiers, perks e memberships](#12-engine-de-tiers-perks-e-memberships)
13. [Pagamentos, assinaturas e receita](#13-pagamentos-assinaturas-e-receita)
14. [Eventos e ingressos](#14-eventos-e-ingressos)
15. [Conteúdo exclusivo (gated content)](#15-conteúdo-exclusivo-gated-content)
16. [Comunidade e canais](#16-comunidade-e-canais)
17. [Comunicação, campanhas e presentes](#17-comunicação-campanhas-e-presentes)
18. [Hall of Fame e gamificação](#18-hall-of-fame-e-gamificação)
19. [Camada de IA (IA-first)](#19-camada-de-ia-ia-first)
20. [Integrações](#20-integrações)
21. [API REST pública + OpenAPI/Swagger](#21-api-rest-pública--openapiswagger)
22. [Webhooks e automação](#22-webhooks-e-automação)
23. [MCP Server](#23-mcp-server)
24. [Front padrão temável (white-label)](#24-front-padrão-temável-white-label)
25. [Modelo de dados](#25-modelo-de-dados)
26. [Segurança, permissões e LGPD](#26-segurança-permissões-e-lgpd)
27. [Observabilidade, métricas e analytics](#27-observabilidade-métricas-e-analytics)
28. [Estrutura de repositório e ambientes](#28-estrutura-de-repositório-e-ambientes)
29. [Roadmap e fases de desenvolvimento](#29-roadmap-e-fases-de-desenvolvimento)
30. [Decisões em aberto para revisão](#30-decisões-em-aberto-para-revisão)

---

## 1. Visão geral do produto

**Stanbase** é uma plataforma de *membership* multi-tenant que transforma a base de fãs de qualquer comunidade em uma base de **membros** — com proximidade real, receita recorrente e uma camada de IA que conhece cada fã.

A mesma engine veste qualquer vertical:

| Vertical | Exemplo de tiers |
|---|---|
| Clube de carro | Visitante · Associado · Piloto · Fundador |
| Time / torcida | Torcedor · Sócio · Sócio Ouro · Camarote |
| Comunidade gamer / esports | Fã · Membro · VIP · Founder |
| Balada / clube noturno | Lista · Frequentador · VIP · Black |
| Creator | Seguidor · Apoiador · Insider · Founding Member |
| Empresa / associação | Cliente · Membro · Premium · Embaixador |

### 1.1 Pilares de valor

1. **Proximidade** — canais, perks e momentos exclusivos que aproximam o dono da comunidade de quem mais importa.
2. **Receita recorrente** — assinaturas e tiers que viram receita previsível, montados em um dia.
3. **Alinhamento** — comunidade, conteúdo, eventos e membros sob uma única marca, em um só lugar.
4. **IA-first** — não é só um painel; é uma camada de inteligência que segmenta, escreve, sugere perks e prevê churn.

### 1.2 O que entregamos (resumo executivo)

- Um **admin sólido e padronizado** (idêntico para todo dono de membership).
- Um **front de membro temável** (white-label) hospedado pela Stanbase — pronto para usar.
- Um **modo headless** completo: REST API documentada (Swagger), webhooks e **MCP**, para quem quer construir a própria experiência.
- Um **CRM de membros** de primeira linha (praticamente um CRM dedicado).
- **Passport digital** (Apple Wallet / Google Wallet) com ingresso, carteirinha e prova de membership.
- **Rota pública de validação** de qualquer membro via ID curto e QR assinado.
- **ID de membro de 8 caracteres**, fácil de digitar e ditar.

---

## 2. Personas e papéis

| Persona | Quem é | Onde atua |
|---|---|---|
| **Stanbase Staff** (super-admin) | Time interno da Stanbase | Painel interno multi-tenant: gestão de organizações, billing da plataforma, suporte, feature flags |
| **Org Owner** (dono do membership) | FURIA, um clube de carro, um creator, uma balada | Admin padronizado da organização |
| **Org Admin** | Gestor delegado pelo owner | Admin (permissões granulares) |
| **Org Operator / Staff de porta** | Equipe de evento / portaria | App/rota de validação e check-in |
| **Member** (membro / fã) | O torcedor, gamer, sócio | Front de membro (web/PWA) + Passport no celular |
| **Partner / Developer** | Quem integra via API/MCP | API keys, OAuth, webhooks, MCP |

Há, portanto, **dois níveis de admin**:

- **Admin da Stanbase (interno)** — opera a plataforma inteira (todos os tenants).
- **Admin da Organização (padronizado)** — *"sólido e igual pra todo mundo"*: o painel de controle que todo dono de membership recebe, idêntico em estrutura; só os dados, a marca e o tema mudam.

> **Multi-base:** uma **Conta** pode possuir **várias orgs (bases)**, cada uma com seu próprio membership, marca, tema, membros e financeiro isolados. Um **seletor de org** no topo do admin troca o contexto. Permissões e billing são por org. Não há multi-programa dentro de uma org — várias bases = várias orgs.

---

## 3. Modelo de negócio e preço

- **Preço-âncora: 7,99% por transação** (Pix e cartão à vista). Sem mensalidade, sem setup, sem fidelidade.
- **Parcelamento (tri/semestral/anual, até 12×):** o **membro paga juros** (pass-through, modelo Hotmart) a **3,49% a.m.** — a maior taxa entre Hotmart (3,49% a.m.) e Asaas (~1,25% a.m.); a comissão base segue **7,99%** e a Stanbase ganha o **spread** do financiamento (que cresce com o nº de parcelas). Ver [§13.3](#133-períodos-parcelamento-e-comissão-progressiva).
- **Períodos de plano:** mensal, trimestral, semestral ou anual ([§13.3.1](#1331-períodos-de-plano)).
- Cobrança incide sobre toda transação processada via Stanbase (assinatura de tier, ingresso, drop, presente pago, upgrade).
- **Tudo incluso em todos os planos:** plataforma completa (comunidade, conteúdo, eventos, membros), todas as integrações, IA-first, tiers e perks ilimitados.
- **Captura da taxa:** via *split de pagamento* no **Asaas** (a Stanbase recebe a comissão e repassa o restante ao dono automaticamente). Ver [§13](#13-pagamentos-assinaturas-e-receita).

> **Implicação técnica:** o modelo é **all-in** — o custo do PSP sai de dentro da comissão da Stanbase, então o PSP define a margem. PSP escolhido: **Asaas** (split nativo via subcontas), com camada **PSP-agnóstica** para futura troca/escala. Benchmark, margem e tabela de comissão em [§13.2](#132-split-e-taxa-modelo-all-in-799) e [§13.3](#133-períodos-parcelamento-e-comissão-progressiva).

---

## 4. Conceitos fundamentais (glossário)

| Termo | Definição |
|---|---|
| **Conta (Account)** | A conta do dono/operador. **Pode possuir várias orgs (bases)** e alternar entre elas. |
| **Organização (org / tenant) = base** | A comunidade dona do membership. **Unidade de isolamento de dados e de 1 membership.** Quem quer várias bases cria várias orgs. |
| **Membership program** | **1 por org (decidido).** Cada org/base tem exatamente um programa. Querendo vários, criam-se várias orgs — não há multi-programa dentro de uma org. |
| **Tier** | Nível de membro (nome, preço, período, perks, ordem, cor). Configurável por drag-and-drop. |
| **Perk / Benefício** | Vantagem concedida por tier (conteúdo, acesso a evento, cargo no Discord, desconto, brinde…). |
| **Member** | A relação entre uma **pessoa** e uma **org** (a "carteirinha"). Possui o **Member ID** de 8 caracteres. |
| **Customer (CRM)** | A visão 360º da pessoa-membro: perfil, atributos, histórico, LTV, tags, segmentos. |
| **Passport** | O conjunto de passes na carteira do celular (membership + ingressos) do membro. |
| **Pass** | Um cartão individual no Apple/Google Wallet (carteirinha *ou* um ingresso). |
| **Entitlement** | Direito ativo de um membro a um perk, derivado do tier ou concedido manualmente. |
| **Segment** | Grupo dinâmico de membros (manual ou gerado por IA). |
| **Connection / Integration** | Vínculo configurado entre a org e um serviço externo (Discord, Twitch, PSP…). |

---

## 5. Modos de operação da plataforma

A Stanbase roda de três formas. **O admin é sempre o mesmo (padronizado).** O que muda é a experiência do membro.

### 5.1 Modo Hosted (telas Stanbase temáveis) — *padrão*
- O dono usa nosso **front de membro pronto** (web responsivo + PWA), aplicando **tema** (cores, logo, fontes, domínio próprio).
- Zero código. Publica em minutos sob `org.stanbase.com` ou domínio próprio (`membros.suacomunidade.com`).
- Inclui: login social, página de tiers/checkout, área de membro, conteúdo gated, eventos, passport, hall of fame.

### 5.2 Modo Headless / API-first (own app)
- O dono (ou parceiro) constrói **a própria experiência** consumindo a **REST API** + **webhooks** + **MCP**.
- A Stanbase é o backend de membership: identidade, tiers, billing, entitlements, passport, validação.
- Tudo o que o front hosted faz é possível via API — **paridade total de capacidades**.

### 5.3 Modo Híbrido
- Combina: site próprio + componentes/embeds Stanbase (ex.: widget de checkout de tier, botão "Adicionar ao Wallet", iframe da área de membro) e API para o resto.
- **SDKs** (JS/React) e **embeds** facilitam esse caminho.

> **Princípio de design:** *API-first by default.* O front hosted é só o primeiro cliente da mesma API pública. Nada do produto vive "escondido" fora da API.

---

## 6. Arquitetura e stack

### 6.1 Stack

| Camada | Tecnologia |
|---|---|
| **Front (admin + membro)** | React 18 + TypeScript + Vite · React Router · TanStack Query · **Tailwind + shadcn/ui (Radix primitives)** como base de componentes + design system próprio (tokens da identidade sobre os componentes shadcn) |
| **Mobile/PWA do membro** | PWA (instalável) no MVP; passes nativos via Wallet. (App nativo opcional no roadmap) |
| **Backend / lógica** | **Supabase Edge Functions** (TypeScript / Deno) — API pública versionada, webhooks, jobs, geração de passes, split de pagamento, IA |
| **Banco de dados** | Supabase **Postgres** com **RLS** (multi-tenant por `org_id`) |
| **Auth** | Supabase Auth (e-mail/OTP + OAuth: Google, Apple, X) + JWT |
| **Storage** | Supabase Storage (logos, mídias, imagens de passes, comprovantes) |
| **Realtime** | Supabase Realtime (status de validação ao vivo, contadores, notificações) |
| **Filas / agendados** | Supabase Cron / pg_cron + filas (pgmq) para jobs assíncronos (push de passes, campanhas, sync de integrações) |
| **API Gateway público** | Edge Functions sob `api.stanbase.com/v1`, documentadas via OpenAPI 3.1 / Swagger UI |
| **MCP** | Servidor MCP que expõe a API como ferramentas para agentes de IA |
| **IA** | Provedor LLM (Claude) para segmentação, copy, qualificação, churn; embeddings para busca/semântica |

### 6.2 Por que uma API dedicada em Edge Functions (e não PostgREST cru)

O PostgREST do Supabase é ótimo para o **app interno** (admin e front usam o client Supabase com RLS para velocidade). Mas a **API pública** para parceiros/headless/MCP passa por uma camada dedicada em Edge Functions porque precisamos de:

- **Versionamento** (`/v1`) e contratos estáveis independentes do schema do banco.
- **DTOs limpos** (não expor colunas internas), paginação/cursor padronizada, erros consistentes.
- **Autenticação por API key / OAuth client-credentials** além de JWT de usuário.
- **Rate limiting, idempotência e auditoria** por chamada.
- **OpenAPI** como fonte de verdade do contrato → gera Swagger UI, SDKs e o MCP.

### 6.3 Diagrama lógico

```
                         ┌──────────────────────────────────────────────┐
                         │                  CLIENTES                     │
   Admin Org (React) ─┐  │  Front Membro (React/PWA)   App próprio/3rd   │
   Stanbase Admin  ───┤  │  Embeds/SDK JS              MCP clients (IA)  │
                      │  └───────────────┬──────────────────────────────┘
                      │                  │
        Supabase JS (RLS)        REST /v1 (API key/OAuth/JWT) ── Swagger
                      │                  │                          │
                      ▼                  ▼                          ▼
            ┌───────────────────────────────────────────────────────────┐
            │              Supabase Edge Functions (TS/Deno)             │
            │  API pública · Webhooks in/out · Passport (pkpass/Wallet)  │
            │  Split de pagamento · IA · Sync integrações · Jobs/cron    │
            └───────────────┬───────────────────────────────────────────┘
                            ▼
            ┌───────────────────────────────────────────────────────────┐
            │   Supabase: Postgres (RLS) · Auth · Storage · Realtime     │
            │   pg_cron · pgmq (filas) · pgvector (embeddings)           │
            └───────────────┬───────────────────────────────────────────┘
                            ▼
   Integrações externas: PSP/Pix · Discord · Telegram · WhatsApp · Twitch ·
   YouTube · Sympla/Ingresse · Steam/Riot · Apple/Google Wallet · LLM · Zapier
```

---

## 7. Identidade do membro — o ID de 8 caracteres

### 7.1 Requisitos
- **8 caracteres**, alternando **letra e número**, fácil de digitar e ditar por telefone/portaria.
- Capacidade alta (centenas de milhões → bilhão).
- **Único globalmente** na Stanbase (a rota pública resolve qualquer ID sem ambiguidade entre orgs).

### 7.2 Formato recomendado

- **Padrão:** `L N L N L N L N` (alterna letra–número, 4 letras + 4 números).
- **Exemplo:** `B7K2M9X4`, `R3D8N5C2`.
- **Alfabeto sem ambíguos:**
  - Letras (sem `I`, `O`): `A B C D E F G H J K L M N P Q R S T U V W X Y Z` → **24 letras**.
  - Dígitos (sem `0`, `1`): `2 3 4 5 6 7 8 9` → **8 dígitos**.

### 7.3 Capacidade

```
24⁴ (letras) × 8⁴ (dígitos) = 331.776 × 4.096 = 1.358.954.496
```

≈ **1,36 bilhão** de IDs possíveis com os 8 caracteres totalmente aleatórios — folga enorme.

### 7.4 Sem dígito verificador (decidido)

**Decisão:** o ID **não** usa dígito verificador. Os 8 caracteres são todos significativos/aleatórios, preservando a capacidade total (~1,36 bilhão) e mantendo o ID o mais simples possível.

- A integridade na digitação é garantida pela **validação online** (a rota/endpoint sempre consulta o banco) e pelo **alfabeto sem ambíguos** (sem `I/O/0/1`), que já elimina a maioria dos erros de leitura.
- A autenticidade contra fraude **não** depende do ID e sim do **token assinado no QR** (ver [§7.6](#76-observações) e [§9](#9-rota-pública-de-validação-do-membro)).

### 7.5 Geração (algoritmo)

1. Sortear todas as 8 posições com **CSPRNG** (`crypto.getRandomValues`) sobre os alfabetos (alternando letra/dígito).
2. Tentar inserir com **constraint UNIQUE** no banco; em colisão (raríssima), re-sortear (retry com backoff, no máx. N tentativas).
3. Opcional: **lista de bloqueio** para evitar combinações infelizes/ofensivas (mesmo alternando, vale uma blocklist curta).

```ts
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // 24, sem I e O
const DIGITS  = "23456789";                 // 8, sem 0 e 1

function randomChar(set: string): string {
  const idx = crypto.getRandomValues(new Uint32Array(1))[0] % set.length;
  return set[idx];
}

function generateMemberId(): string {
  // padrão L N L N L N L N — 8 caracteres, todos aleatórios (sem dígito verificador)
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += i % 2 === 0 ? randomChar(LETTERS) : randomChar(DIGITS);
  }
  return id;
}
```

> **Formatação visual:** exibir como `B7K2 · M9X4` ou `B7K2-M9X4` em telas/passport para leitura, mas armazenar/normalizar sem separador e **case-insensitive** (sempre upper).

### 7.6 Observações
- O Member ID identifica a relação **pessoa × org** (uma pessoa em duas comunidades tem dois IDs/passes).
- IDs **nunca são reutilizados** após cancelamento (mantêm histórico e validação).
- Para QR/validação, o ID **não é o segredo** — o token assinado é (ver [§9](#9-rota-pública-de-validação-do-membro)).

---

## 8. Passport — Apple Wallet & Google Wallet

O **Passport** é a presença da Stanbase no celular do membro. Dois tipos de passe:

1. **Carteirinha de membership** (prova de que é membro, com tier).
2. **Ingresso de evento** (ticket para um evento específico).

### 8.1 Apple Wallet (`.pkpass`)
- Tipo: `storeCard`/`generic` (carteirinha) e `eventTicket` (ingresso).
- Geração e assinatura em **Edge Function** com o **Pass Type ID certificate** da Stanbase (a Stanbase é o publisher; a marca da org aparece no design do passe).
- **Atualização dinâmica:** web service de PassKit + **APNs push** quando muda tier, status, saldo de perks ou dados do evento.
- Campos: marca da org (logo + cor), nome do membro, **Member ID**, tier, "membro desde", status, QR de validação.

### 8.2 Google Wallet
- Classe + objeto **Generic/Loyalty** (carteirinha) e **Event Ticket** (ingresso).
- Emissão via **Google Wallet API** com **JWT "Save to Google Wallet"** assinado por service account.
- **Atualização** via REST (PATCH no objeto) — reflete em tempo real no device.

### 8.3 Fluxo de emissão

```
Membro entra na área → clica "Adicionar ao Wallet"
        │
        ▼
Edge Function /passport/issue
  • valida membership ativa
  • gera token de validação assinado (JTI + exp + rotação)
  • monta pkpass (assina) OU JWT do Google Wallet
  • registra Pass no banco (vinculado ao member_id)
        │
        ▼
Device adiciona à carteira  ──►  Atualizações futuras via APNs/REST push
```

### 8.4 Conteúdo do QR no passe
O QR **não** carrega só o Member ID. Carrega uma **URL de verificação com token assinado** (JWT curto/rotativo ou referência opaca), de modo que:
- Não dá para forjar um passe adivinhando IDs.
- A portaria que escaneia cai numa página/endpoint que confirma autenticidade **online** e mostra status ao vivo.
- Em modo offline, o dígito verificador + assinatura local permitem validação básica.

### 8.5 Ingressos no passport
- Cada compra de ingresso gera um **pass de ingresso** vinculado ao evento + member.
- Check-in marca o ingresso como **usado** (anti-reuso), refletido no passe via push.
- Suporta lote de membro, acesso antecipado e drops (ver [§14](#14-eventos-e-ingressos)).

---

## 9. Rota pública de validação do membro

Rota pública para qualquer pessoa (porteiro, parceiro, lojista) confirmar que um membro é válido.

### 9.1 Endpoints
- **Página pública:** `https://verify.stanbase.com/{memberId}` (ou domínio da org `verificar.suacomunidade.com/{memberId}`).
- **API:** `GET /v1/public/verify/{memberId}?token={signed}` → JSON com status.
- **Scan de QR:** o QR do passe abre a página/endpoint já com o token assinado.

### 9.2 O que mostra (com e sem token)

| Acesso | Informação exibida |
|---|---|
| **Público sem token** (digitou o ID) | Marca da org · "Membro válido/ inválido" · tier · "membro desde" · status (ativo/inativo) — **dados mínimos**, sem PII sensível |
| **Com token assinado** (QR do passe) | O acima + foto (se a org permitir) + nome + confirmação anti-fraude (assinatura válida) |
| **Staff autenticado** (portaria) | Tudo acima + ações: check-in, marcar presença, ver perks ativos, registrar interação no CRM |

### 9.3 Garantias
- **Autenticidade:** token JWT assinado pela Stanbase com expiração curta e rotação; QR pode ser dinâmico (TOTP-like) para eventos de alto risco.
- **Privacidade (LGPD):** a visão pública por ID expõe o mínimo; PII só com token/permissão. A org controla quais campos ficam públicos.
- **Rate limiting & anti-enumeração:** limites por IP, IDs não sequenciais e check char dificultam varredura.
- **Tempo real:** revogação de membership reflete imediatamente na validação (status puxado ao vivo).

---

## 10. Admin Stanbase (painel padronizado do dono)

O coração operacional. **Idêntico em estrutura para todo dono** — muda só marca, tema e dados. Sólido, rápido, completo.

### 10.1 Navegação (módulos)

1. **Dashboard** — visão geral
2. **Membros / CRM** — base de customers (ver [§11](#11-crm--base-de-customers))
3. **Tiers & Perks** — engine de membership (ver [§12](#12-engine-de-tiers-perks-e-memberships))
4. **Receita & Pagamentos** — assinaturas, transações, repasses (ver [§13](#13-pagamentos-assinaturas-e-receita))
5. **Eventos & Ingressos** (ver [§14](#14-eventos-e-ingressos))
6. **Conteúdo** (gated) (ver [§15](#15-conteúdo-exclusivo-gated-content))
7. **Comunidade & Canais** (ver [§16](#16-comunidade-e-canais))
8. **Comunicação** — mensagens, campanhas, presentes (ver [§17](#17-comunicação-campanhas-e-presentes))
9. **Hall of Fame** — rankings, conquistas (ver [§18](#18-hall-of-fame-e-gamificação))
10. **IA** — copilot, segmentos, churn, qualificação (ver [§19](#19-camada-de-ia-ia-first))
11. **Integrações** (ver [§20](#20-integrações))
12. **Validação & Portaria** — scanner, check-in, presença
13. **Desenvolvedores** — API keys, webhooks, OpenAPI, MCP
14. **Configurações** — marca/tema, domínio, equipe & permissões, faturamento, LGPD

### 10.2 Dashboard — métricas-chave
- **MRR / receita recorrente**, receita do mês, ticket médio.
- **Membros ativos**, novos, cancelados, **churn** e **net adds**.
- Distribuição por **tier**, conversão de funil (visitante → membro → upgrade).
- **Superfãs** e **em risco** (sinalizado pela IA).
- Eventos próximos, ingressos vendidos, taxa de check-in.
- Alertas e ações sugeridas pela IA ("3 membros prestes a cancelar — enviar perk?").

### 10.3 Princípios de UX do admin
- **Mesmo IA para todos** — onboarding guiado ("monte seu membership em um dia").
- Ações em massa, busca global, filtros salvos, atalhos de teclado.
- **Audit log** de tudo (quem fez o quê).
- Tudo que o admin faz é uma chamada à **mesma API pública** (dogfooding).

---

## 11. CRM / Base de customers

> *"Como membership, a base de customers tem que ser incrível — praticamente um CRM."*
> Este é um módulo de primeira classe, não um apêndice.

### 11.1 Perfil do membro (visão 360º)
- **Identidade:** Member ID, nome, foto, contatos (e-mail, telefone/WhatsApp), redes sociais conectadas.
- **Membership:** tier atual, histórico de tiers, status, "membro desde", origem (como entrou).
- **Financeiro:** **LTV**, MRR, total pago, método de pagamento, próxima cobrança, inadimplência.
- **Engajamento:** score de engajamento, último acesso, presença em eventos, consumo de conteúdo.
- **Atributos customizados:** campos definidos pela org (placa do carro, gamertag, time do coração, tamanho de camiseta…).
- **Qualificação por IA:** respostas e perfil inferido (interesses, potencial).

### 11.2 Timeline de interações
Linha do tempo unificada por membro: assinaturas, upgrades/downgrades, pagamentos, check-ins, mensagens trocadas, presentes recebidos, abertura de e-mails, entradas em canais, conquistas, notas internas da equipe.

### 11.3 Organização e segmentação
- **Tags** (livres) e **listas**.
- **Segmentos dinâmicos** por regras (tier, LTV, última atividade, evento X, atributo Y) — atualizados automaticamente.
- **Segmentos por IA** (ver [§19](#19-camada-de-ia-ia-first)): superfã, recém-chegado, em risco, dormindo.
- **Lifecycle stages:** lead → membro → ativo → em risco → cancelado → reativado.
- **RFM** (recência, frequência, valor) para priorização.

### 11.4 Operação do CRM
- **Notas** e **tarefas** por membro (atribuíveis à equipe).
- **Importação/Exportação** (CSV) e migração de bases existentes.
- **Busca avançada** (qualquer campo/atributo) e filtros salvos.
- **Visões** (kanban por lifecycle, tabela, cards).
- **Webhooks/automação** disparados por mudanças no membro.

### 11.5 Por que é um CRM de verdade
Combina cadastro + billing + engajamento + comunicação + eventos em **um registro vivo por pessoa**, com a IA enriquecendo e priorizando. O dono administra relacionamento, não planilha.

---

## 12. Engine de tiers, perks e memberships

### 12.1 Tiers
- **Totalmente configuráveis:** nome, descrição, **preço**, **período** (**mensal / trimestral / semestral / anual**; único e vitalício como casos especiais), ordem (drag-and-drop), cor/arte, limite de vagas (ex.: "Founding Member: 100 vagas").
- **Parcelamento** habilitável nos períodos tri/semestral/anual, até 12× (juros ao cliente a 3,49% a.m., modelo Hotmart — ver [§13.3](#133-períodos-parcelamento-e-comissão-progressiva)).
- Mesma engine para qualquer vertical (exemplos na [§1](#1-visão-geral-do-produto)).
- **Trials**, cupons/descontos, lote de fundador, preço promocional.

### 12.2 Perks (benefícios)

> **Modelo plugável (princípio central):** todo perk é um item de um **catálogo extensível**, muitos deles **alimentados por integrações** (Discord, WhatsApp, Steam, Riot, evento…). Cada **tipo de perk** declara: qual integração precisa (se precisa), um **schema de configuração** (que vira um formulário curto no admin) e os **hooks de provisionar/desprovisionar**. O dono **arrasta o perk para o tier** e preenche o form — **autosserviço, sem código**. Adicionar uma integração nova = registrar um connector + perk-type no catálogo → aparece para **todas as orgs**. Ver o framework em [§20.1](#201-framework-de-integrações) e o backlog de expansão em **Oportunidades de Integração** (no plano de desenvolvimento).

Catálogo de tipos de perk, atribuíveis a um ou mais tiers (acúmulo: tiers superiores herdam os perks dos inferiores por padrão, com opção de marcar um perk como exclusivo de um tier; o mesmo tipo pode ter várias instâncias configuradas):
- **Conteúdo exclusivo** (VOD, live fechada, bastidores).
- **Acesso a evento** (antecipado, lote de membro, ingresso incluso).
- **Canais/cargos** (Discord role, grupo Telegram/WhatsApp).
- **Descontos** (loja oficial, parceiros).
- **Brindes/drops** físicos ou digitais.
- **Reconhecimento** (badge, posição no hall of fame).
- **Perks de nicho** (conta de jogo conectada, validação de sócio, reconhecimento de modelo de carro).
- **Custom** (definido pela org com regra própria).

### 12.3 Entitlements
- Ao assinar/mudar de tier, o membro **ganha/perde entitlements** automaticamente.
- Sincronização imediata com integrações (atribui cargo no Discord, libera VOD, etc.).
- Concessão manual avulsa (cortesia) e expiração programada.

### 12.4 Regras
- Upgrade/downgrade com **proração**.
- Mudança de tier reflete no **passport** (push) e nas integrações.
- Histórico completo para CRM e auditoria.

---

## 13. Pagamentos, assinaturas e receita

### 13.1 Métodos (Brasil-first)
- **Pix** (à vista; recorrência via Pix Automático quando disponível).
- **Cartão de crédito** (recorrência de assinaturas).
- **Boleto** (opcional).

### 13.2 Split e taxa (modelo all-in 7,99%)
- Modelo **marketplace/split**: a cada transação, **7,99% para a Stanbase** e o restante para a org, automaticamente.
- **All-in (decisão de produto):** a comunicação é "uma taxa fixa, sem letrinha miúda" → **o custo do PSP sai de dentro dos 7,99% da Stanbase**, não é cobrado a mais do dono. Logo, **o custo do PSP define diretamente a margem bruta da Stanbase.**
- **Exceção obrigatória:** o **juro de cartão parcelado** é **pass-through** (repassado ao membro no checkout), nunca absorvido — caso contrário a transação fica negativa.
- Registro contábil por transação (valor bruto, taxa Stanbase, taxa PSP, líquido da org) para relatórios e repasses.

### 13.2.1 Benchmark de custo dos PSPs (tarifas públicas self-serve, jun/2026)

> ⚠️ Tarifas de **tabela/balcão**. Uma plataforma com volume **negocia MDR bem abaixo** — usar como teto.

| PSP | Pix | Cartão à vista | Parcelado | Boleto | Split/marketplace | Recorrência | Repasse/saque |
|---|---|---|---|---|---|---|---|
| **Pagar.me** (Stone) | 1,19% | 4,39–5,59% | até ~13–15% (12x) | R$ 3,49 | Só no plano customizado (negociável) | Sim (cartão) | R$ 3,67/saque + R$ 0,99/tx |
| **Mercado Pago** | 0,99% (alguns fluxos 0%) | 4,98% na hora / 3,98% em 30d | escalonado | — | Marketplace/split nativo | Sim | conforme prazo |
| **Asaas** | R$ 0,99→1,99 fixo (1ªs 100/mês isentas) | ~R$ 0,49 + ~1,99%+ (à vista real ~2,99–3,49%, confirmar) | a partir de 1,99% | R$ 1,99 | Split nativo via subcontas | Sim (assinaturas) | grátis na conta digital |
| **Stripe** (Connect) | 1,19% (Pix invite-only no BR) | 3,99% + R$ 0,39 (+2% intl) | — | — | Connect: +0,25% + R$ 0,67/repasse, R$ 6/conta ativa/mês | Sim (Billing) | incluído |

### 13.2.2 Impacto na margem (margem Stanbase ≈ 7,99% − custo PSP)

| Método | Custo PSP negociado realista | Margem líquida Stanbase |
|---|---|---|
| **Pix** | ~1% (ou fixo R$ 1–2) | **~6,8–7%** ✅ |
| **Cartão à vista** | ~3–4% | **~4–5%** ⚠️ |
| **Cartão à vista (1x)** | ~3–4% | **~4–5%** ⚠️ |
| **Cartão parcelado** | antecipação Asaas ~1,25% a.m. | **monetizado** ✅ → cliente paga juros 3,49% a.m.; Stanbase fica com o **spread** (§13.3) |

**Levers estratégicos:** (1) empurrar **Pix**, sobretudo **Pix Automático** para a recorrência (recorrência sem custo de cartão = maior margem); (2) **juros do parcelamento pagos pelo cliente** a 3,49% a.m. (modelo Hotmart) + **spread sobre a antecipação Asaas** transformam o parcelado de prejuízo em receita; (3) **negociar MDR/antecipação no Asaas** amplia o spread.

### 13.2.3 Decisão (✅ Asaas)
- **PSP de lançamento: Asaas** — menor custo de Pix, **split nativo via subcontas** com KYC pronto, assinaturas e **cobranças parceladas** nativas. Decidido.
- **Camada de pagamento mesmo assim PSP-agnóstica** (padrão adapter), para renegociar/trocar no futuro (Pagar.me para escala, Stripe para internacional) sem reescrever a aplicação.
- Próximo passo operacional: **abrir conta marketplace Asaas, cotar MDR negociado** e confirmar os parâmetros de juros/antecipação que alimentam a tabela de comissão progressiva (§13.3).

### 13.3 Períodos, parcelamento e comissão progressiva

#### 13.3.1 Períodos de plano
Cada tier pode ser cobrado em um de quatro períodos:

| Período | Cobrança | Parcelamento | Recorrência ideal |
|---|---|---|---|
| **Mensal** | 1× no início de cada mês | ❌ não permite | Pix Automático / cartão recorrente |
| **Trimestral** | valor do trimestre | ✅ permite | Pix Automático / cartão recorrente |
| **Semestral** | valor do semestre | ✅ permite | Pix Automático / cartão recorrente |
| **Anual** | valor do ano | ✅ permite | Pix Automático / cartão recorrente |

> (Períodos **único** e **vitalício** seguem suportados como casos especiais, mas o padrão de produto são os quatro acima.)

#### 13.3.2 Parcelamento (só tri/semestral/anual, sempre até 12×)
- **Disponível apenas** para trimestral, semestral e anual — **mensal nunca parcela**.
- **Teto fixo: até 12×** em qualquer período que permita parcelamento (decidido — não amarra ao nº de meses do plano).
- **Sem renovação automática de plano parcelado:** um plano parcelado é uma **compra avulsa** que libera o acesso pelo período; **não há auto-renovação** desse caso (fora de escopo agora — [§13.4](#134-assinaturas)). Por isso parcelas podem ultrapassar a duração do acesso sem conflito de ciclo.
- **Juros do lado do cliente (pass-through):** o membro paga os juros no checkout, transparentes (modelo Hotmart). A org recebe **antecipado** sem absorver juros; a Stanbase fica com o **spread** sobre o custo de antecipação do Asaas.

#### 13.3.3 Juros de parcelamento (modelo Hotmart vs. Asaas → maior das duas)
**Decisão:** a taxa de juros ao cliente segue a regra **`max(Hotmart, Asaas)`** por faixa — garante que o juros cobrado **nunca fique abaixo do custo** e capture a margem premium.

| Fonte (jun/2026) | Taxa | Papel |
|---|---|---|
| **Hotmart** (juros de parcelamento, cartão) | **3,49% a.m.** (padrão; "Parcelado Hotmart" 4,99% a.m.) | referência de mercado |
| **Asaas** (antecipação de recebíveis parcelado) | a partir de **~1,25% a.m.** (1,15% automática) | custo real Stanbase |
| **→ Adotado** | **3,49% a.m.** (Hotmart vence) | juros ao cliente |

Com **3,49% a.m.** (juros compostos / tabela Price), o acréscimo total pago pelo membro por nº de parcelas:

| Parcelas | Acréscimo total ao cliente | Parcelas | Acréscimo total ao cliente |
|---|---|---|---|
| 2× | ~5,3% | 8× | ~16,3% |
| 3× | ~7,1% | 9× | ~18,3% |
| 4× | ~8,9% | 10× | ~20,2% |
| 5× | ~10,7% | 11× | ~22,1% |
| 6× | ~12,6% | 12× | ~24,1% |
| 7× | ~14,4% | | |

- **A "comissão maior progressiva" emerge sozinha:** como o cliente paga 3,49% a.m. e o Asaas custa ~1,25% a.m., a Stanbase retém o **spread (~2,2% a.m.)** por mês financiado → quanto mais parcelas, maior a receita de financiamento. Não é preciso inventar tabela de comissão extra.
- **Comissão base permanece 7,99%** sobre o valor do plano (Pix, à vista **e** parcelado), idêntica para todos — é padrão Stanbase, não configurável por org.
- A taxa **3,49% a.m.** é parâmetro de plataforma e será **revalidada contra o contrato Asaas** (se a antecipação negociada subir acima de 3,49%, sobe junto pela regra `max`).

**Exemplo (anual R$ 600, em 12× a 3,49% a.m.):**
- Cliente paga **~R$ 744,7** total (~R$ 62/mês) — acréscimo de ~R$ 144,7 (24,1%).
- Asaas (antecipação ~1,25% a.m.) custa à Stanbase **bem menos** que esse acréscimo → o **spread** é margem premium de financiamento.
- Stanbase ainda retém a **comissão base 7,99% de R$ 600 = R$ 47,94**.
- A org recebe o líquido **antecipado**, sem absorver juros.

#### 13.3.4 Implicação de posicionamento
A headline **"7,99%, simples assim"** permanece verdadeira para **Pix/à vista** (caminho incentivado). O parcelamento é um **opt-in premium e transparente**: o membro vê os juros no checkout (como na Hotmart); a org não paga nada a mais. Manter essa comunicação clara evita conflito com o "sem letrinha miúda" da landing.

### 13.4 Assinaturas
- Ciclos (mensal/trimestral/semestral/anual), renovação automática (à vista/recorrente), retry de cobrança (dunning), cancelamento, pausa.
- **Renovação automática:** aplica-se a compras **à vista/recorrentes** (Pix Automático / cartão recorrente) no período do plano.
- **Planos parcelados não têm renovação automática** (decidido — fora de escopo agora): são compra avulsa de acesso pelo período; ao fim, o membro adquire novamente se quiser.
- Webhooks do Asaas → atualizam status do membership em tempo real → ajustam entitlements e passport.
- **Inadimplência:** grace period configurável antes de revogar acesso.

### 13.5 Relatórios financeiros
- MRR, churn de receita, LTV, receita por tier/evento, **receita de comissão base vs. premium de parcelamento**, repasses, extrato, exportação fiscal.
- Reconciliação com o Asaas.

---

## 14. Eventos e ingressos

- **Criação de eventos** (data, local, capacidade, tipos de ingresso, lotes).
- **Lote de membro / acesso antecipado / preço de membro** por tier.
- **Drops e ativações** exclusivas na área de membro.
- **Ingresso = passport pass** (Apple/Google Wallet) com QR.
- **Check-in / portaria:** scanner (rota de validação) marca presença, evita reuso, mostra tier do membro.
- **Integração com Sympla / Ingresse** (importar/sincronizar) — ou venda nativa via Stanbase.
- Presença alimenta o **CRM** (timeline + engajamento) e o **Hall of Fame**.

---

## 15. Conteúdo exclusivo (gated content)

- Biblioteca de **conteúdo liberado por tier**: VODs, lives fechadas, bastidores, posts.
- **Embeds/integração:** Twitch, YouTube, Vimeo (acesso condicionado ao tier).
- **Gating:** verificação de entitlement antes de servir o conteúdo (signed URLs / verificação via API).
- Agendamento de publicação e janelas de acesso (ex.: "VOD por 7 dias").
- Consumo registrado no CRM (engajamento).

---

## 16. Comunidade e canais

- **Discord:** atribuição/remoção automática de **cargos por tier**, verificação de membership via bot/OAuth.
- **Telegram:** entrada/saída de grupos por tier.
- **WhatsApp:** grupos/comunidades e mensagens (via API oficial/provedor).
- **Sincronização contínua:** mudou de tier → cargos atualizados na hora; cancelou → acesso removido.
- Mapa "tier → canais/cargos" configurável no admin.

---

## 17. Comunicação, campanhas e presentes

- **Mensagens diretas** a membros ou segmentos (e-mail, push, WhatsApp).
- **Campanhas** segmentadas (por tier, segmento, evento, comportamento), com agendamento.
- **Presentes** (gifts) — físicos ou digitais — a membros específicos (ex.: brinde ao superfã).
- **Copy assistida por IA** na voz da marca (ver [§19](#19-camada-de-ia-ia-first)).
- **Métricas:** entrega, abertura, clique, conversão; tudo na timeline do CRM.
- **Preferências/consentimento** respeitados por canal (LGPD).

---

## 18. Hall of Fame e gamificação

- **Rankings** (por engajamento, antiguidade, presença, gasto) — configuráveis.
- **Conquistas/badges** (ex.: "Fundador", "10 eventos", "1 ano de casa").
- **Lugar de honra** para os maiores fãs — destaque público (opt-in) na área de membro.
- **Pontos/XP** opcionais alimentando perks ou subida de tier.
- Reforça reconhecimento — um dos diferenciais ("aos melhores, o destaque que merecem").

---

## 19. Camada de IA (IA-first)

A IA não é um módulo isolado — permeia o produto. Capacidades:

1. **Segmentação automática** — reconhece superfã, recém-chegado e quem está prestes a sair; cria segmentos vivos.
2. **Previsão de churn** — score de risco por membro + alertas antecipados + sugestão de retenção.
3. **Sugestão do próximo perk** — recomenda o benefício certo, por tier, para converter/reter.
4. **Copywriting na voz da marca** — gera mensagens, drops e campanhas prontas para revisar e enviar.
5. **Qualificação automática** — gera as perguntas certas e descobre interesses/perfil/potencial de cada fã.
6. **Copilot do admin** — pergunte em linguagem natural ("quem são meus 20 maiores fãs que não vão ao evento?") e a IA consulta a base e age.

### 19.1 Implementação
- LLM (Claude) via Edge Functions; **embeddings (pgvector)** para busca semântica e similaridade de membros.
- Jobs agendados recalculam scores (churn, engajamento, RFM).
- Guardrails: a IA **sugere e rascunha**; ações sensíveis exigem confirmação humana.
- Toda saída de IA é auditável e ligada ao registro do membro.

---

## 20. Integrações

**Todas as integrações são grátis, em qualquer plano, para sempre.** Conecta sem código, em minutos.

| Categoria | Serviços | O que faz |
|---|---|---|
| **Conteúdo** | Twitch, YouTube, Vimeo | VODs exclusivas, lives fechadas, bastidores por tier |
| **Eventos** | Ingresse, Sympla, loja oficial | Acesso antecipado, lote de membro, drops |
| **Identidade** | Google, Apple, X | Login social + verificação de fã |
| **Perks de nicho** | Steam, Riot, APIs do nicho | Conecta conta de jogo, valida sócio, reconhece modelo de carro |
| **Canais & comunidade** | Discord, Telegram, WhatsApp | Cargos e grupos por tier |
| **Automação & API** | API, Webhooks, Zapier | Liga no stack do dono |
| **Pagamentos** | PSP/Pix (split) | Cobrança e repasse com taxa Stanbase |
| **Wallet** | Apple Wallet, Google Wallet | Passport (carteirinha + ingressos) |

### 20.1 Framework de integrações (sistema de plugins)
Integrações e perks são **um sistema de plugins unificado** — fácil de usar (self-service) e fácil de ampliar (modular). Cinco peças:
- **Connector (catálogo):** definição padronizada de um provider (tipo de auth, capacidades, eventos, schema de config). É código + linha no catálogo, **global** para todas as orgs.
- **Connection:** instância — a org conectou o provider (OAuth/tokens **cifrados**, nunca expostos ao front), **por org**.
- **Mapping:** regra configurável que liga um conceito Stanbase a um recurso externo (tier → cargo Discord; perk → playlist YouTube; tier → grupo WhatsApp).
- **Webhook de entrada:** evento do provider (pagamento, saída do servidor) verificado por assinatura e roteado.
- **Sync / Reconcile:** aplica a intenção (grant/revoke) no provider e corrige *drift* periodicamente.

**Princípios:** (a) **self-service** — o dono conecta uma vez e configura perks por formulário, sem código; (b) **extensível** — adicionar um provider é registrar um connector + perk-type, sem refatorar a plataforma; (c) *"não vê sua ferramenta? a gente conecta pra você"* (connect-on-demand). O backlog vivo de providers está em **Oportunidades de Integração** (plano de desenvolvimento, §85): ~186 integrações mapeadas em ondas.

---

## 21. API REST pública + OpenAPI/Swagger

### 21.1 Princípios
- **Base:** `https://api.stanbase.com/v1`
- **Auth:** API key (server-to-server) · OAuth2 client-credentials (parceiros) · JWT (usuário/app).
- **Formato:** JSON; `snake_case`; datas ISO-8601 UTC.
- **Paginação:** cursor (`?limit=&cursor=`).
- **Idempotência:** header `Idempotency-Key` em POSTs de escrita financeira.
- **Erros:** envelope consistente `{ error: { code, message, details } }`.
- **Versionamento:** `/v1`; mudanças breaking só em nova major.
- **Multi-tenant:** escopo da org derivado da credencial; recursos isolados por `org_id`.
- **OpenAPI 3.1** é a fonte da verdade → **Swagger UI** público em `/v1/docs` → gera **SDKs** e o **MCP**.

### 21.2 Catálogo de endpoints (representativo)

**Membros / CRM**
```
GET    /v1/members                 # listar/filtrar/segmentar
POST   /v1/members                 # criar membro (gera Member ID)
GET    /v1/members/{memberId}      # detalhe 360º
PATCH  /v1/members/{memberId}      # atualizar perfil/atributos
DELETE /v1/members/{memberId}      # cancelar/anonimizar (LGPD)
GET    /v1/members/{memberId}/timeline
POST   /v1/members/{memberId}/notes
POST   /v1/members/{memberId}/tags
GET    /v1/members/{memberId}/entitlements
```

**Tiers & Perks**
```
GET    /v1/tiers
POST   /v1/tiers
PATCH  /v1/tiers/{id}              # inclui reordenação
GET    /v1/perks
POST   /v1/perks
POST   /v1/tiers/{id}/perks/{perkId}
```

**Assinaturas & Pagamentos**
```
POST   /v1/subscriptions          # assinar tier (checkout)
GET    /v1/subscriptions/{id}
POST   /v1/subscriptions/{id}/cancel
POST   /v1/subscriptions/{id}/change-tier
GET    /v1/transactions
GET    /v1/payouts                # repasses ao dono
```

**Passport & Validação**
```
POST   /v1/passport/issue         # emite pkpass / Google Wallet JWT
POST   /v1/passport/{memberId}/refresh
GET    /v1/public/verify/{memberId}   # validação pública (token opcional)
POST   /v1/checkin                # portaria marca presença
```

**Eventos & Ingressos**
```
GET    /v1/events
POST   /v1/events
POST   /v1/events/{id}/tickets    # gerar/vender ingresso (vira pass)
GET    /v1/tickets/{id}
POST   /v1/tickets/{id}/validate
```

**Conteúdo / Canais / Comunicação**
```
GET    /v1/content
POST   /v1/content                # publicar conteúdo gated
GET    /v1/channels
POST   /v1/messages               # mensagem/campanha p/ segmento
POST   /v1/gifts
```

**Segmentos & IA**
```
GET    /v1/segments
POST   /v1/segments               # regras OU geração por IA
POST   /v1/ai/churn-scores
POST   /v1/ai/copy                # rascunho de copy na voz da marca
POST   /v1/ai/qualify             # gera perguntas / infere perfil
```

**Integrações & Dev**
```
GET    /v1/integrations
POST   /v1/integrations/{provider}/connect
GET    /v1/webhooks
POST   /v1/webhooks               # registrar endpoint
GET    /v1/api-keys
```

> O catálogo completo (todos os campos, exemplos, códigos de erro) vive no **OpenAPI 3.1** versionado no repo e renderizado em **Swagger UI**.

---

## 22. Webhooks e automação

- **Webhooks de saída:** a org registra endpoints e assina eventos.
- **Eventos (exemplos):** `member.created`, `member.tier_changed`, `member.churned`, `subscription.payment_succeeded`, `subscription.payment_failed`, `event.checkin`, `passport.issued`, `content.published`.
- **Entrega confiável:** assinatura HMAC, retries com backoff, dead-letter, log de entregas, replay manual.
- **Zapier / Make:** app oficial publicando triggers e actions sobre a API.
- **Webhooks de entrada:** recebem eventos do PSP, Discord, etc. (verificação de assinatura).

---

## 23. MCP Server

Um **servidor MCP** expõe a Stanbase como ferramentas para agentes de IA (o copilot do dono, ferramentas próprias, automações).

- **Geração:** derivado do OpenAPI — cada recurso vira *tools* MCP (listar/criar/atualizar membros, consultar CRM, criar segmentos, enviar mensagens, emitir passport, validar membro, ver métricas).
- **Auth:** API key / OAuth com o **mesmo escopo de org e permissões** da API REST.
- **Segurança:** ações de escrita/financeiras podem exigir confirmação; tudo auditado.
- **Casos de uso:** "crie um segmento dos superfãs que não foram ao último evento e rascunhe um convite", "quantos membros Camarote renovam esse mês?", "emita a carteirinha do membro B7K2M9X4".
- **Distribuição:** MCP hospedado pela Stanbase (remoto) + descrição para conectar em clientes MCP.

---

## 24. Front padrão temável (white-label)

O front de membro hosted é **um produto único, temável** — não um tema por cliente codado à mão.

### 24.1 Theming
- **Tokens de design** (derivados da identidade: ivory `#f5f3ed`, ink `#16150f`, gold `#b8965a`, obsidian `#15140f`; fonts Jost / Hanken Grotesk / Space Mono) com override por org: logo, cor primária/realce, tipografia, modo claro/escuro, arte do member card.
- **Domínio próprio** (`membros.suacomunidade.com`) com SSL automático.
- **PWA instalável**; botão "Adicionar ao Wallet".

### 24.2 Telas do membro
- Landing/checkout de tiers · Login social · Área do membro (carteirinha + tier + perks) · Conteúdo gated · Eventos/ingressos · Hall of Fame · Perfil/preferências · Passport.

### 24.3 SDK & embeds
- **SDK JS/React** para o modo híbrido (componentes: `<TierCheckout/>`, `<MemberCard/>`, `<AddToWallet/>`, `<VerifyBadge/>`).
- **Embeds** via iframe para inserir checkout/área de membro em sites existentes.

---

## 25. Modelo de dados

Tabelas principais (Postgres / Supabase). Toda tabela de domínio carrega `org_id` e é protegida por **RLS**.

### 25.1 Núcleo
| Tabela | Campos-chave |
|---|---|
| `accounts` | `id`, `name`, `owner_user_id`, `billing_ref`, `created_at` — dona de **N orgs (bases)** |
| `organizations` | `id`, **`account_id`**, `slug`, `name`, `brand` (logo, cores, fonts), `domain`, `status`, `created_at` — **1 membership por org** |
| `org_users` | `id`, `org_id`, `user_id`, `role` (owner/admin/operator), `permissions` — vínculo e permissões **por org** |
| `tiers` | `id`, `org_id`, `name`, `description`, `price`, `currency`, `period`, `position`, `color`, `capacity`, `status` |
| `perks` | `id`, `org_id`, `type`, `name`, `config` (jsonb), `status` |
| `tier_perks` | `tier_id`, `perk_id` |

### 25.2 Membros / CRM
| Tabela | Campos-chave |
|---|---|
| `members` | `id`, **`member_id`** (8 chars, UNIQUE global), `org_id`, `user_id`, `tier_id`, `status`, `joined_at`, `source` |
| `member_profiles` | `member_id`, `name`, `photo_url`, `email`, `phone`, `social` (jsonb), `attributes` (jsonb custom) |
| `member_metrics` | `member_id`, `ltv`, `engagement_score`, `churn_score`, `rfm`, `last_active_at` |
| `tags` / `member_tags` | tag livre por org |
| `segments` | `id`, `org_id`, `name`, `rules` (jsonb) ou `ai_generated` |
| `notes` | `id`, `member_id`, `author`, `body`, `created_at` |
| `interactions` (timeline) | `id`, `member_id`, `type`, `payload` (jsonb), `occurred_at` |
| `entitlements` | `id`, `member_id`, `perk_id`, `source` (tier/manual), `expires_at`, `status` |

### 25.3 Billing
| Tabela | Campos-chave |
|---|---|
| `tiers` (billing) | `period` (`monthly`/`quarterly`/`semiannual`/`annual`), `installments_enabled` (false p/ mensal) |
| `platform_billing_settings` | `base_commission_rate` (7,99%), `installment_interest_rate_am` (3,49% a.m.), `max_installments` (12), `psp_anticipation_rate_am` — **padrão Stanbase, global** |
| `subscriptions` | `id`, `member_id`, `tier_id`, `period`, `status`, `current_period_end`, `installments`, `auto_renew` (false se parcelado), `psp_ref` |
| `transactions` | `id`, `org_id`, `member_id`, `gross`, `method`, `installments`, `customer_interest`, `base_commission`, `psp_fee`, `psp_anticipation_fee`, `financing_spread`, `net_org`, `status`, `psp_ref` |
| `payouts` | `id`, `org_id`, `amount`, `period`, `status` |

### 25.4 Passport / Eventos
| Tabela | Campos-chave |
|---|---|
| `passes` | `id`, `member_id`, `type` (membership/ticket), `platform` (apple/google), `serial`, `auth_token`, `status` |
| `events` | `id`, `org_id`, `name`, `starts_at`, `venue`, `capacity` |
| `tickets` | `id`, `event_id`, `member_id`, `tier_pricing`, `status` (valid/used), `pass_id` |
| `checkins` | `id`, `ticket_id`/`member_id`, `operator`, `at` |

### 25.5 Conteúdo / Canais / Comunicação
| Tabela | Campos-chave |
|---|---|
| `content_items` | `id`, `org_id`, `type`, `provider`, `external_ref`, `min_tier`, `publish_at` |
| `channels` | `id`, `org_id`, `provider`, `mapping` (tier→role/grupo) |
| `messages` / `campaigns` | `id`, `org_id`, `segment_id`, `channel`, `body`, `schedule`, `stats` |
| `gifts` | `id`, `org_id`, `member_id`, `type`, `status` |

### 25.6 Dev / Plataforma
| Tabela | Campos-chave |
|---|---|
| `connections` | `id`, `org_id`, `provider`, `credentials` (cifrado), `status` |
| `api_keys` | `id`, `org_id`, `hash`, `scopes`, `last_used_at` |
| `webhooks` | `id`, `org_id`, `url`, `events`, `secret` |
| `webhook_deliveries` | `id`, `webhook_id`, `event`, `status`, `attempts` |
| `audit_logs` | `id`, `org_id`, `actor`, `action`, `target`, `at` |
| `achievements` / `member_achievements` | hall of fame |

---

## 26. Segurança, permissões e LGPD

- **Isolamento multi-tenant** via **RLS** por `org_id` em todas as tabelas de domínio; políticas testadas.
- **RBAC:** papéis (owner/admin/operator) + permissões granulares por módulo.
- **Auth:** Supabase Auth (OTP + OAuth Google/Apple/X), JWT curtos, refresh seguro.
- **Segredos/tokens de integração** cifrados (KMS/secret manager); nunca expostos ao front.
- **API:** rate limiting, idempotência, assinatura HMAC em webhooks, escopos por API key.
- **LGPD:**
  - Base legal e **consentimento** por canal de comunicação.
  - **Direitos do titular:** exportar dados, retificar, **anonimizar/excluir** (com preservação de registros financeiros legais).
  - Minimização na rota pública (só o essencial sem token).
  - **DPA** com sub-processadores (Supabase, PSP, LLM, Wallet).
  - Logs de acesso e auditoria.
- **Dados financeiros:** a Stanbase não armazena dados sensíveis de cartão (tokenização no PSP, PCI via PSP).

---

## 27. Observabilidade, métricas e analytics

- **Produto:** funil (visitante→membro→upgrade), churn, MRR/LTV, coortes, engajamento — no dashboard.
- **Técnico:** logs estruturados das Edge Functions, tracing de requisições da API, métricas de latência/erro, alertas.
- **Entregas de webhook** e **syncs de integração** monitorados (status, retries, DLQ).
- **Eventos de analytics** opcionais para o front (com consentimento).
- **Health checks** e status page.

---

## 28. Estrutura de repositório e ambientes

### 28.1 Monorepo (sugestão)
```
stanbase/
├── apps/
│   ├── admin/           # painel padronizado da org (React + TS)
│   ├── member/          # front de membro temável / PWA (React + TS)
│   └── stanbase-admin/  # painel interno super-admin
├── functions/           # Supabase Edge Functions (API /v1, webhooks, passport, IA, jobs)
├── packages/
│   ├── sdk-js/          # SDK público (gerado do OpenAPI)
│   ├── ui/              # design system (tokens da identidade)
│   ├── types/           # tipos compartilhados (gerados do schema + OpenAPI)
│   └── mcp-server/      # MCP derivado do OpenAPI
├── supabase/
│   ├── migrations/      # schema, RLS, policies
│   └── seed/
├── openapi/             # openapi.yaml (fonte da verdade) → Swagger UI
└── docs/                # esta documentação
```

### 28.2 Ambientes
- **dev → staging → produção** (projetos Supabase separados).
- Migrations versionadas; CI roda testes de RLS e contrato de API.
- Geração automática de SDK/MCP/Swagger a partir do OpenAPI no CI.

---

## 29. Roadmap e fases de desenvolvimento

> Proposta de faseamento para validar valor cedo. Sujeito à sua priorização.

### Fase 0 — Fundação (semanas 1–2)
- Monorepo, Supabase (DB + Auth + RLS multi-tenant), design system com tokens da identidade.
- Modelo de dados núcleo + **geração do Member ID**.
- Esqueleto da API `/v1` + OpenAPI inicial + Swagger UI.

### Fase 1 — MVP do membership (semanas 3–6)
- Admin padronizado: org, **tiers & perks**, **membros/CRM** básico.
- Front de membro hosted temável: login social, checkout de tier, área do membro.
- **Pagamentos com split** (1 PSP) + assinaturas.
- **Passport** (Apple + Google) + **rota pública de validação** + check-in básico.

### Fase 2 — CRM completo + comunicação (semanas 7–10)
- CRM 360º (timeline, tags, segmentos por regra, notas, import/export, LTV/RFM).
- Comunicação (e-mail/push), campanhas por segmento, presentes.
- Integrações canais (Discord) + conteúdo (YouTube/Twitch) + eventos (Sympla/Ingresse).

### Fase 3 — IA-first (semanas 11–14)
- Segmentação automática, churn score, sugestão de perk, copy na voz da marca, qualificação.
- Copilot do admin.

### Fase 4 — Plataforma para devs (semanas 15–17)
- API pública estável + webhooks + Zapier + **MCP** + SDKs.
- Modo headless/embeds documentado.

### Fase 5 — Hall of Fame, gamificação, refinamentos
- Rankings, conquistas, perks de nicho (Steam/Riot), domínio próprio, app nativo (avaliar).

---

## 30. Decisões em aberto para revisão

### ✅ Decididas

- **Passport:** **Apple + Google, os dois** desde o MVP. (Ver [§8](#8-passport--apple-wallet--google-wallet).)
- **Member ID:** **sem dígito verificador** — 8 caracteres aleatórios alternando letra/dígito, alfabeto sem ambíguos. (Ver [§7](#7-identidade-do-membro--o-id-de-8-caracteres).)
- **Membership por org:** **1 membership por org**. Quem quer vários, cria **várias bases (orgs)**; uma Conta possui e alterna entre elas. (Ver [§2](#2-personas-e-papéis), [§4](#4-conceitos-fundamentais-glossário).)
- **PSP de lançamento: ✅ Asaas** (split nativo via subcontas), modelo **all-in** com arquitetura **PSP-agnóstica** para futura escala/troca. (Ver [§13.2.3](#1323-decisão--asaas).)
- **Períodos de plano:** **mensal, trimestral, semestral, anual**. (Ver [§13.3.1](#1331-períodos-de-plano).)
- **Parcelamento:** só em tri/semestral/anual, **até 12×** (teto fixo). **Juros ao cliente = `max(Hotmart 3,49% a.m. ; Asaas ~1,25% a.m.)` = 3,49% a.m.** (pass-through, modelo Hotmart); comissão base segue 7,99% e a Stanbase fica com o **spread** do financiamento. **Sem renovação automática** de plano parcelado. (Ver [§13.3](#133-períodos-parcelamento-e-comissão-progressiva).)

**Resolvidas na rodada de planejamento (2026-06-24):**
- **i18n:** locales **pt-BR · en-US · es**; arquitetura **i18n-ready desde a fundação** (locale no perfil/JWT; textos voltados ao membro em **JSONB por locale**). **MVP em pt-BR**; en-US/es populados incrementalmente. (Ver §90; §95 Q1.)
- **Modo test/live:** coluna **`mode`** em **todas as tabelas de domínio desde o início** + filtro automático no resolver/RLS; Asaas/Wallet em sandbox quando `mode=test`. O sandbox completo pode ligar depois, mas a coluna nasce agora. (§95 Q2.)
- **Reativação de membro:** reusa o **mesmo Member ID e histórico** (preserva QR, validação, LTV, "membro desde"); `reactivated_at` à parte. "IDs nunca reutilizados" = nunca atribuir o mesmo ID a **outra** pessoa. (§7; §95 Q15.)
- **Inadimplência/grace:** mantém o acesso (perks, conteúdo, canal, passe, porta) **até o fim do grace** (default 3 dias, configurável) e **revoga tudo só então** — coerente em todos os domínios. (§13.4; §95 Q27.)
- **App nativo:** **sem app nativo na v0** — PWA + Passport nativo na Wallet bastam.
- **WhatsApp:** **sempre API oficial** (Cloud API/BSP), nunca provedor não-oficial.

**Adotadas como recomendação (salvo objeção):**
- **LTV** = valor do plano (bruto, sem juros de financiamento); `total_paid` (com juros) e `net_org` (líquido) como campos separados; `customer_interest` nunca entra no LTV.
- **Juros do parcelamento:** a **Stanbase calcula** (tabela Price; valor total fixo enviado ao Asaas), com golden tests de centavos no sandbox.
- **PII na validação pública:** sem token só dados mínimos; **foto OFF por padrão** (só staff/L2 vê); operador de porta nunca vê financeiro/base.
- **IA/MCP:** leitura executa direto; escrita vira proposta; financeiro, envio em massa (>100) e anonimização exigem 2ª confirmação; allowlist curada de tools.

### 🟡 Ainda em aberto

1. **Revalidar 3,49% a.m. contra o contrato Asaas** — confirmar a antecipação negociada; pela regra `max`, se subir acima de 3,49%, o juros ao cliente acompanha.
2. **Domínio próprio da org no MVP** — só `verify.stanbase.com/{id}` + subdomínio Stanbase, ou já domínio próprio com SSL automático? (Rec.: subdomínio no MVP; domínio próprio na fase seguinte.)
3. **Marca dos passes na Apple Wallet** — confirmar **Stanbase como publisher** (um Pass Type ID, arte por org). (Rec.: Stanbase publisher.)
4. **Provedores definitivos** de e-mail/push e **LLM** (custos e LGPD/DPA) — decidir durante o MVP, atrás de adapter.

---

> **Próximo passo:** revisar este documento, responder às [decisões em aberto](#30-decisões-em-aberto-para-revisão) e priorizar as fases. A partir do "ok", começamos pela **Fase 0** (fundação + Member ID + esqueleto da API/OpenAPI).
