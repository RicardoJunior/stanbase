## 23. Design System & Theming (white-label)

> Domínio que entrega a **camada visual** da Stanbase: o conjunto de **tokens de design** derivados da identidade da marca, a **biblioteca de componentes base** (React + TS + Tailwind) compartilhada por todos os apps, e a **engine de theming white-label** que permite cada org "vestir" o front de membro com sua própria marca (logo, cores, tipografia, claro/escuro, arte do member card) sem uma única linha de código.
>
> Fonte de verdade: STANBASE.md §24 (Front padrão temável / white-label), §6.1 (stack: Tailwind + design system próprio com tokens da identidade), §5.1 (modo Hosted temável + domínio próprio + SSL), §10.3 / §10 (admin **padronizado** — *não* temável), §1 (verticais — a mesma engine veste qualquer marca). Decisões imutáveis aplicadas: paleta da identidade (ivory `#f5f3ed`, paper `#fffefb`, ink `#16150f`, gold `#b8965a`/`#8a6a32`, obsidian `#15140f`); fontes **Jost** (display) / **Hanken Grotesk** (body) / **Space Mono** (mono); **admin é padronizado/não-tematizável**, **front de membro é tematizável**; **1 membership por org** (uma marca por org); i18n pt-BR/en-US/es (§30.5).
>
> **Princípio central deste domínio:** o front de membro é **um produto único, temável** — *não* um tema por cliente codado à mão (§24). O código é idêntico para todos os tenants; o que muda é **dado em tabela** (o `theme` da org) resolvido em runtime. Por isso o design-system é, ao mesmo tempo, (a) uma **biblioteca de UI** consumida por `admin-app`/`member-app`/`superadmin` e (b) uma **engine de resolução de tema** por org com garantias de acessibilidade e fallback.

---

### 23.1 Como funciona

#### 23.1.1 As duas superfícies: tematizável vs. não-tematizável

A regra de ouro que governa todo o domínio (do §10 vs. §24 do doc):

| Superfície | Tematizável? | Tokens que usa |
|---|---|---|
| **`apps/admin`** (painel do dono) | **NÃO.** "Sólido e igual pra todo mundo" (§10). | **Tokens da identidade Stanbase** (ivory/ink/gold/obsidian, Jost/Hanken/Space Mono). Só varia o **logo da org no header** e talvez 1 cor de acento de marca em chips/avatares — nunca o chrome do app. |
| **`apps/member`** (front do fã, hosted) | **SIM.** White-label completo. | **Tokens resolvidos do tema da org** (sobrepõem os defaults da identidade). |
| **`apps/superadmin`** (Stanbase staff) | **NÃO.** | Tokens da identidade Stanbase (idêntico ao admin, sem logo de org). |
| **Página pública de verify / hall-of-fame público** | **SIM** (parcial). | Tema da org (logo, cor, modo), mas com layout fixo e PII minimizada (§9.2). |
| **Passport (passes Apple/Google)** | **SIM** (arte). | Tema da org (logo + cores + arte do member card) — *gerado*, não renderizado em React (domínio passport consome os mesmos tokens). |

> *Por que isto importa:* misturar as duas superfícies é o erro arquitetural número 1 deste domínio. Um componente do design-system precisa saber **em qual modo está rodando**. A solução: o **mesmo `<Button>`** funciona nos dois, mas o `ThemeProvider` injeta **tokens da identidade** (constantes) no shell admin e **tokens resolvidos da org** (variáveis) no shell member. O componente nunca hard-codeia `#b8965a`; ele lê `var(--color-primary)`. No admin, `--color-primary` = gold da identidade (fixo). No member, `--color-primary` = a cor da org.

#### 23.1.2 Arquitetura de tokens (3 camadas)

Tokens em **três níveis**, do mais abstrato ao mais concreto (padrão "primitive → semantic → component"):

1. **Tokens primitivos (raw)** — a paleta crua e a escala tipográfica. Imutáveis, são a "fonte de cor". Ex.: `--ivory: #f5f3ed`, `--paper: #fffefb`, `--ink: #16150f`, `--gold-500: #b8965a`, `--gold-700: #8a6a32`, `--obsidian: #15140f`; escala neutra derivada (`--neutral-50..950`); escala de espaçamento, raio, sombra, tipografia (`--font-display: "Jost"`, `--font-body: "Hanken Grotesk"`, `--font-mono: "Space Mono"`).
2. **Tokens semânticos (role)** — o que cada cor **significa**, não o que ela **é**. Ex.: `--color-bg`, `--color-surface`, `--color-text`, `--color-text-muted`, `--color-primary`, `--color-primary-contrast`, `--color-accent`, `--color-border`, `--color-success/-warning/-danger`, `--color-focus-ring`. **É esta camada que o tema da org sobrescreve.** No modo claro `--color-bg` = paper; no escuro = obsidian.
3. **Tokens de componente** — quando um componente precisa de um token próprio (ex.: `--member-card-bg`, `--member-card-foil`). Derivam dos semânticos.

> O tema da org **só pode tocar a camada semântica** (e um subconjunto dela — ver §23.1.4). Nunca a primitiva (senão quebraria a identidade Stanbase do admin) nem a de componente diretamente. Isso limita a "explosão" de overrides e garante que toda customização passe pelo pipeline de contraste.

#### 23.1.3 Pipeline de resolução de tema (member-app) — passo a passo

```
[request no domínio da org]
   → resolve org (subdomínio org.stanbase.com OU domínio próprio via custom_domains)
   → carrega org_themes (versão publicada) + assets (logo/arte) das URLs do Storage
   → merge: defaults da identidade  ⊕  overrides da org (deep-merge na camada semântica)
   → valida acessibilidade (contraste AA) → se falha, aplica fallback/auto-ajuste e registra warning
   → resolve modo (claro/escuro) por org + preferência do usuário (prefers-color-scheme / toggle)
   → gera CSS custom properties (:root e [data-theme="dark"])
   → injeta no <head> ANTES do paint (SSR/edge) para evitar flash (FOUC/FOIT)
   → ThemeProvider expõe tokens resolvidos via context (para JS que precisa, ex.: charts, member card)
```

Regras concretas:
- **Resolução server-side / edge-first.** Para não haver *flash of unstyled/wrong theme* (FOUC) nem *flash of default brand*, o CSS de variáveis da org é resolvido na borda (Edge Function/CDN) e **inlined no `<head>`** do HTML inicial. O React hidrata sobre um tema já correto.
- **Deep-merge, não replace.** A org só informa os tokens que quer mudar (ex.: `--color-primary`). Tudo o que não informar herda os defaults da identidade. Nunca se exige a org definir 80 tokens.
- **Versão publicada × rascunho.** O member-app público sempre serve a **versão publicada** (`status='published'`) do tema. O preview do admin serve o **rascunho** (`status='draft'`) — ver §23.1.6.
- **Cache + invalidação.** Tema resolvido é cacheado (CDN/edge) por org+version+mode. Publicar nova versão **invalida** o cache daquela org (purge por chave `org:{id}:theme`).

#### 23.1.4 Superfície de customização da org (o que pode mudar)

O que o dono **pode** customizar no member-app (subconjunto controlado da camada semântica + assets):

| Item | Token/asset | Constraint |
|---|---|---|
| **Logo** (claro/escuro/ícone) | `assets.logo_light`, `assets.logo_dark`, `assets.icon` | upload, formatos PNG/SVG/WebP; validação de dimensão/peso; gera variantes (favicon, PWA icons, og:image) |
| **Cor primária** | `--color-primary` | passa por validação de contraste; `--color-primary-contrast` é **derivado automaticamente** (não escolhido) |
| **Cor de realce/acento** | `--color-accent` | idem |
| **Tipografia display** | `--font-display` | de uma **lista curada** de fontes (Google Fonts + as 3 da identidade) ou upload self-hosted (pós-MVP) |
| **Tipografia body** | `--font-body` | idem |
| **Modo padrão** | `theme.default_mode` | `light` / `dark` / `system` |
| **Dark mode habilitado** | `theme.dark_enabled` | se a org não curou o dark, esconde o toggle e força light |
| **Arte do member card** | `assets.member_card_art` + `theme.member_card` | imagem de fundo, posição do logo, estilo do foil/efeito 3D, cor do texto sobre a arte |
| **Raio/estilo** (opcional, pós-MVP) | `--radius-base`, densidade | presets ("redondo"/"reto"), não slider livre |

O que o dono **não pode** mudar (para preservar consistência e qualidade): layout das telas, posição de componentes, fontes mono (Space Mono fixa para Member ID/código — legibilidade), escala de espaçamento, tom de erro/sucesso semântico (vermelho/verde mantêm significado universal), o chrome do admin.

#### 23.1.5 Acessibilidade & contraste com cores custom (edge case central)

Cores escolhidas pelo dono **não podem quebrar legibilidade**. Pipeline obrigatório a cada publicação de tema:

1. **Cálculo de contraste** (WCAG 2.1, razão de luminância) para todos os pares críticos: `text/bg`, `text-muted/bg`, `primary-contrast/primary`, `accent-contrast/accent`, `border/bg`, `focus-ring/bg`, e os mesmos pares no **modo escuro**.
2. **Threshold:** AA (4.5:1 texto normal, 3:1 texto grande/UI). Avisar (não bloquear) se cair só no AA-large; **bloquear publicação** se cair abaixo de 3:1 em par de texto.
3. **Derivação automática do `*-contrast`:** dada `--color-primary`, o sistema **calcula** se o texto sobre ela deve ser claro ou escuro (escolhe ink ou paper, o que tiver melhor contraste), em vez de deixar a org escolher e errar.
4. **Auto-ajuste suave (opcional, configurável):** se a cor primária da org fica ruim sobre o bg no modo escuro, oferecer um **"primary derivado para dark"** (clarear/escurecer L no espaço OKLCH preservando matiz) em vez de usar a mesma cor crua. A org pode aceitar o ajuste ou ajustar manualmente.
5. **Daltonismo:** simulação (protanopia/deuteranopia/tritanopia) no preview; aviso se primary e accent ficam indistinguíveis.
6. **Foco visível sempre:** `--color-focus-ring` é garantido com contraste ≥3:1 contra o bg; se a cor da org não serve, usa um fallback de alto contraste.

> *Decisão:* contraste é **gate de publicação**, não sugestão cosmética. Uma org não pode publicar um tema ilegível e culpar a Stanbase. O preview mostra o score de contraste em tempo real (badge verde/amarelo/vermelho por par).

#### 23.1.6 Preview ao vivo no admin — máquina de estados do tema

O editor de tema é um **rascunho versionado** com preview ao vivo lado a lado (iframe do member-app real apontando para o rascunho).

```
                    editar token/asset (autosave debounce)
   (sem tema)  ──create──►  draft  ◄───────────────────────┐
                              │                              │ editar de novo
                              │ validar contraste/fontes      │
                              ▼                              │
                          draft_valid ──publish──► published ─┘
                              │                       │
                       (falha validação)        rollback / nova versão
                              ▼                       ▼
                       draft_invalid           archived (versões antigas)
```

Regras:
- **Autosave do rascunho** (debounce ~800ms) → preview atualiza ao vivo via `postMessage` para o iframe (injeta o CSS novo sem reload).
- **Preview ao vivo** = iframe do member-app real (mesmas telas que o fã vê) renderizando com o tema **draft**, alternável entre **claro/escuro**, **mobile/desktop**, e telas-chave (landing/checkout, área do membro, member card, hall of fame). Não é mock — é o produto real.
- **Publicar** só é permitido se `draft_valid` (passou contraste/fontes). Publicar cria uma **nova versão imutável** (`version = n+1`, `status='published'`), arquiva a anterior, invalida cache, e (se a arte do member card mudou) **dispara re-push de passes** (job `passport-brand-resync` do domínio passport — §11).
- **Rollback** = republicar uma versão arquivada (vira a publicada corrente; não edita a antiga).
- **Tokens versionados:** cada publicação é uma linha imutável em `org_theme_versions`. Permite auditoria ("quem mudou a cor e quando"), rollback e A/B futuro. O `brand_version` (já usado pelo passport, §11) deriva da versão do tema.

#### 23.1.7 Member Card 3D (efeito da landing)

A carteirinha web (`<MemberCard/>`) reproduz o **efeito 3D da landing** — não é só uma imagem estática:

- **Tilt 3D interativo** (perspective + rotateX/rotateY) seguindo mouse/giroscópio, com brilho/foil (`gold` da identidade ou cor da org) que se move com a inclinação (efeito holográfico).
- **Conteúdo:** logo da org, Member ID formatado (`B7K2-M9X4`, fonte Space Mono), tier (label + cor), "membro desde", status, QR (token assinado — domínio passport).
- **Arte de fundo customizável por org** (`assets.member_card_art`) com camadas: fundo/arte → foil/brilho → texto/QR.
- **Acessibilidade & performance:** respeita `prefers-reduced-motion` (desliga o tilt, mantém estático); degrada em devices fracos (sem giroscópio → só hover; sem hover/touch → estático). É também o **fallback** do passport quando não há Wallet (§11.1.7) e o **preview** da arte no editor.
- **Reuso:** mesmo componente em member-app, embed (`<MemberCard/>` do SDK), preview do admin e fallback do passport. Tema resolvido injeta a arte e as cores.

#### 23.1.8 Domínio próprio + SSL automático

Do §24.1 e §5.1: a org pode publicar em `membros.suacomunidade.com` (além de `org.stanbase.com`).

```
[admin adiciona custom domain]
   → status=pending_dns; mostramos registro CNAME/A alvo
   → org configura DNS no provedor dela
   → job verifica DNS (resolve → aponta pra nós?) → status=dns_ok
   → provisiona certificado TLS (ACME/Let's Encrypt ou via provedor de CDN/edge) → status=ssl_issued
   → roteamento: requests naquele host resolvem a org_id → tema → member-app
   → renovação automática do cert (job antes do vencimento)
```

> *Provisionamento de SSL* é infra compartilhada com `verify.*` e pertence parcialmente a `fundacao` (§12 verification-checkin já referencia "provisionamento de domínio/SSL para verify.*"). Este domínio entrega a **UX de adicionar domínio + o mapeamento host→org + o roteamento de tema**; o mecanismo ACME é da fundação. Edge cases em §23.8.

#### 23.1.9 Fontes — carregamento, fallback e FOIT

- **Fontes da identidade** (Jost, Hanken Grotesk, Space Mono) **self-hosted** (woff2, subset latin + latin-ext para pt/es), pré-carregadas (`<link rel="preload">`), `font-display: swap`. Nunca depender de Google Fonts em runtime (privacidade/LGPD + latência + bloqueio de CDN).
- **Fontes custom da org** (de lista curada): carregadas sob demanda; cada uma tem um **fallback stack** definido (ex.: Jost → `"Jost", system-ui, sans-serif`) com **metrics override** (`size-adjust`, `ascent-override`) para minimizar reflow/CLS na troca.
- **Fallback de fonte (edge case):** se a fonte custom da org **falha ao carregar** (CDN fora, subset faltando glifo, upload corrompido), cai para a fonte da identidade equivalente (display→Jost, body→Hanken) sem quebrar layout. Glifos ausentes (ex.: emoji, caractere CJK num nome) caem para system font.
- **FOIT/FOUC:** `swap` evita texto invisível; o CSS de tema inlined evita flash de cor errada; o member-app define a fonte de fallback com metrics próximas para o "salto" ser imperceptível.

---

### 23.2 Modelo de dados

Toda tabela de org carrega `org_id` e RLS por `org_id` (§26). Tokens/temas são **dados**, nunca código (princípio §10/§24). A coluna `brand` mencionada em §25.1 (`organizations`) é **substituída/expandida** por estas tabelas dedicadas (mantemos `organizations.brand` como cache denormalizado opcional do tema publicado para leitura rápida no header/passport, mas a fonte de verdade é `org_themes`).

#### `org_themes` (nova — rascunho corrente + ponteiro de publicado)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK organizations | **UNIQUE** — 1 tema por org (1 membership por org) · RLS |
| `draft_tokens` | jsonb | overrides semânticos do rascunho (só o que diverge do default) |
| `draft_assets` | jsonb | refs Storage: logo_light/dark/icon, member_card_art, favicon, og |
| `draft_member_card` | jsonb | config do member card (estilo foil, posição logo, texto sobre arte) |
| `draft_status` | enum `draft`/`draft_valid`/`draft_invalid` | gate de publicação |
| `draft_validation` | jsonb | resultado do pipeline de contraste/fontes (scores por par) |
| `default_mode` | enum `light`/`dark`/`system` | modo padrão do front |
| `dark_enabled` | boolean default true | esconde toggle se false |
| `published_version_id` | uuid FK org_theme_versions NULL | ponteiro p/ versão servida ao público |
| `updated_at` / `created_at` | timestamptz | |

#### `org_theme_versions` (nova — versões imutáveis publicadas; tokens versionados)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK | RLS · index `(org_id, version desc)` |
| `version` | int | incremental por org (1,2,3…) |
| `tokens` | jsonb | snapshot imutável dos overrides semânticos publicados |
| `assets` | jsonb | snapshot das refs de asset (logos/arte congeladas — ver edge case §23.8) |
| `member_card` | jsonb | snapshot da config do member card |
| `default_mode` / `dark_enabled` | — | snapshot |
| `validation` | jsonb | scores de contraste no momento da publicação (auditoria) |
| `status` | enum `published`/`archived` | só 1 `published` por org (parcial unique) |
| `published_by` | uuid | autor (auditoria) |
| `published_at` | timestamptz | |
| `brand_version` | int | = `version`; consumido pelo passport p/ detectar arte desatualizada |

- **Constraint:** índice parcial UNIQUE `(org_id) WHERE status='published'` (no máx. 1 publicado por org). `published_version_id` em `org_themes` aponta para ele.

#### `custom_domains` (nova — domínio próprio + SSL)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK | RLS |
| `host` | text UNIQUE global | ex.: `membros.suacomunidade.com` (lowercase, normalizado) |
| `target` | enum `member`/`verify` | qual app o host serve |
| `status` | enum `pending_dns`/`dns_ok`/`ssl_issued`/`active`/`error`/`disabled` | máquina de estados §23.1.8 |
| `verification_token` | text | TXT/CNAME de prova de posse |
| `dns_checked_at` | timestamptz | |
| `cert_provider` | text | provedor ACME/CDN |
| `cert_expires_at` | timestamptz | job de renovação |
| `last_error` | text | diagnóstico p/ admin |
| `created_at` | timestamptz | |

- Index `(host)` (lookup de roteamento por host → org, hot path), `(cert_expires_at)` (job de renovação), `(status)`.

#### `font_catalog` (nova — lista curada de fontes selecionáveis; global, sem org_id)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `key` | text UNIQUE | `jost`, `hanken-grotesk`, `space-mono`, `inter`, … |
| `display_name` | text | "Jost" |
| `category` | enum `display`/`body`/`mono` | onde pode ser usada |
| `source` | enum `identity`/`google`/`self_hosted` | |
| `files` | jsonb | woff2 por peso/subset (refs Storage) |
| `fallback_stack` | text | `"Jost", system-ui, sans-serif` |
| `metrics_override` | jsonb | size-adjust/ascent/descent p/ fallback sem CLS |
| `active` | boolean | curadoria |

> Global porque a curadoria é da Stanbase, idêntica para todos. Fontes upload self-hosted da org (pós-MVP) entram como `org_fonts` (mesma estrutura, com `org_id` + RLS) — fora do MVP.

#### `theme_assets` (nova — metadados dos assets de tema; arquivo no Storage)
| Coluna | Tipo | Notas |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK | RLS · path Storage `org/{org_id}/theme/...` |
| `kind` | enum `logo_light`/`logo_dark`/`icon`/`member_card_art`/`favicon`/`og_image` | |
| `storage_path` | text | |
| `mime` / `width` / `height` / `bytes` | — | validação |
| `variants` | jsonb | derivados gerados (favicon sizes, PWA icons, @1x/2x/3x) |
| `theme_version_id` | uuid FK NULL | congelado na publicação (ver §23.8 — asset imutável por versão) |
| `created_at` | timestamptz | |

> Tabelas tocadas de outros domínios: `organizations` (mantém `brand` como cache do publicado), `passes`/`wallet_classes` (consomem `brand_version` da versão publicada — §11), `audit_logs` (publicação/rollback de tema é auditável).

---

### 23.3 API & Edge Functions

#### Endpoints `/v1` (camada Edge — a maioria do theming é consumida pelo app interno via supabase-js+RLS, mas a resolução pública e a publicação passam por Edge por exigir cache/validação/segredos)

| Método | Rota | Descrição |
|---|---|---|
| GET | `/v1/theme/resolve?host=` | **Hot path público.** Resolve host→org, faz merge default⊕override da **versão publicada**, retorna tokens + assets + CSS pronto (ou referência cacheada). Edge-cacheado. Usado pelo SSR/edge do member-app. |
| GET | `/v1/orgs/{orgId}/theme` | Lê o tema (draft + published) para o editor do admin. |
| PUT | `/v1/orgs/{orgId}/theme/draft` | Salva rascunho (tokens/assets/member_card/mode). Dispara validação assíncrona. |
| POST | `/v1/orgs/{orgId}/theme/validate` | Roda o pipeline de contraste/fontes no rascunho; retorna scores por par (gate). |
| POST | `/v1/orgs/{orgId}/theme/publish` | Publica rascunho → nova `org_theme_versions`, congela assets, invalida cache, dispara re-push de passes se a arte mudou. Bloqueia se `draft_invalid`. |
| POST | `/v1/orgs/{orgId}/theme/rollback` | Republica uma versão arquivada (vira publicada corrente). |
| GET | `/v1/orgs/{orgId}/theme/versions` | Histórico de versões (auditoria/rollback). |
| POST | `/v1/orgs/{orgId}/theme/assets` | Upload de asset (logo/arte) → valida dimensão/peso/mime, gera variantes, retorna ref. |
| POST | `/v1/orgs/{orgId}/domains` | Adiciona domínio próprio → retorna alvo DNS + token de verificação. |
| GET | `/v1/orgs/{orgId}/domains` | Lista domínios + status (DNS/SSL). |
| POST | `/v1/orgs/{orgId}/domains/{id}/verify` | Força recheck de DNS/SSL. |
| DELETE | `/v1/orgs/{orgId}/domains/{id}` | Remove domínio (libera roteamento). |
| GET | `/v1/fonts` | Catálogo curado de fontes selecionáveis. |

> O **admin** lê/escreve o tema preferencialmente via `supabase-js`+RLS (rápido); `publish/validate/resolve/domains` passam por Edge porque envolvem cache, geração de CSS/variantes, segredos de ACME e o gate de contraste. Coerente com o §6.2 (dois caminhos de dados).

#### Jobs / workers

| Job | Trigger | Descrição |
|---|---|---|
| `theme-asset-pipeline` | evento de upload (pgmq) | Otimiza/redimensiona logos (@1x/2x/3x, favicon, PWA icons, og), gera member-card art layers, grava `variants`. |
| `theme-contrast-validator` | save de draft (pgmq, debounced) | Calcula contraste WCAG de todos os pares (light+dark), seta `draft_status`/`draft_validation`. |
| `domain-dns-checker` | pg_cron ~min + manual | Verifica propagação DNS dos domínios `pending_dns` → `dns_ok`. |
| `domain-ssl-provisioner` | após `dns_ok` (pgmq) | Provisiona cert TLS (ACME), seta `ssl_issued`/`active`. |
| `domain-cert-renewer` | pg_cron diário | Renova certs perto do `cert_expires_at`; alerta em falha. |
| `theme-cache-purge` | após publish/rollback | Invalida cache edge/CDN da org (`org:{id}:theme`). |
| `theme-brand-resync-trigger` | após publish (se arte mudou) | Enfileira `passport-brand-resync` (§11) p/ re-push de passes. |

#### Eventos de domínio emitidos (webhooks §22)
`theme.published`, `theme.rolled_back`, `domain.verified`, `domain.ssl_issued`, `domain.error`.

---

### 23.4 Telas / Front

#### Pacote `packages/ui` — biblioteca de componentes base (consumida por TODOS os apps)
Componentes-base **agnósticos de tema** (leem CSS vars, nunca hard-codeiam cor): `<Button>` (variantes primary/secondary/ghost/danger), `<Input>`/`<Select>`/`<Textarea>`/`<Checkbox>`/`<Switch>`/`<RadioGroup>`, `<Card>`, `<Badge>`/`<Chip>`, `<Avatar>`, `<Tabs>`, `<Dialog>`/`<Drawer>`/`<Sheet>`, `<Toast>`, `<Tooltip>`, `<Table>` (sortable/virtualizada), `<Pagination>`, `<Skeleton>`, `<EmptyState>`, `<Spinner>`, `<Banner>`/`<Alert>`, `<Stepper>`, `<DropdownMenu>`, `<Popover>`, `<DatePicker>`, `<FileUpload>`, ícones. Tudo acessível (ARIA, foco, teclado), com tokens semânticos, dark-mode-aware, e documentado (Storybook).

**Componentes de identidade/marca:** `<Logo>` (resolve logo da org por modo claro/escuro), `<ThemeToggle>`, `<MemberCard/>` (3D tilt, §23.1.7), `<MemberIdBadge>` (Space Mono, formatado), `<VerifyBadge/>` (compartilhado com verification-checkin).

#### Admin (painel padronizado — **não temável**, usa identidade Stanbase)
- **Configurações → Marca & Tema** (o editor de theming do member-app):
  - **Painel de edição** (esquerda): upload de logo (claro/escuro/ícone), color picker de primária/realce com **badge de contraste em tempo real** (verde/amarelo/vermelho por par), seletores de fonte display/body (de `font_catalog`, com preview do tipo), toggle modo padrão (claro/escuro/system), toggle dark habilitado, editor da **arte do member card** (upload + estilo do foil + posição do logo + cor do texto).
  - **Preview ao vivo** (direita): iframe do member-app real renderizando o **draft**, com controles: claro/escuro, mobile/desktop, e seletor de tela (landing/checkout, área do membro, member card, hall of fame). Atualiza ao vivo (postMessage).
  - **Painel de validação:** lista de pares com score de contraste, avisos de daltonismo, fontes carregando OK. Botão **Publicar** habilitado só se válido. Histórico de versões + **Rollback**.
- **Configurações → Domínio:** adicionar domínio próprio, ver alvo DNS/registro a configurar, status (pending/dns_ok/ssl/active), botão "verificar agora", erros legíveis.
- **Header do admin:** mostra o **logo da org** (única customização visível no admin) + seletor de org.

#### Membro (front hosted temável)
- Todas as telas (§24.2) renderizam com o tema resolvido da org: landing/checkout, login social, área do membro (com `<MemberCard/>` 3D), conteúdo gated, eventos, hall of fame, perfil/preferências, passport.
- **`<ThemeToggle>`** (se `dark_enabled`): alterna claro/escuro; persiste preferência (localStorage + respeita `prefers-color-scheme` no primeiro acesso).
- **Estados:** loading com skeletons temáticos; reduced-motion desliga o tilt do member card.

#### Superadmin (não temável)
- Visão de saúde de temas/domínios cross-org: domínios com SSL expirando, temas publicados com warning de contraste (AA-large), uso de fontes.

---

### 23.5 Integrações externas

| Serviço | Como integra |
|---|---|
| **Supabase Storage** | Hospeda logos, arte do member card, favicons, og-images, fontes self-hosted (woff2). Path `org/{org_id}/theme/...` com signed URLs; bucket público p/ assets de marca (logos são públicos por natureza). |
| **CDN / Edge cache** | Cacheia o tema resolvido (CSS + assets) por org+version+mode; purge na publicação. (Supabase CDN / provedor de edge.) |
| **Provedor de DNS/ACME (Let's Encrypt ou via CDN)** | Provisiona e renova certificados TLS de domínio próprio. Infra compartilhada com `verify.*` (fundação). |
| **Google Fonts (build-time, não runtime)** | Fontes curadas são **baixadas e self-hosted** no build (privacidade/LGPD — não carregar do Google em runtime). Catálogo só referencia arquivos locais. |
| **passport (interno)** | Consome `brand_version`/tokens da versão publicada para gerar a arte dos passes; publicação dispara re-push. |
| **verification-checkin (interno)** | Página pública de verify usa logo/cor/modo da org (tema parcial). |
| **Ferramenta de design (Figma) — build-time** | Tokens primitivos podem ser sincronizados de Figma via Style Dictionary / Tokens Studio (opcional, pós-MVP) para manter design↔código alinhados. |

---

### 23.6 Épicos & tarefas

#### Épico A — Tokens & escala da identidade
- A1. Definir tokens **primitivos** (paleta ivory/paper/ink/gold/obsidian + neutros derivados, escala de espaçamento/raio/sombra/tipografia) como CSS vars + objeto TS tipado. **(M)**
- A2. Definir tokens **semânticos** (bg/surface/text/primary/accent/border/focus/success/warning/danger) p/ claro **e** escuro, mapeando aos primitivos. **(M)**
- A3. Integração Tailwind: config que lê os tokens semânticos como CSS vars (não cores estáticas) → utilitários `bg-surface`, `text-primary`, etc. **(M)**
- A4. Self-host das 3 fontes da identidade (woff2 subset latin/latin-ext) + preload + `font-display: swap` + fallback stacks com metrics override. **(M)**
- A5. Documentar a arquitetura de 3 camadas e a regra "tema só toca semântico". **(S)**

#### Épico B — Biblioteca de componentes base (`packages/ui`)
- B1. Setup do pacote `ui` + Storybook + build (tree-shakeable, ESM). **(M)**
- B2. Primitivos de form (`Button`, `Input`, `Select`, `Checkbox`, `Switch`, `Radio`, `Textarea`, `FileUpload`) acessíveis + estados. **(L)**
- B3. Layout/feedback (`Card`, `Dialog`, `Drawer`, `Sheet`, `Toast`, `Tooltip`, `Popover`, `Tabs`, `Banner`, `Skeleton`, `EmptyState`, `Spinner`). **(L)**
- B4. Dados (`Table` sortable/virtualizada, `Pagination`, `DropdownMenu`, `DatePicker`, `Stepper`). **(L)**
- B5. Identidade (`Logo`, `ThemeToggle`, `MemberIdBadge`, `Badge`, `Chip`, `Avatar`). **(M)**
- B6. Acessibilidade transversal: foco visível, ARIA, navegação por teclado, testes a11y (axe) no Storybook. **(M)**

#### Épico C — Engine de theming (resolução + merge + modo)
- C1. `ThemeProvider` (React context) que injeta tokens resolvidos + expõe via hook (`useTheme`, `useTokens`). **(M)**
- C2. Merge default⊕override (deep-merge na camada semântica) + geração de CSS vars (`:root` + `[data-theme=dark]`). **(M)**
- C3. Resolução **edge/SSR-first** com CSS inlined no `<head>` (anti-FOUC/flash de marca). **(L)**
- C4. Resolução de modo claro/escuro (org default × `prefers-color-scheme` × toggle do usuário, com persistência). **(M)**
- C5. `GET /v1/theme/resolve?host=` (host→org→tema publicado→CSS) + cache edge + purge. **(L)**
- C6. Distinção admin (tokens identidade fixos) vs member (tokens org) no shell — garantir que componentes funcionam nos dois modos. **(M)**

#### Épico D — Acessibilidade & contraste
- D1. Lib de contraste WCAG (luminância, razão) + derivação automática de `*-contrast` (ink vs paper). **(M)**
- D2. `theme-contrast-validator` (job): valida todos os pares em claro+escuro, seta `draft_status`/`draft_validation`. **(M)**
- D3. Auto-ajuste OKLCH de primary p/ dark (opcional, aceitável pela org). **(M)**
- D4. Simulação de daltonismo + aviso primary↔accent indistinguíveis. **(M)**
- D5. Gate de publicação (bloqueia abaixo de 3:1 em texto; avisa em AA-large). **(S)**

#### Épico E — Fontes (catálogo, carregamento, fallback)
- E1. `font_catalog` + seed (3 da identidade + curadas Google self-hosted). **(M)**
- E2. Carregamento dinâmico de fonte custom + fallback stack + metrics override (anti-CLS). **(M)**
- E3. Fallback em falha de carregamento (CDN fora / glifo ausente) → fonte da identidade. **(S)**
- E4. `GET /v1/fonts` + preview de tipo no editor. **(S)**
- E5. (Pós-MVP) upload de fonte self-hosted por org (`org_fonts`) + validação de licença. **(L)**

#### Épico F — Editor de tema + preview ao vivo (admin)
- F1. UI do editor (logo upload, color pickers com badge de contraste, seletores de fonte, toggles de modo). **(L)**
- F2. Upload de assets + `theme-asset-pipeline` (resize/variantes/favicon/PWA/og). **(L)**
- F3. **Preview ao vivo**: iframe do member-app real apontando p/ draft + postMessage de tokens + seletor de tela/modo/device. **(L)**
- F4. Máquina de estados draft→valid→published + autosave + publicar/rollback + histórico de versões. **(L)**
- F5. Editor da **arte do member card** (camadas, foil, posição logo, cor texto) com preview 3D. **(M)**

#### Épico G — Member Card 3D
- G1. `<MemberCard/>` com tilt 3D (perspective/rotate), brilho/foil reagindo à inclinação. **(L)**
- G2. Conteúdo dinâmico (logo, Member ID, tier, status, QR) + arte de fundo por org. **(M)**
- G3. `prefers-reduced-motion`, degradação (sem giroscópio/hover/touch), perf em devices fracos. **(M)**
- G4. Reuso como fallback do passport + preview do editor + embed do SDK. **(S)**

#### Épico H — Domínio próprio + SSL
- H1. `custom_domains` + UI de adicionar domínio (alvo DNS + token de verificação). **(M)**
- H2. `domain-dns-checker` (verificação de posse/propagação). **(M)**
- H3. `domain-ssl-provisioner` (ACME) + `domain-cert-renewer` + roteamento host→org. **(L)**
- H4. Estados/erros legíveis no admin + alertas de cert expirando. **(M)**

#### Épico I — Versionamento, cache & integração passport
- I1. `org_themes` + `org_theme_versions` (imutável) + publish/rollback/auditoria. **(M)**
- I2. `theme-cache-purge` na publicação. **(S)**
- I3. `theme-brand-resync-trigger` → enfileira re-push de passes quando a arte muda. **(S)**
- I4. Cache denormalizado do publicado em `organizations.brand` p/ leitura rápida (header/passport). **(S)**

**Esforço agregado do domínio: L** (XL se contar a biblioteca de componentes completa B2–B4 como parte deste domínio — ver nota de escopo).

---

### 23.7 Dependências

| Depende de | Por quê |
|---|---|
| **fundacao** | Monorepo (`packages/ui`), Supabase Storage (assets/fontes), RLS por org, pgmq/pg_cron (jobs de asset/dns/ssl), shells de app (`apps/admin`/`member` já preveem `ThemeProvider`, §05), **provisionamento de DNS/SSL** (compartilhado com verify.*), edge cache. É a dependência forte de entrada. |
| **auth-rbac** | Quem pode editar/publicar tema (permissão "Marca & Tema" no admin); seletor de org define qual tema o admin edita. |
| **member-identity** | `<MemberCard/>` exibe Member ID/tier/status; é a materialização visual da carteirinha. |
| **tiers-perks** | Cor/arte por tier exibidos no member card; `art_url` do tier (§09) integra a arte do card. |
| **passport** | **Bidirecional:** passport consome `brand_version`/tokens/arte do tema publicado p/ gerar passes; publicação de tema dispara re-push. Member card é o fallback do passport. |
| **verification-checkin** | Página pública de verify usa tema parcial (logo/cor/modo); domínio próprio de verify compartilha infra de SSL. |
| **admin-app** | Hospeda o editor de tema + preview; consome `packages/ui`. |
| **member-app** | É o alvo do theming; consome tokens resolvidos e `packages/ui`. |
| **hall-of-fame / events / content / communication** | Telas temáveis que consomem o design-system (consumidores, não bloqueadores). |
| **public-api / mcp** | Expõem resolve/publish (parceiros headless podem ler tokens p/ casar a marca). |
| **security-lgpd** | Fontes self-hosted (não vazar IP do fã ao Google), assets públicos vs privados, DPA. |
| **observability-qa** | Monitor de certs expirando, temas com warning de contraste, CLS/FOUC. |

> **Quem depende deste domínio:** praticamente todo front (`member-app`, `admin-app`, `superadmin`) e o `passport` (arte). Por isso a **biblioteca de componentes base** (Épico B) e os **tokens** (Épico A) precisam sair cedo — são pré-requisito de qualquer tela. A **engine de theming completa** (C–I) pode vir logo depois, mas os tokens/componentes destravam todo o resto.

---

### 23.8 Riscos & decisões técnicas

**Decisões técnicas tomadas**
1. **Admin não-temável, member temável** (§10 vs §24). Componentes do `ui` são neutros (leem CSS vars); o shell decide se injeta tokens da identidade (admin) ou da org (member). **Imutável.**
2. **Tema é dado, não código** — `org_themes`/`org_theme_versions` em tabela; código idêntico para todos os tenants.
3. **3 camadas de token** (primitive→semantic→component); **org só toca a camada semântica** (subconjunto controlado).
4. **CSS custom properties** como mecanismo de tema (não CSS-in-JS por tema, não builds por tenant) — runtime, sem rebuild por org, SSR-friendly.
5. **Contraste é gate de publicação**, não sugestão. `*-contrast` é **derivado**, não escolhido.
6. **Tokens versionados e imutáveis** por publicação; `brand_version` deriva da versão; rollback = republicar versão antiga.
7. **Fontes self-hosted** (build-time), nunca Google Fonts em runtime (LGPD/perf).
8. **Resolução edge/SSR-first com CSS inlined** p/ eliminar flash de marca/tema.

**Riscos & edge cases**
- **Flash de marca errada (FOUC/FOMB):** sem resolução server-side, o fã vê 1 frame da marca Stanbase/default antes da marca da org → quebra a ilusão white-label. Mitigação: CSS de tema inlined no `<head>` na borda; nunca depender só de JS pós-hidratação.
- **Cores custom ilegíveis:** dono escolhe primary clara sobre bg claro → texto some. Mitigação: pipeline de contraste obrigatório (D1–D5), gate de publicação, `*-contrast` derivado, preview com badge ao vivo.
- **Dark mode meia-boca:** org curou só o claro; dark vira "claro invertido" feio. Mitigação: `dark_enabled` por org (esconde o toggle se não curado), auto-derivação OKLCH como assistente (não obrigar curadoria manual), defaults de dark sempre sãos (obsidian).
- **Fallback de fonte com CLS:** fonte custom carrega tarde e "pula" o layout. Mitigação: metrics override (`size-adjust`) por fonte do catálogo; fallback imediato com métricas próximas.
- **Fonte custom falha:** CDN fora / subset sem glifo (acento, emoji, CJK em nome). Mitigação: fallback para fonte da identidade equivalente + system para glifos ausentes; nunca texto invisível.
- **Asset imutável por versão (decisão sutil):** se a org **substitui** o arquivo do logo no Storage (mesmo path) depois de publicar, versões antigas "mudam" retroativamente — quebra a imutabilidade e os passes já emitidos. Mitigação: **congelar assets por versão** (path versionado / cópia imutável na publicação); editar logo = nova versão de tema.
- **Re-push de passes em massa após troca de arte:** publicar nova arte do member card dispara re-push de TODOS os passes (QPS Google/janela APNs — §11). Mitigação: enfileirar via `passport-brand-resync` com backoff; avisar o dono ("isso reemite os passes de N membros").
- **Domínio próprio — DNS/SSL flaky:** org configura CNAME errado, DNS demora a propagar, cert falha. Mitigação: máquina de estados explícita com erros legíveis, recheck manual, alertas; `org.stanbase.com` sempre funciona como fallback enquanto o custom domain não está `active`.
- **Cert expirando silenciosamente:** renovação ACME falha sem alerta → site da org cai. Mitigação: `domain-cert-renewer` + monitor de `cert_expires_at` + alerta (observability).
- **Cache stale:** publica tema novo mas o fã ainda vê o antigo (CDN não purgado). Mitigação: purge por chave `org:{id}:theme` na publicação + versão na chave de cache.
- **Admin acidentalmente temável:** alguém aplica token da org no chrome do admin → quebra a consistência "igual pra todos" (§10). Mitigação: lint/regra que proíbe o shell admin de injetar tokens de org; testes visuais.
- **Member card 3D em device fraco / reduced-motion / sem JS:** tilt pesa, enjoa ou não funciona. Mitigação: `prefers-reduced-motion` desliga; degradação progressiva; versão estática sempre disponível (é o fallback do passport).
- **i18n e theming:** strings traduzidas (pt/es/en) podem estourar layouts pensados em pt-BR (alemão/es mais longos). Mitigação: componentes flexíveis, truncamento controlado, testes nos 3 idiomas.
- **Contraste de marca vs. acessibilidade legal:** uma org pode *querer* uma cor de marca que falha AA. Tensão real (marca × acessibilidade). Decisão de produto pendente (ver openQuestions): bloquear duro vs. permitir com aviso assinado.
- **`<MemberCard/>` como embed externo (SDK):** roda fora do nosso domínio → tokens precisam ser entregues via API (`/v1/theme/resolve`) e o tilt não pode depender de CSS global do member-app. Mitigação: componente do SDK auto-contido (shadow DOM / CSS scoped + tokens injetados).
- **Org sem tema (recém-criada):** front deve renderizar com a identidade Stanbase + logo placeholder, nunca quebrar. Default sempre válido.

---

### 23.9 Escopo MVP vs. depois

**MVP (Fase 0/1 — §29 do doc: "design system com tokens da identidade" é Fase 0; front de membro **temável** é Fase 1):**
- **Tokens da identidade** completos (primitivos + semânticos, claro **e** escuro) + integração Tailwind (Épico A) — **pré-requisito de tudo, sai na Fase 0**.
- **Biblioteca de componentes base** suficiente para admin + member do MVP (form, layout, feedback, dados essenciais, identidade) — Épico B (o necessário; refinamento contínuo).
- **Engine de theming** com merge default⊕override, modo claro/escuro, resolução SSR/edge anti-FOUC, `resolve` por host (Épico C).
- **Acessibilidade/contraste** com validação + derivação de `*-contrast` + gate de publicação (Épico D — núcleo).
- **Fontes:** identidade self-hosted + catálogo curado básico + fallback (Épico E, sem upload self-hosted da org).
- **Editor de tema + preview ao vivo** no admin (logo, cores, fonte, modo, arte do member card) + publish/rollback versionado (Épico F + I).
- **Member Card 3D** (`<MemberCard/>`) — é o efeito da landing e o fallback do passport; entra cedo (Épico G).
- **Domínio próprio + SSL:** **avaliar** — depende da decisão §30.4 do doc. Se entrar, MVP mínimo (adicionar domínio, DNS check, SSL, roteamento); senão, só `org.stanbase.com` no MVP e custom domain pós-MVP. **Recomendação:** custom domain **fora** do MVP, `org.stanbase.com` basta para validar valor.

**Depois do MVP:**
- Upload de **fontes self-hosted** por org (com validação de licença) — Épico E5.
- **Presets de estilo** avançados (raio/densidade), temas por-tier da arte do passe.
- **Sync Figma↔código** (Style Dictionary / Tokens Studio) build-time.
- **A/B de tema** (versões publicadas alternadas).
- **Domínio próprio** se ficar fora do MVP, e domínio próprio também para `verify.*`.
- Auto-ajuste OKLCH avançado, simulação de daltonismo refinada, modo alto-contraste opcional.
- `<MemberCard/>` como embed SDK auto-contido (shadow DOM) para o modo híbrido.
- Biblioteca de componentes ampliada conforme novos domínios (charts temáveis, editores ricos).
