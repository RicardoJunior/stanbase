## 25. Member App (front temável / PWA)

> O **front de membro hosted** é o primeiro cliente da API Stanbase e a cara da plataforma para o fã. É **um produto único, temável** (não um tema codado por cliente): web responsivo + **PWA instalável**, white-label por org (cores, logo, fontes, member card, domínio próprio). Cobre o ciclo inteiro do membro — landing/checkout de tiers, login social, área do membro (carteirinha + tier + perks), conteúdo gated, eventos/ingressos, hall of fame, perfil/preferências/consentimento e **Adicionar ao Wallet**. Roda em três modos: **hosted** (padrão, zero código), **headless** (a org constrói o seu via API) e **híbrido** (site próprio + **embeds/SDK**: `<TierCheckout/>`, `<MemberCard/>`, `<AddToWallet/>`, `<VerifyBadge/>`).
>
> Fontes de verdade no doc: §24 (Front padrão temável), §5 (Modos de operação), §1.1/§1.2 (pilares), §8/§9 (Passport e validação), §12 (tiers/perks/entitlements), §13.3 (parcelamento no checkout), §14/§15/§18 (eventos, conteúdo gated, hall of fame), §17 (consentimento/preferências), §26 (LGPD), §27 (analytics), §28 (monorepo `apps/member`).
>
> **Princípio de design (doc §5):** *API-first by default* — o member app **não tem lógica de negócio própria**; ele renderiza estado e dispara ações através da mesma API/dados que qualquer cliente headless usaria. Nada vive "escondido" no front. Toda regra de gating, preço, parcelamento, entitlement é decidida no backend; o front só **reflete** e **pede confirmação humana** onde necessário.

---

### 1. Como funciona

#### 1.1 Onde o member app se encaixa (e o que ele NÃO faz)

O member app é uma **SPA React + PWA** servida por org, com **tema injetado em runtime**. Ele consome dados de duas formas, deliberadamente separadas (herda a "regra de ouro" da fundação, §6.2 do doc):

1. **Leitura/escrita dos próprios dados do membro logado** → `supabase-js` + **RLS** com o **JWT do membro** (claims com `org_id` da org dona daquele domínio + `member_id`). Rápido, sem hop extra. Ex.: carregar perfil, listar perks ativos, ver conteúdo liberado, atualizar preferências.
2. **Operações que exigem segredo ou orquestração server-side** → **Edge Functions** (`/v1` ou functions internas). Ex.: checkout (split Asaas), emitir passe (`.pkpass`/Google Wallet JWT), servir conteúdo gated com signed URL, resolver domínio próprio → org. O segredo **nunca** chega ao browser.

> **Fronteira de escopo deste domínio.** O member app **não implementa** o engine de tiers (domínio `tiers-perks`), o checkout/split (domínio `payments-billing`), a emissão de passe (`passport`), o gating server-side (`content-gating`), nem a venda de ingresso (`events-tickets`). Ele é a **camada de apresentação e orquestração de UX** que consome esses domínios. Este plano cobre: o **shell temável**, **roteamento/estado**, **PWA**, **SDK/embeds**, **resolução de domínio próprio**, **SEO**, **i18n**, **performance mobile**, **deep links de wallet**, e as **telas** específicas do membro.

#### 1.2 Multi-tenant pelo domínio (o problema raiz do front hosted)

Diferente do admin (onde a org ativa vem do seletor de org no JWT), no member app **a org é determinada pela URL**. Um membro nunca escolhe org; ele entra em `membros.furia.gg` ou `furia.stanbase.app` e isso **já é** a org.

Resolução de org por host (executada antes de qualquer render):

```
request host  →  edge resolver (cache CDN/KV)
  ├─ host termina em .stanbase.app (subdomínio reservado) → slug = subdomínio → org
  ├─ host é domínio próprio (membros.suacomunidade.com)    → lookup em org_domains → org
  └─ host desconhecido / domínio não verificado            → 404 branded genérica
        ↓
  retorna { org_id, slug, brand_tokens, locale_default, flags, status }
  ↓ injeta no HTML inicial (SSR/edge) como <script>window.__STANBASE_ORG__</script>
  ↓ SPA hidrata já com o tema correto (sem flash de tema errado — FOUC)
```

Regra concreta: o tema (cores/logo/fonte) **tem que** estar no HTML inicial (inline critical CSS + tokens), senão o membro vê um flash do tema default antes de hidratar (FOUC). Por isso a resolução de org acontece no **edge** (Edge Function que serve o `index.html` com os tokens já injetados), não só no client.

#### 1.3 Os três modos de operação (doc §5) — como o mesmo código atende os três

| Modo | O que o membro vê | Papel do member app |
|---|---|---|
| **Hosted** (padrão) | Front Stanbase temável, em `org.stanbase.app` ou domínio próprio | **Todo o front é nosso.** Org só configura tema/domínio no admin. |
| **Headless** | App/site 100% da org | Member app **não roda**. A org usa só a API `/v1`. Este domínio entrega a **paridade de API** que torna isso possível (nada exclusivo do hosted). |
| **Híbrido** | Site da org + pedaços nossos | A org embute **embeds** (iframe) ou usa o **SDK JS/React** (`<TierCheckout/>`, `<MemberCard/>`, `<AddToWallet/>`, `<VerifyBadge/>`). |

> **Invariante de paridade (doc §5):** qualquer coisa que o front hosted faz, a org consegue fazer via API. Logo, ao criar uma tela hosted, a tarefa **inclui** garantir que o(s) endpoint(s) por trás existem e são públicos — senão criamos uma capacidade "escondida" e quebramos o headless. Toda PR de tela hosted referencia o(s) endpoint(s) `/v1` que a sustenta.

#### 1.4 Máquina de estados — sessão do membro

```
        ┌──────────────┐
        │  ANONYMOUS    │  vê landing/tiers; conteúdo público; pode iniciar checkout
        └──────┬───────┘
   login social │  (Google/Apple/X via Supabase Auth, redirect do domínio da org)
               ▼
        ┌──────────────┐
        │ AUTHENTICATED │  tem auth.user, mas pode NÃO ser membro desta org ainda
        │ (não-membro)  │  → vê "vire membro" / checkout; área de membro bloqueada
        └──────┬───────┘
   checkout ok  │  (subscription ativa cria/ativa member nesta org)
               ▼
        ┌──────────────┐    grace/dunning     ┌──────────────┐
        │  MEMBER ATIVO │ ───────────────────► │ MEMBER EM     │
        │               │ ◄─────────────────── │ ATRASO (grace)│ vê banner "regularize"
        └──────┬───────┘   pagamento ok        └──────┬───────┘  mantém acesso até fim do grace
   cancel/expira │                                     │ fim do grace sem pagar
               ▼                                       ▼
        ┌──────────────┐                       ┌──────────────┐
        │  EX-MEMBER    │  perde entitlements;  │  SUSPENSO     │ acesso gated revogado
        │ (inativo)     │  member card "inativo"│               │ (entitlements off)
        └──────────────┘                       └──────────────┘
```

Estados derivados (o front **não** decide, **lê** do backend):
- `member.status` (active / past_due / suspended / canceled) → vem de `subscriptions` + `members` (domínio payments-billing).
- O front renderiza UI por estado, mas **nunca** concede acesso por conta própria. Gating de conteúdo/perk é checado no servidor a cada acesso (signed URL / verificação de entitlement), nunca só no client (que é forjável).

> **Edge case — a mesma pessoa em várias orgs.** Um `auth.user` pode ser membro de várias orgs (cada org tem seu domínio). A sessão Supabase é **por domínio/origem** (cookies isolados por host). Logo, logar em `furia.stanbase.app` **não** loga em `clube.stanbase.app`. Isso é correto e desejado (isolamento). Member ID é global e único (doc §7), mas a relação `member` é por org. Em domínio próprio o isolamento de cookie é natural; em subdomínios `*.stanbase.app` precisamos garantir que o cookie de sessão **não** seja setado em `.stanbase.app` (apex) e vaze entre orgs — cookie escopo host-only.

#### 1.5 Fluxo passo a passo — landing → checkout → membro (caminho feliz)

1. Membro acessa `membros.furia.gg` (domínio próprio). Edge resolve org, injeta tema, serve landing com tiers (dados públicos via `GET /v1/public/orgs/{slug}/tiers`, cacheável). **SEO:** página renderizada server-side com meta tags/OG da org.
2. Membro escolhe tier "Camarote · Anual". Clica "Assinar".
3. Se anônimo → **login social** (Google/Apple/X). Redirect OAuth volta para o **domínio da org** (callback registrado por domínio). Após login → estado AUTHENTICATED.
4. Tela de checkout (`<TierCheckout/>`): mostra preço, **período**, e — se tri/sem/anual — **opção de parcelar até 12×** com **juros 3,49% a.m.** exibidos transparentes (modelo Hotmart, doc §13.3): "12× de R$ 62,06 (total R$ 744,70, juros inclusos)". Mensal **não** mostra parcelamento.
5. Membro confirma. Front chama `POST /v1/subscriptions` (domínio payments-billing) com `tier_id`, `period`, `installments`, `Idempotency-Key`. Backend cria cobrança no Asaas (Pix/cartão/boleto), faz split 7,99%.
6. Pagamento Pix → tela de QR Code Pix (polling/Realtime do status). Cartão → tokenização no PSP (PCI fica no Asaas, doc §26), retorna sucesso/3DS.
7. Webhook Asaas confirma pagamento → backend ativa `member` + `subscription` + `entitlements` → **Realtime** notifica o front → tela "Bem-vindo, você é membro!".
8. Member app oferece **"Adicionar ao Wallet"** (`<AddToWallet/>`) — detecta plataforma (iOS→Apple, Android→Google) e dispara `POST /v1/passport/issue`, recebe deep link `.pkpass`/`Save to Google Wallet`.
9. Membro agora vê **área do membro**: member card digital (mesma arte do passe), tier, perks ativos, conteúdo liberado, eventos, hall of fame.

#### 1.6 Regras de negócio concretas (do front)

- **Gating é server-side, sempre.** O front mostra/esconde como UX, mas conteúdo gated só é servido após verificação de entitlement no backend (signed URL com expiração — doc §15). Se o membro inspeciona o HTML, não acha o vídeo.
- **Preço e parcelamento nunca são calculados no front.** O front pede ao backend o "quote" (preço + tabela de parcelas com juros 3,49% a.m. já calculados, doc §13.3) e renderiza. Evita divergência de centavos e de regra.
- **Member card no front ≠ passe no Wallet, mas mesma fonte.** O member card renderizado na área do membro usa os mesmos dados/arte do passe (Member ID, tier, "membro desde", QR de verificação). O QR é a **URL de verificação assinada** (doc §8.4), não o Member ID cru.
- **Consentimento é granular por canal (LGPD, doc §17/§26).** Onboarding e a tela de preferências capturam consentimento por canal (e-mail, push, WhatsApp) com base legal e timestamp. O front **bloqueia** envio de push até consentimento (e o backend também — defesa em profundidade).
- **PWA não substitui Wallet.** A carteirinha "de verdade" vive no Apple/Google Wallet (nativo). O PWA é a área de membro instalável; o member card dentro dele é uma **réplica visual** + atalho para o Wallet.
- **Domínio próprio só funciona após verificação DNS** (status `verified` em `org_domains`). Antes disso, o membro usa o subdomínio `*.stanbase.app`.

#### 1.7 PWA — instalação, offline e push

- **Instalável:** `manifest.webmanifest` **gerado por org** (nome, ícones com a logo da org, cores do tema, `start_url` = área do membro). Edge serve o manifest correto por host.
- **Offline (Service Worker):** estratégia **stale-while-revalidate** para o app shell e assets; **network-first com fallback** para dados do membro. O **member card** (Member ID, tier, QR estático de verificação) é **cacheado para funcionar offline** — caso de uso real: portaria sem sinal, o membro mostra o card. (O QR offline cai na garantia de validação offline do doc §8.4: assinatura local + check; status "ao vivo" só online.)
- **Push (Web Push):** opcional, com consentimento. iOS exige PWA **instalada na home** para permitir Web Push (Safari ≥16.4). Notificações de pagamento, evento, drop. Backend dispara via domínio `communication`.
- **Atualização do SW:** novo deploy → SW novo → banner "nova versão disponível, recarregar" (evita servir bundle velho com API nova).

#### 1.8 Deep links e wallet (edge cases reais)

- **iOS Apple Wallet:** servir `.pkpass` com `Content-Type: application/vnd.apple.pkpass`; o Safari abre o prompt "Adicionar". Em **Chrome iOS / in-app browsers** (Instagram, TikTok webview) o `.pkpass` pode não abrir — detectar webview e mostrar "abra no Safari" ou enviar por e-mail/link.
- **Android Google Wallet:** link `https://pay.google.com/gp/v/save/{jwt}`. Funciona em Chrome; em webviews idem (fallback link/e-mail).
- **Universal/App Links:** se houver app nativo no futuro, `apple-app-site-association` e `assetlinks.json` por domínio. No MVP (sem app), os deep links são só Wallet.
- **Retorno do OAuth e do checkout** deve preservar a rota de origem (deep link interno): `?return_to=/eventos/123`. Sanitizar `return_to` (só paths internos, nunca host externo — open redirect).

---

### 2. Modelo de dados

> A maior parte do estado do membro vive em tabelas de outros domínios (`members`, `member_profiles`, `subscriptions`, `entitlements`, `passes`, `content_items`...). Este domínio adiciona o que é **específico do front hosted**: domínios próprios, tema/brand publicado, preferências/consentimento, e estado de PWA/push.

#### 2.1 Tabelas novas

| Tabela | Campos-chave | Observações |
|---|---|---|
| `org_domains` | `id`, `org_id`, `host` (UNIQUE global), `type` (`subdomain`/`custom`), `status` (`pending`/`verifying`/`verified`/`failed`), `ssl_status`, `verification_token`, `txt_record`, `cname_target`, `verified_at`, `created_at` | Resolução host→org. `host` UNIQUE global (um domínio = uma org). |
| `org_brand` | `org_id` (PK), `logo_url`, `logo_dark_url`, `favicon_url`, `color_primary`, `color_accent`, `font_heading`, `font_body`, `theme_mode` (`light`/`dark`/`auto`), `member_card_art_url`, `og_image_url`, `custom_css` (jsonb tokens), `updated_at` | 1:1 com org. Override dos tokens default (ivory/ink/gold/obsidian, fonts Jost/Hanken/Space Mono — doc §24.1). `custom_css` controlado (lista de tokens permitidos, não CSS arbitrário — XSS). |
| `member_preferences` | `member_id` (PK), `locale` (`pt-BR`/`en-US`/`es`), `timezone`, `theme_mode_pref`, `notif_email` (bool), `notif_push` (bool), `notif_whatsapp` (bool), `marketing_opt_in` (bool), `updated_at` | Preferências de UX + canal. |
| `member_consents` | `id`, `member_id`, `org_id`, `channel` (`email`/`push`/`whatsapp`/`sms`), `purpose` (`transactional`/`marketing`), `granted` (bool), `legal_basis`, `consent_text_version`, `source` (`onboarding`/`settings`/`checkout`), `ip`, `user_agent`, `granted_at`, `revoked_at` | **Imutável append-only** (cada mudança = nova linha). Trilha de auditoria LGPD (doc §26). |
| `push_subscriptions` | `id`, `member_id`, `org_id`, `endpoint` (UNIQUE), `p256dh`, `auth`, `platform` (`web-push`/`fcm`), `ua`, `created_at`, `last_seen_at`, `revoked_at` | Web Push por device. |
| `member_app_sessions` | `id`, `member_id`, `org_id`, `device_id`, `pwa_installed` (bool), `last_seen_at`, `sw_version` | Telemetria leve (instalou PWA? versão do SW?) — opcional, com consentimento de analytics. |
| `pwa_install_prompts` | `member_id`, `shown_at`, `outcome` (`accepted`/`dismissed`/`unavailable`) | Para não martelar o prompt de instalação. |

#### 2.2 Tabelas tocadas (de outros domínios)

| Tabela | Mudança | Por quê |
|---|---|---|
| `organizations` | usar `domain`, `brand` (já no doc §25.1) — `domain` migra para `org_domains` (1 org pode ter subdomínio + custom). | Multi-domínio por org. |
| `members` | leitura: `status`, `member_id`, `tier_id`, `joined_at`. | Render do member card e gating. |
| `member_profiles` | leitura/escrita de `name`, `photo_url`, `social`. | Tela de perfil. |

#### 2.3 Índices e constraints

- `org_domains(host)` **UNIQUE** + índice (lookup quente por host em toda request). `org_domains(org_id)`.
- `org_domains`: CHECK `type IN ('subdomain','custom')`; subdomínios reservados (`www`, `api`, `app`, `admin`, `verify`, `mail`...) bloqueados por trigger/lista.
- `member_consents(member_id, channel, purpose)` índice; **sem** unique (append-only — o "atual" é o último por `granted_at`). View `current_consents` materializada/derivada para leitura rápida.
- `push_subscriptions(endpoint)` UNIQUE; `push_subscriptions(member_id)` índice.
- `member_preferences.locale` CHECK na lista `('pt-BR','en-US','es')` (doc §30, decisão i18n).
- **RLS:** `org_brand`, `org_domains` legíveis pelo público (são dados do front, não-PII) **mas** escrita só via admin (org_users). `member_preferences`, `member_consents`, `push_subscriptions` → RLS por `member_id` = membro logado (e por `org_id`).

---

### 3. API & Edge Functions

#### 3.1 Endpoints `/v1` específicos / consumidos pelo member app

```
# Resolução & branding (públicos, cacheáveis, sem PII)
GET   /v1/public/resolve?host={host}            # host → { org_id, slug, brand, locale, flags }
GET   /v1/public/orgs/{slug}/landing            # tiers públicos + textos + OG meta p/ SEO
GET   /v1/public/orgs/{slug}/tiers              # catálogo de tiers (preço, período, perks visíveis)
GET   /v1/public/orgs/{slug}/manifest.webmanifest   # manifest PWA por org
GET   /v1/public/orgs/{slug}/checkout-quote     # quote: preço + tabela de parcelas (juros 3,49% a.m.)

# Área do membro (JWT do membro; muitos via supabase-js direto, mas expostos p/ headless)
GET   /v1/me                                    # perfil + tier + status do membro logado
PATCH /v1/me                                    # atualizar nome/foto/social
GET   /v1/me/membership                         # member card data (member_id, tier, since, QR url)
GET   /v1/me/entitlements                       # perks ativos
GET   /v1/me/content                            # conteúdo liberado (gated, server decide)
GET   /v1/me/events                             # eventos/ingressos do membro
GET   /v1/me/hall-of-fame                       # posição/conquistas do membro
GET   /v1/me/preferences  ·  PATCH /v1/me/preferences
POST  /v1/me/consents                           # registra/atualiza consentimento (append)
POST  /v1/me/push/subscribe  ·  POST /v1/me/push/unsubscribe

# Checkout & wallet (delegam a payments-billing / passport)
POST  /v1/subscriptions                         # (payments-billing) assinar tier
POST  /v1/passport/issue                        # (passport) emite pkpass / Google Wallet JWT
```

> Endpoints `me/*` são **açúcar** sobre os recursos já existentes, escopados ao membro logado (sem precisar passar `memberId`). Em headless, a org usa os recursos canônicos (`/v1/members/{id}/...`); o member app usa `me/*` por conveniência e segurança (o `member_id` vem do JWT, nunca do path).

#### 3.2 Edge Functions / componentes server-side

| Função | Tipo | Descrição |
|---|---|---|
| `member-app-ssr` | Edge (serve HTML) | Resolve host→org, injeta tokens de tema + OG meta + `<script>__STANBASE_ORG__</script>` no `index.html`. Evita FOUC e dá SEO. |
| `domain-verify` | Edge + job | Cria registros TXT/CNAME, verifica DNS, provisiona SSL (via provedor/Cloudflare/Caddy on-the-fly TLS). |
| `manifest-generator` | Edge | Gera `manifest.webmanifest` por org (ícones, cores, start_url). Cacheável. |
| `checkout-quote` | Edge | Calcula preço + tabela de parcelas (juros 3,49% a.m. compostos / Price, teto 12×, só tri/sem/anual). Fonte única de cálculo (delega a payments-billing). |
| `content-signed-url` | Edge | Verifica entitlement do membro e devolve signed URL temporária do conteúdo gated (delega a content-gating). |
| `og-image` | Edge (opcional) | Gera imagem OG dinâmica por org/tier (compartilhamento social). |

#### 3.3 Jobs / cron

| Job | Frequência | O quê |
|---|---|---|
| `domain-ssl-monitor` | a cada 6h | Reverifica SSL/DNS dos domínios próprios; marca `failed` e alerta org. |
| `push-prune` | diário | Remove `push_subscriptions` expiradas (endpoints 410/404 do push service). |
| `pwa-asset-precache-warm` | no deploy | Invalida CDN e pré-aquece app shell por org. |

---

### 4. Telas / Front

> Telas do **membro** (este é o app do membro). As telas de **admin** que tocam este domínio (configurar tema, domínio, textos da landing) vivem no `admin-app`, mas são listadas aqui como dependência de produto.

#### 4.1 Telas do membro (app hosted / PWA)

1. **Landing / Tiers** — hero branded, lista de tiers com preço/período/perks, CTA "Assinar". Pública, SEO-otimizada, OG tags. Componente raiz do `<TierCheckout/>`.
2. **Checkout** — seleção de período, **parcelamento até 12× com juros visíveis** (só tri/sem/anual), método (Pix QR / cartão / boleto), resumo. Estado de espera Pix (Realtime).
3. **Login social** — Google / Apple / X. Tela mínima branded. `return_to` preservado.
4. **Onboarding** — completar perfil (nome/foto), **consentimento por canal** (LGPD), idioma, prompt "Adicionar ao Wallet" + "Instalar app".
5. **Área do membro (home)** — **member card digital** (arte do passe, Member ID, tier, "membro desde", QR), status, atalhos.
6. **Carteirinha / Wallet** — member card grande + botões `<AddToWallet/>` (Apple/Google, detecta plataforma) + QR de verificação.
7. **Perks** — lista de entitlements ativos com estado (ativo/expira em X), CTA por tipo (abrir Discord, resgatar drop, etc.).
8. **Conteúdo gated** — biblioteca por tier (VOD, lives, posts); player com signed URL; estados "liberado/bloqueado/upgrade para ver".
9. **Eventos / Ingressos** — eventos da org, compra/lote de membro, ingressos do membro (cada um vira passe).
10. **Hall of Fame** — ranking público (opt-in), conquistas/badges do membro, posição.
11. **Perfil & Preferências** — editar perfil, idioma/tema, **preferências de notificação por canal**, gerenciar consentimento, **exportar/excluir meus dados** (LGPD self-service, doc §26).
12. **Estados de erro/limite** — 404 branded, "domínio não verificado", "membership inativa/regularize", offline (app shell servido pelo SW).

#### 4.2 SDK & embeds (modo híbrido — doc §24.3 / §5.3)

| Componente | Forma | O que faz |
|---|---|---|
| `<TierCheckout org tier />` | React + iframe embed | Checkout completo (preço, parcelamento, Pix/cartão). Pós-pagamento dispara callback/postMessage. |
| `<MemberCard memberId />` | React + iframe | Renderiza a carteirinha (com/sem QR conforme escopo). |
| `<AddToWallet memberId />` | React (botão) | Detecta plataforma e dispara emissão + deep link Wallet. |
| `<VerifyBadge memberId />` | React + iframe | Selo "membro válido" (consome rota pública §9), embutível em qualquer site. |
| `embed.js` (loader) | script tag | Loader leve que monta os embeds via iframe (isolamento de CSS/estado, postMessage para comunicação cross-origin). |

> Embeds via **iframe** (não web component cru) para isolar CSS/JS do site host e proteger sessão. SDK React para quem quer integração nativa. Ambos batem na **mesma API pública** — paridade garantida.

---

### 5. Integrações externas

| Serviço | Como integra | Onde |
|---|---|---|
| **Supabase Auth** | Login social (Google/Apple/X) + sessão JWT do membro; callbacks OAuth registrados **por domínio**. | Login, sessão. |
| **Apple Wallet** | `.pkpass` servido com MIME correto; deep link nativo iOS. | `<AddToWallet/>`, carteirinha (delega a `passport`). |
| **Google Wallet** | Link `Save to Google Wallet` (JWT). | `<AddToWallet/>` (delega a `passport`). |
| **Asaas (via backend)** | Checkout → cobrança/split; Pix QR; tokenização cartão (PCI no PSP). Front **nunca** fala direto com Asaas. | Checkout (delega a `payments-billing`). |
| **Provedor DNS/SSL** (Cloudflare/Caddy on-demand TLS) | Verificação de domínio próprio + emissão automática de SSL. | `org_domains`, `domain-verify`. |
| **CDN/Edge** (Vercel/Cloudflare) | Servir app shell, SSR do `index.html` por host, cache de assets/manifest, imagens OG. | Performance, SEO, FOUC. |
| **Web Push (VAPID) / FCM** | Notificações no PWA (com consentimento). | `push_subscriptions` (dispara via `communication`). |
| **Twitch/YouTube/Vimeo (embeds)** | Players de conteúdo gated com acesso condicionado por signed URL. | Conteúdo gated (delega a `content-gating`). |
| **Analytics** (consent-gated) | Eventos de funil/produto (visitante→membro→upgrade) só com consentimento (doc §27). | Telemetria. |

---

### 6. Épicos & tarefas

#### Épico A — Shell do app & resolução multi-tenant por domínio
- A1. Bootstrap `apps/member` (React 18 + Vite + Router + TanStack Query + design-system tokens). **S**
- A2. Edge `member-app-ssr`: resolve host→org, injeta tokens de tema + `__STANBASE_ORG__` no HTML (anti-FOUC). **L**
- A3. `GET /v1/public/resolve?host=` + cache CDN/KV (lookup quente). **M**
- A4. Tabela `org_domains` + RLS pública de leitura + reservas de subdomínio. **M**
- A5. Provider de tema em runtime (CSS vars a partir de `org_brand`, light/dark/auto). **M**
- A6. Estado de sessão por host (cookie host-only, isolamento entre orgs em `*.stanbase.app`). **M**

#### Épico B — Theming & branding
- B1. Tabela `org_brand` + tokens default (ivory/ink/gold/obsidian, Jost/Hanken/Space Mono — doc §24.1). **S**
- B2. Aplicação de logo/cores/fontes/member-card-art em runtime + fallback para default. **M**
- B3. `custom_css` como allowlist de tokens (anti-XSS), não CSS arbitrário. **M**
- B4. Favicon/OG/manifest icons por org (geração de ícones PWA). **M**

#### Épico C — Domínio próprio & SSL
- C1. Fluxo de verificação (TXT/CNAME), UI no admin, estados pending→verified→failed. **L**
- C2. Provisão automática de SSL (Cloudflare for SaaS / Caddy on-demand TLS). **L**
- C3. Job `domain-ssl-monitor` + alertas de expiração/falha. **M**
- C4. 404 branded para host desconhecido/não verificado. **S**

#### Épico D — Landing, checkout & onboarding
- D1. Landing/Tiers branded + SSR + OG/SEO meta + `GET /v1/public/orgs/{slug}/landing`. **L**
- D2. `<TierCheckout/>`: período + **parcelamento até 12× com juros 3,49% a.m. visíveis** (só tri/sem/anual). **L**
- D3. `checkout-quote` Edge (preço + tabela de parcelas; fonte única, delega payments-billing). **M**
- D4. Estados de pagamento: Pix QR + Realtime de confirmação; cartão (3DS); boleto. **L**
- D5. Login social branded + callbacks OAuth por domínio + `return_to` sanitizado. **M**
- D6. Onboarding: perfil + **consentimento por canal** + idioma + prompt Wallet/instalar. **M**

#### Épico E — Área do membro (telas core)
- E1. Member card digital (arte do passe, Member ID, tier, since, QR de verificação). **M**
- E2. `<AddToWallet/>` (detecção iOS/Android, deep links, fallback webview/e-mail). **M**
- E3. Perks/entitlements (lista + CTA por tipo). **M**
- E4. Conteúdo gated (biblioteca + player com signed URL + estados upgrade). **L**
- E5. Eventos/ingressos do membro (lista + compra + ingresso vira passe). **L**
- E6. Hall of Fame (ranking opt-in + conquistas/badges). **M**
- E7. Perfil & Preferências + **self-service LGPD (exportar/excluir)**. **M**

#### Épico F — PWA, offline & push
- F1. `manifest-generator` por org + Service Worker (Workbox): app shell SWR, dados network-first. **L**
- F2. Member card **offline** (cache + QR estático que valida offline — doc §8.4). **M**
- F3. Prompt de instalação (não-intrusivo, `pwa_install_prompts`, sem martelar). **S**
- F4. Web Push (VAPID), `push_subscriptions`, fluxo de consentimento iOS (PWA instalada). **L**
- F5. Banner "nova versão" no update do SW (anti bundle velho). **S**

#### Épico G — SDK & embeds (híbrido)
- G1. `packages/sdk-js` cliente React + tipos (gerado do OpenAPI). **M**
- G2. `<TierCheckout/>`, `<MemberCard/>`, `<AddToWallet/>`, `<VerifyBadge/>` como embeds iframe + React. **L**
- G3. `embed.js` loader + protocolo postMessage (eventos de sucesso/erro cross-origin). **M**
- G4. Doc + exemplos de embed/headless (paridade de API). **M**

#### Épico H — i18n, SEO & performance mobile
- H1. i18n pt-BR / en-US / es (doc §30): biblioteca, detecção (preferência > Accept-Language > default da org), formato moeda/data. **M**
- H2. SEO: SSR/meta/OG/sitemap por org + robots por domínio + canonical. **M**
- H3. Performance mobile: code-splitting por rota, lazy load, critical CSS inline, budget de bundle, imagens responsivas/AVIF, Core Web Vitals (LCP/CLS/INP) por org. **L**
- H4. Acessibilidade (a11y) base (WCAG AA): foco, contraste por tema, leitor de tela no member card. **M**

#### Épico I — Analytics & consentimento
- I1. Camada de analytics consent-gated (funil visitante→membro→upgrade, doc §27). **M**
- I2. `member_consents` append-only + view de consentimento atual + enforcement no front e backend. **M**

---

### 7. Dependências

| Domínio | Por quê |
|---|---|
| `fundacao` | Monorepo (`apps/member`), Supabase, RLS, design-system tokens, geração de tipos, CI/CD, regra app-interno vs API `/v1`. **Bloqueante.** |
| `auth-rbac` | Custom Access Token Hook (claims `org_id`/`member_id`), OAuth providers, isolamento — base da sessão do membro. **Bloqueante.** |
| `member-identity` | Member ID (8 chars), relação `member`/`member_profiles`, login social do membro, member card data. **Bloqueante.** |
| `design-system` | Tokens (ivory/ink/gold/obsidian, Jost/Hanken/Space Mono), componentes UI, modo claro/escuro. **Bloqueante** para theming. |
| `tiers-perks` | Catálogo de tiers/perks/entitlements que a landing e a área do membro renderizam. |
| `payments-billing` | Checkout, split Asaas, parcelamento (juros 3,49% a.m.), Pix/cartão, status de subscription. **Bloqueante** para checkout. |
| `passport` | Emissão de `.pkpass`/Google Wallet JWT que o `<AddToWallet/>` dispara; arte do member card. |
| `verification-checkin` | Rota pública de validação (QR do member card / `<VerifyBadge/>`). |
| `content-gating` | Signed URLs e verificação de entitlement do conteúdo gated. |
| `events-tickets` | Eventos/ingressos exibidos e comprados na área do membro. |
| `hall-of-fame` | Ranking/conquistas exibidos ao membro. |
| `communication` | Disparo de Web Push / e-mail respeitando consentimento. |
| `community-channels` | CTAs de perk que levam a Discord/Telegram/WhatsApp. |
| `public-api` | Contrato `/v1`, paginação, idempotência, SDK/MCP gerados do OpenAPI (paridade do híbrido/headless). **Bloqueante** para SDK/embeds. |
| `security-lgpd` | Consentimento, minimização, self-service de exportar/excluir, allowlist de `custom_css`. |
| `observability-qa` | Core Web Vitals, erros do front, funil de analytics. |

---

### 8. Riscos & decisões técnicas

- **FOUC de tema (flash do tema errado).** Mitigação: resolução de org no **edge** + tokens inline no HTML inicial (não esperar hidratar). Risco se cair em SPA-only.
- **Multi-tenant por domínio é a maior fonte de bug.** Resolver host→org tem que ser à prova de cache envenenado (cache key = host) e de host spoofing (validar `Host`/`X-Forwarded-Host`). 404 branded para hosts desconhecidos.
- **SSL automático em domínio próprio** é operacionalmente pesado (rate limits do Let's Encrypt, propagação DNS, renovação). Recomendo Cloudflare for SaaS / on-demand TLS gerenciado em vez de rodar ACME na mão.
- **Isolamento de sessão entre orgs em `*.stanbase.app`.** Cookie precisa ser host-only (não setar no apex `.stanbase.app`), senão um membro de uma org enxerga sessão de outra. Em domínio próprio é natural. **Edge case de segurança crítico.**
- **Web Push no iOS** só funciona com PWA instalada na home (Safari 16.4+). UX precisa orientar a instalação antes de prometer push no iOS.
- **`.pkpass`/Google Wallet em in-app webviews** (Instagram/TikTok/X) frequentemente não abrem o Wallet. Detectar webview e oferecer "abrir no navegador" / enviar por e-mail/link.
- **Gating só no front é forjável.** Reforço: conteúdo gated sempre via signed URL server-side; o front é só UX. Nunca embutir URL do vídeo no bundle.
- **Parcelamento exibido errado = problema legal/financeiro.** O front **nunca** calcula juros; pede `checkout-quote` ao backend (fonte única, 3,49% a.m., teto 12×, só tri/sem/anual, mensal nunca). Centavos têm que bater com a cobrança Asaas.
- **`custom_css` por org = vetor de XSS/defacement.** Só allowlist de tokens (cor/fonte/raio), nunca CSS/HTML arbitrário injetado no DOM de outros membros.
- **SEO de SPA.** Sem SSR/pré-render, a landing não indexa bem. Landing e páginas públicas precisam de SSR/edge render com meta/OG; área do membro pode ser SPA pura (não indexável de propósito).
- **Performance mobile (público popular).** Budget de bundle agressivo, code-splitting, imagens AVIF/responsivas; medir Core Web Vitals reais por org (não só lab) — membros entram por celular barato em 4G.
- **Cache de dados públicos vs. frescor.** Tiers/preços são cacheáveis, mas mudança de preço/tier no admin precisa invalidar CDN (purge por org). Evitar mostrar preço velho no checkout.
- **i18n + moeda.** No MVP a moeda é BRL (Asaas Brasil-first), mas o idioma pode ser en-US/es. Cuidar de não confundir idioma com moeda (es ≠ ARS). Conteúdo da org (nome de tier, descrição) não é traduzido automaticamente — i18n cobre só a chrome do app.
- **Deep link de retorno (open redirect).** `return_to` tem que ser sanitizado para paths internos.

---

### 9. Escopo MVP vs. depois

**No MVP (doc §29 Fase 1 — "front de membro hosted temável: login social, checkout de tier, área do membro"):**
- Shell temável + resolução por **subdomínio** `*.stanbase.app` (domínio próprio entra logo depois).
- Theming básico (logo, cores, fonte, light/dark) a partir de `org_brand`.
- Landing/Tiers + **checkout com parcelamento** (Pix/cartão) + login social.
- Área do membro: **member card**, tier, **perks**, **Adicionar ao Wallet**, perfil/preferências + **consentimento (LGPD)**.
- Conteúdo gated (lista + player gated) e eventos/ingressos básicos (alinhado às Fases 1–2).
- **PWA instalável** + member card **offline**.
- i18n pt-BR (estrutura pronta para en-US/es).
- SEO básico (SSR da landing, OG/meta).

**Depois (Fase 5 / pós-MVP):**
- **Domínio próprio + SSL automático** (subdomínio cobre o MVP; doc §30 deixa em aberto se custom domain entra desde o MVP).
- **SDK JS/React + embeds** (`<TierCheckout/>`, `<MemberCard/>`, `<AddToWallet/>`, `<VerifyBadge/>`) e modo **híbrido/headless** documentado (doc §29 Fase 4).
- **Web Push** (especialmente iOS) e notificações ricas.
- i18n completo en-US/es ligado.
- Hall of Fame público, OG dinâmico, otimizações avançadas de Core Web Vitals.
- App nativo iOS/Android (doc §30: "não terá app na v0"; PWA basta).
