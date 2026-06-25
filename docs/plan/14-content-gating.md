## 14. Conteúdo Exclusivo (Gated)

> **Domínio:** biblioteca de conteúdo liberado por tier (VOD, live fechada, bastidores, posts), com *gating* via verificação de entitlement antes de servir o conteúdo, suporte a providers externos (Twitch/YouTube/Vimeo) e a conteúdo hospedado na própria Stanbase, agendamento de publicação, janelas de acesso temporais e registro de consumo no CRM.
> **Fontes de verdade no STANBASE.md:** §15 (gated content), §12.2 (perk `content`), §12.3 (entitlements), §20 / §20.1 (integrações de conteúdo: Twitch, YouTube, Vimeo; framework de connections), §25.5 (`content_items`), §11.1/§11.2 (consumo de conteúdo → engajamento/timeline CRM), §22 (webhook `content.published`), §26 (LGPD/segurança/Storage), §6.1 (Storage/Realtime/pg_cron/pgmq).
> **Decisões imutáveis aplicáveis:** 1 membership por org (logo, no máximo 1 tier ativo por membro → gating sempre resolve contra 1 entitlement-set); PSP = Asaas (irrelevante aqui exceto que o `member.status` que destrava conteúdo é alimentado por billing); Member ID por relação pessoa×org; RLS por `org_id` em tudo.
> **Princípio herdado de tiers-perks (§09):** **nunca decidir acesso lendo `tier_perks` em tempo real** — gating lê **entitlements materializados** do membro, que carregam cortesias, grandfathering e expirações que `tier_perks` desconhece.

---

### 1. Como funciona

#### 1.1 O modelo mental: "conteúdo" ≠ "perk", "acesso a um conteúdo" = projeção de entitlement

Três entidades, propositalmente separadas:

- **Content Item** — a peça de conteúdo: um VOD, um post de texto/imagem, um bastidor, uma live agendada. Tem `type`, `provider` (stanbase/youtube/twitch/vimeo), `external_ref` (ou storage key), metadados, capa, estado de publicação e **janelas de acesso**.
- **Regra de gating do item** — *quem* pode ver: definida por **tier(s) mínimo(s) ou específico(s)** + janela temporal opcional. Um item pode ser gated por **N tiers** (não só `min_tier`).
- **Acesso efetivo de um membro a um item** — **estado derivado**, computado no momento da requisição por `evaluateAccess(member_id, content_item_id, now)`. Não é uma tabela de "permissões pré-materializadas por item × membro" (explodiria); é uma **avaliação on-demand** sobre os entitlements ativos do membro + a regra do item + a janela temporal + o estado de publicação.

> **Por que avaliação on-demand e não materialização:** entitlements já são o estado materializado do "membro × perks" (§09). Materializar de novo "membro × cada content_item" seria N×M e exigiria re-resolver toda a biblioteca a cada mudança de tier. Em vez disso, gating é uma **função pura** sobre (entitlements do membro, regra do item, relógio). O único estado persistido por membro×item é o **registro de consumo** (telemetria), não a permissão.

#### 1.2 Relação com o perk `content` (§12.2 do doc, §09 deste plano)

- O doc define `perks.type='content'` com `config = { content_item_ids:[], ... }`. **Decisão de modelagem (ver Open Questions §8.1):** adotamos **gating por coleção/tag de conteúdo**, não por lista enumerada de IDs no perk. Um perk `content` aponta para uma **`content_collection`** (ex.: "Bastidores", "Aulas Premium"). O content item pertence a coleções e/ou declara tiers diretamente. Assim, publicar um novo VOD numa coleção já gated **não exige editar o perk** nem re-resolver entitlements de todos os membros.
- O entitlement de `content` que o membro possui é, na prática, "direito à coleção X" (origem tier ou cortesia). `evaluateAccess` cruza: o item pertence a alguma coleção/tier a que o membro tem entitlement ativo **e** está dentro da janela de acesso **e** está publicado.

#### 1.3 Máquina de estados — Content Item (publicação)

```
draft ──schedule──► scheduled ──(publish_at <= now, cron)──► published ──┐
  ▲   ◄─unschedule───┘                                          │        │
  │                                                  archive ◄──┘        │ expire (access_until <= now)
  └──────────────────────unpublish──────────────────────────────────────┤
                                                                          ▼
                                                                      expired
  (live-specific) scheduled ──(starts_at)──► live ──(ends_at)──► ended ──(VOD ready)──► published
```

- `draft` — criado, invisível ao membro, editável livremente. Não aparece na biblioteca.
- `scheduled` — tem `publish_at` futuro. Aparece como "em breve" (opcional, config do item) mas o conteúdo **não é servível** (signed URL/embed negado). Cron promove a `published` quando `publish_at <= now`.
- `published` — visível e servível para quem tem entitlement, **dentro da janela** (`access_from`/`access_until`).
- `live` — sub-estado de itens `type=live`: a transmissão está no ar (entre `starts_at` e `ends_at`). Gating de **live fechada** é o caso mais delicado (§1.7).
- `ended` — live terminou; pode virar VOD (`published` de novo) ou ficar indisponível até o VOD ficar pronto.
- `expired` — `access_until` venceu (ex.: "VOD por 7 dias"). Item continua existindo (histórico/CRM) mas `evaluateAccess` nega. UI mostra "Disponibilidade encerrada".
- `archived` — removido da biblioteca pelo admin; não servível; preserva telemetria de consumo.

> **Distinção crítica:** **estado de publicação** (draft/scheduled/published/...) é do **item** (vale para todos). **Janela de acesso** (`access_from`/`access_until`) é uma propriedade do item que, combinada com o entitlement do membro, define a disponibilidade. **Estado de entitlement** (active/suspended/...) é do **membro** (§09). Os três têm que ser `active`/válidos simultaneamente para servir.

#### 1.4 Fluxo passo a passo — membro abre um VOD gated hospedado na Stanbase (signed URL)

1. Membro abre a biblioteca → front lista itens via `GET /v1/content?available_to_me=true` (a API já filtra por entitlement+janela+publicação; itens bloqueados aparecem com `locked:true` + CTA "disponível no tier X", **sem** o media URL).
2. Membro clica no VOD → front chama `POST /v1/content/{id}/access` (gera ticket de acesso).
3. Edge Function `content-access`:
   a. Autentica o membro (JWT) e resolve `member_id` na org.
   b. `evaluateAccess(member_id, item, now)` → precisa de: item `published`, dentro de `[access_from, access_until]`, **e** entitlement ativo a alguma coleção/tier do item.
   c. Se negado → `403 { reason: 'no_entitlement' | 'window_closed' | 'not_published' | 'member_inactive' }`.
   d. Se permitido → gera **signed URL** de curta duração (TTL ~ minutos, ver §1.10) apontando para o objeto no Supabase Storage (bucket privado), com escopo ao `member_id` (token assinado/`transform`/range) e registra um **content_access_grant** (auditável) com `expires_at`.
   e. Retorna `{ url, expires_at, item, resume_at? }`.
4. Player carrega a signed URL. Em VOD longo, segmentos HLS exigem URLs assinadas por segmento ou um **proxy de streaming** com o grant (§1.10, Riscos §8).
5. Player emite heartbeats de consumo → `POST /v1/content/{id}/progress` (a cada N s ou em marcos %), que grava em `content_consumption` e alimenta o CRM (§1.9).

#### 1.5 Fluxo passo a passo — membro abre conteúdo via embed externo (YouTube/Vimeo/Twitch)

Dois sub-casos por provider, conforme **quem detém o controle de acesso**:

**(A) Gating na Stanbase + embed "unlisted" (modelo padrão, MVP):**
1. O conteúdo vive como **unlisted/privado** no provider (ex.: vídeo YouTube *unlisted*, Vimeo *private*). O `external_ref` (videoId) só é conhecido por quem a Stanbase liberar.
2. Membro clica → `POST /v1/content/{id}/access` → `evaluateAccess`.
3. Se permitido, a API devolve um **embed token interno** + o `external_ref`; o front monta o player do provider. **Segurança real = obscuridade do ID + domain allowlist do provider** (ver Riscos §8.4: unlisted ≠ seguro contra compartilhamento de link).
4. Se negado, a API **não devolve** o `external_ref` (o front nunca vê o videoId) → o embed sequer pode ser montado.

**(B) Gating no provider (entitlement-aware, pós-MVP / providers que suportam):**
1. **Twitch** (subscriber-only / lives fechadas) e **YouTube Members-only**: o acesso é controlado **pelo provider** com base na conta do membro lá. Aqui a Stanbase faz **verificação de entitlement via API do provider** (o membro conectou a conta Twitch/Google; a Stanbase confirma que ele é "subscriber"/"member" no canal) — ou, no sentido inverso, sincroniza o membership Stanbase → status no provider (concede o "membership level" do YouTube). Esse fluxo depende do `integrations-framework` e da conexão de conta do membro (`verification-checkin`/login social).
2. Decisão de produto (Open Questions §8.4): **MVP usa o modelo (A)** (gating na Stanbase, embed unlisted) por ser provider-agnóstico e não exigir que o membro tenha conta no provider. O modelo (B) é refinamento por provider.

#### 1.6 Fluxo passo a passo — agendamento de publicação + janela de acesso ("VOD por 7 dias")

1. Admin cria item, define `publish_at = D` (futuro) e `access_window`:
   - **Janela absoluta:** `access_from = D`, `access_until = D+7d` (todo mundo perde acesso na mesma data).
   - **Janela relativa por membro** (ex.: "7 dias a partir de quando *você* desbloqueou"): não é uma data no item, é computada por membro a partir do **primeiro acesso** (`first_access_at` no `content_consumption`) — ver §1.11 e Open Questions §8.2. **Default recomendado:** janela absoluta (mais simples, previsível).
2. `content-publish-cron` (pg_cron, frequência fina ex. 1 min) promove `scheduled → published` quando `publish_at <= now` e dispara webhook `content.published` (§22) + notificação opcional aos membros elegíveis (via domínio communication).
3. `content-expiry-cron` marca `published → expired` quando `access_until <= now` (janela absoluta). Para janela relativa, a expiração é avaliada **on-demand** em `evaluateAccess` (não há cron por membro).
4. Durante `scheduled`, qualquer `POST /access` é negado (`not_published`); durante `expired`, negado (`window_closed`).

#### 1.7 Edge case central — Live fechada gated (ao vivo)

A live é o caso mais difícil porque o acesso é **simultâneo, em tempo real e de alto valor** (mais alvo de pirataria) e o provider externo pode falhar no pior momento.

- **Estados:** `scheduled` (sala criada, contagem regressiva) → `live` (no ar) → `ended` → (opcional) `published` como VOD.
- **Gating durante `live`:**
  - **Stanbase-hosted live (pós-MVP):** signed URL de manifesto HLS de baixa latência, com **re-assinatura periódica** e **token por membro**; se entitlement é revogado durante a live (ex.: chargeback), o próximo refresh do manifesto nega (corte em ~1 ciclo de TTL).
  - **Provider live (MVP — Twitch/YouTube live unlisted):** a Stanbase libera o embed da live unlisted via `POST /access`; a janela de acesso é o intervalo `[starts_at, ends_at]` (mais buffer). **Não há controle frame-a-frame** — quem pegou o link da live unlisted pode reabrir; mitigação = link efêmero + watermark de overlay + chat gated (Riscos §8).
- **Janela de acesso da live:** `access_from = starts_at - pre_roll`, `access_until = ends_at + grace`. Fora disso, `evaluateAccess` nega mesmo para membro elegível.
- **Capacidade/concorrência:** live pode ter limite de espectadores simultâneos (custo/contrato do provider). Opcional: `max_concurrent` + contador Realtime (pós-MVP).
- **"Comecei a assistir e meu tier caiu":** entitlement revogado → próximo heartbeat/refresh corta; UX mostra "seu acesso a esta live encerrou".

#### 1.8 Regras de negócio concretas

- **Conteúdo gated por múltiplos tiers (§ obrigatório):** um item pode declarar `gating = { mode: 'min_tier' | 'any_of_tiers' | 'collections', tiers:[...], collections:[...] }`. `evaluateAccess` concede se o membro tem entitlement ativo a **qualquer** das coleções/tiers exigidos (semântica OR por padrão). `min_tier` é açúcar para "este tier e todos acima na ordem `position`" (§09 ordena tiers). **Decisão (Open Questions §8.3):** default = OR entre tiers listados; `min_tier` resolve a um conjunto de tiers no momento da avaliação (recalcula se a ordem dos tiers muda).
- **Acesso nunca lido de `tier_perks` em runtime** — sempre de `entitlements active` do membro (herda §09). Cortesia de conteúdo (admin libera um VOD premium a um membro free por 7 dias) **funciona automaticamente** porque vira um entitlement `source=manual` com `expires_at`, e `evaluateAccess` lê entitlements.
- **Item público (não gated):** `gating.mode = 'public'` → qualquer um (até não-membro) vê. Útil para teaser/isca. Ainda registra consumo se o usuário estiver logado.
- **Membro inativo/suspenso:** `evaluateAccess` exige `member.status ∈ {active, grace}` (mesma semântica de §12). Em `grace` (inadimplência dentro do período), **acesso a conteúdo permanece** (não punir antes do fim do grace) — config por org (Open Questions §8.6).
- **Publicação não significa acesso:** um item `published` para o qual o membro não tem entitlement aparece **bloqueado com upsell** (mostra capa, título, "disponível no tier X"), nunca o media URL.
- **Item arquivado/expirado:** some da biblioteca do membro mas o **registro de consumo persiste** (CRM/engajamento).
- **Conteúdo só-texto/post:** mesmo gating; o "media" é o corpo do post (markdown/rich). Não precisa signed URL, mas o **corpo só é retornado se `evaluateAccess` permitir** (a API não devolve o body para bloqueados — só o teaser).

#### 1.9 Consumo registrado no CRM (engajamento)

- Cada interação relevante gera telemetria: `content.viewed` (abriu/acessou), `content.progress` (%), `content.completed` (≥ limiar, ex. 90%), `content.live_joined`.
- Grava em `content_consumption` (estado agregado por membro×item) **e** numa `interaction` na timeline do CRM (§11.2) — esta de forma **throttled/agregada** (não 1 interaction por heartbeat; consolida por sessão para não inundar a timeline).
- Alimenta `member_metrics.engagement_score` (§25.2) via job de recalculo (domínio CRM/AI consome). "Consumo de conteúdo" é citado explicitamente como sinal de engajamento no §11.1.
- **Anti-inflação de métrica:** heartbeats validam que o tempo decorrido é plausível (anti-bot/seek-spam). Conclusão exige progresso monotônico mínimo.

#### 1.10 Signed URLs, TTL e proteção do media (Stanbase-hosted)

- Buckets de mídia são **privados** (Supabase Storage). Nada de URL pública permanente.
- `POST /access` gera **signed URL com TTL curto** (recomendado 60–300 s para iniciar a sessão; player renova). Para VOD longo via **HLS**, duas opções (Riscos §8.5):
  - **(i)** Re-assinar cada segmento `.ts`/playlist sob demanda via Edge Function proxy (mais seguro, mais custo/latência).
  - **(ii)** Assinar a playlist com TTL maior cobrindo a duração (mais simples, link reutilizável durante o TTL → menos seguro).
  - **MVP recomendado:** progressive MP4 com signed URL renovável + `Range`/`byte-range`; HLS segmentado fica pós-MVP.
- Cada grant é registrado (`content_access_grants`) com `member_id`, `item_id`, `issued_at`, `expires_at`, `ip_hash` — para auditoria, rate-limit e detecção de abuso.
- **Anti-hotlink:** signed URL escopada + verificação de `Referer`/origem onde aplicável; o segredo é o token assinado, não o nome do arquivo.

#### 1.11 Janela relativa por membro (drip / "7 dias a partir do seu desbloqueio")

- Opt-in por item: `access_window.kind = 'relative'`, `relative_days = 7`.
- Na **primeira** chamada de `POST /access` bem-sucedida, grava `content_consumption.first_access_at` (se ainda null). A janela do membro é `[first_access_at, first_access_at + relative_days]`.
- `evaluateAccess` para itens relativos: permite se `now <= first_access_at + relative_days` (ou se ainda não acessou e o item está globalmente publicado). Não há cron por membro; é avaliação on-demand.
- **Edge case:** membro nunca abre o item → nunca expira por janela relativa (só expira se o **item** for arquivado/despublicado). Documentar UX ("você tem 7 dias após começar a assistir").

---

### 2. Modelo de dados

Todas as tabelas carregam `org_id` e RLS por `org_id`. Estende `content_items` (§25.5) e adiciona o que falta para coleções, gating multi-tier, janelas, providers, telemetria e grants.

#### 2.1 Tabelas tocadas/estendidas

**`content_items`** (estende §25.5)
| Coluna | Tipo | Nota |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK | RLS |
| `type` | enum `content_type` | `vod` \| `live` \| `post` \| `backstage` \| `audio` \| `file` |
| `provider` | enum `content_provider` | `stanbase` \| `youtube` \| `twitch` \| `vimeo` |
| `external_ref` | text null | videoId/canal/embed id (providers externos) |
| `storage_key` | text null | objeto no Storage (provider=stanbase) |
| `title`, `description` | text | |
| `cover_url` | text null | capa/thumb (pode ser pública) |
| `body` | text null | corpo do post (markdown) — **só servido se acesso liberado** |
| `duration_s` | int null | VOD/live |
| `gating` | jsonb | `{ mode, tiers[], collections[], min_tier_id }` (ver §2.4) |
| `publish_at` | timestamptz null | agendamento |
| `access_from` / `access_until` | timestamptz null | janela absoluta |
| `access_kind` | enum | `absolute` \| `relative` (default absolute) |
| `relative_days` | int null | janela relativa por membro |
| `starts_at` / `ends_at` | timestamptz null | live |
| `status` | enum `content_status` | `draft`\|`scheduled`\|`published`\|`live`\|`ended`\|`expired`\|`archived` |
| `is_teaser_visible` | bool default true | se bloqueado aparece (upsell) ou some |
| `created_by` | uuid | audit |
| `created_at`/`updated_at` | timestamptz | |

Constraints/índices:
- `CHECK (provider = 'stanbase' OR external_ref IS NOT NULL)` e `CHECK (provider <> 'stanbase' OR storage_key IS NOT NULL OR type='post')`.
- `CHECK (access_kind <> 'relative' OR relative_days > 0)`.
- `CHECK (status NOT IN ('scheduled') OR publish_at IS NOT NULL)`.
- `CHECK (type <> 'live' OR starts_at IS NOT NULL)`.
- Índice `idx_content_org_status` em `(org_id, status)`.
- Índice `idx_content_publish` em `(publish_at) WHERE status='scheduled'` (cron de publicação).
- Índice `idx_content_expiry` em `(access_until) WHERE status='published' AND access_until IS NOT NULL` (cron de expiração).
- Índice GIN em `gating` (jsonb) para filtros por tier/coleção.

**`content_collections`** (nova) — agrupa itens; é o alvo do perk `content`
| `id`, `org_id`, `name`, `slug`, `description`, `cover_url`, `position`, `status` (`active`/`archived`), `created_at` |
- Índice `UNIQUE (org_id, slug)`.

**`content_collection_items`** (nova) — N:N item ↔ coleção
| `collection_id` FK, `content_item_id` FK, `position`, PK `(collection_id, content_item_id)` | índices em ambos FKs.

**`content_consumption`** (nova) — estado agregado de consumo por membro × item (telemetria)
| Coluna | Tipo | Nota |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid | RLS |
| `member_id` | uuid FK | |
| `content_item_id` | uuid FK | |
| `first_access_at` | timestamptz | base da janela relativa |
| `last_access_at` | timestamptz | |
| `progress_pct` | int | 0–100 (max atingido) |
| `position_s` | int | resume point |
| `completed_at` | timestamptz null | ≥ limiar |
| `view_count` | int | nº de sessões |
| `total_watch_s` | int | tempo somado (anti-fraude valida plausibilidade) |
| `updated_at` | timestamptz | |

Constraints/índices:
- `UNIQUE (member_id, content_item_id)` — 1 linha agregada por par (upsert nos heartbeats).
- Índice `idx_consumption_member` em `(member_id, last_access_at)` (timeline/engajamento).
- Índice `idx_consumption_item` em `(content_item_id)` (analytics por conteúdo).

**`content_access_grants`** (nova) — auditoria/rate-limit de signed URLs emitidas
| `id`, `org_id`, `member_id`, `content_item_id`, `kind` (`signed_url`/`embed_token`/`live`), `issued_at`, `expires_at`, `ip_hash`, `revoked` bool | índice `(member_id, issued_at)` p/ rate-limit; índice parcial `(content_item_id) WHERE revoked=false`.

#### 2.2 Tabelas de outros domínios tocadas

- **`perks`** (§09/§25.1): perk `type='content'` com `config = { collection_id }` (em vez de `content_item_ids`). Mudança de modelagem documentada acima (§1.2).
- **`entitlements`** (§09): `evaluateAccess` lê entitlements `active` cujo `perk` é `type=content` → mapeia para coleções. Nenhuma coluna nova, mas é a **fonte do gating**.
- **`interactions`** (CRM §25.2): grava `content.viewed`/`completed` (agregado por sessão).
- **`member_metrics`** (§25.2): `engagement_score` consome consumo de conteúdo (recálculo é do domínio CRM/AI).
- **`webhook events`** (§22): emite `content.published` (e propostos `content.consumed`, `content.expired`).

#### 2.3 Buckets de Storage (provider=stanbase)
- Bucket privado `content-media-{env}` (RLS/policy: acesso só via signed URL emitida pela Edge Function, **nunca** leitura anônima).
- Bucket público `content-covers-{env}` para capas/thumbs (capas não são gated — são isca de upsell).
- Multipart upload para VODs grandes; transcode é externo (ver §5) ou pós-MVP.

#### 2.4 Forma do `content_items.gating` (jsonb)
```
{ "mode": "public" }                                  // qualquer um
{ "mode": "any_of_tiers", "tiers": ["<tier_id>", ...] } // OR entre tiers
{ "mode": "min_tier", "min_tier_id": "<tier_id>" }      // este tier e acima (por position)
{ "mode": "collections", "collections": ["<col_id>"] }  // via perk content da coleção
```
- `evaluateAccess` traduz `mode` → conjunto de coleções/tiers exigidos → confere contra entitlements ativos do membro (OR). `min_tier` é resolvido lendo a ordem `position` dos tiers da org no momento da avaliação.

---

### 3. API & Edge Functions

#### 3.1 Endpoints `/v1` (REST pública — admin/headless/membro)

**Biblioteca & gating (membro)**
```
GET    /v1/content                          # lista; ?available_to_me, ?collection, ?type, ?status (cursor)
GET    /v1/content/{id}                      # metadados; body/media só se acesso liberado (senão teaser+locked)
POST   /v1/content/{id}/access               # avalia entitlement+janela → signed URL / embed token / nega 403
POST   /v1/content/{id}/progress             # heartbeat de consumo (position_s, progress_pct)
POST   /v1/content/{id}/complete             # marca concluído (idempotente; valida limiar)
GET    /v1/content/collections               # coleções visíveis ao membro
```

**Gestão de conteúdo (admin)**
```
POST   /v1/content                           # criar (draft) — §21.2 do doc
PATCH  /v1/content/{id}                       # editar (gating, janelas, publish_at)
POST   /v1/content/{id}/publish               # publicar já (draft/scheduled -> published)
POST   /v1/content/{id}/schedule              # define publish_at futuro (-> scheduled)
POST   /v1/content/{id}/unpublish             # published -> draft
POST   /v1/content/{id}/archive               # -> archived
POST   /v1/content/{id}/upload-url            # signed URL de upload (provider=stanbase, multipart)
GET    /v1/content/{id}/analytics             # views, completions, watch time, por tier
POST   /v1/content/collections                # CRUD coleções
PATCH  /v1/content/collections/{id}
POST   /v1/content/collections/{id}/items     # add/remove item da coleção
```

> Vínculo perk↔coleção usa os endpoints de **perks** (§09): `POST /v1/perks` com `config.collection_id` + `POST /v1/tiers/{id}/perks/{perkId}`. Gating não duplica essa engine; consome entitlements.

#### 3.2 Edge Functions / Jobs internos

| Função | Tipo | Descrição |
|---|---|---|
| `content-access` | função | Núcleo do gating: autentica membro, `evaluateAccess`, gera signed URL (Storage) ou embed token, registra grant, retorna URL+TTL ou 403 com `reason`. |
| `evaluate-access` (lib) | lib compartilhada | Função pura `(member, item, now) → allow/deny + reason`. Usada por `content-access`, por `GET /content` (filtro `available_to_me`) e pelo proxy de streaming. |
| `content-stream-proxy` | função | (HLS/segurança alta) revalida grant e re-assina/proxy de segmentos de mídia por requisição. |
| `content-publish-cron` | pg_cron | Promove `scheduled → published` quando `publish_at <= now`; emite `content.published`; aciona notificação opcional. |
| `content-expiry-cron` | pg_cron | Marca `published → expired` quando `access_until <= now` (janela absoluta); promove live `scheduled→live→ended` por `starts_at/ends_at`. |
| `content-consumption-aggregator` | consumer pgmq | Consome heartbeats, faz upsert em `content_consumption` (throttle), grava `interaction` consolidada no CRM, enfileira recálculo de engajamento. |
| `content-grant-reaper` | pg_cron | Limpa/expira `content_access_grants` vencidos; detecta abuso (muitos grants/IP). |
| `provider-entitlement-sync` | consumer pgmq | (pós-MVP / modelo B) sincroniza membership Stanbase ↔ membership-level no YouTube/Twitch via `integrations-framework`. |
| `provider-health-check` | pg_cron | Pinga providers externos; marca embeds como degradados se o provider está offline (§8.4). |

---

### 4. Telas / Front

#### 4.1 Admin (painel §10.1 → módulo "Conteúdo")

- **Biblioteca (lista/grid):** itens com capa, tipo (VOD/live/post/bastidor), provider, badge de status (draft/scheduled/published/live/expired/archived), gating (tiers/coleções), janela de acesso, contadores (views/completions). Filtros por tier, coleção, provider, status. Ações em massa (publicar, arquivar, mover de coleção).
- **Editor de conteúdo (form/drawer):**
  - Tipo + provider. Se `stanbase`: uploader (multipart, progress, capa). Se externo: campo `external_ref` + preview do embed + aviso de "deixe unlisted/privado no provider".
  - **Gating:** seletor multi-tier (chips) OU coleção, com modo (qualquer dos tiers / tier mínimo / coleção / público). Preview "quem vê isto" (estimativa de nº de membros elegíveis).
  - **Agendamento:** `publish_at` (datepicker) + estado "publicar agora / agendar".
  - **Janela de acesso:** absoluta (de/até) ou relativa ("N dias após o membro desbloquear") com helper "VOD por 7 dias".
  - **Live:** `starts_at`/`ends_at`, fonte (Twitch/YouTube/Stanbase), buffer pré/pós, opção de virar VOD ao terminar.
  - Corpo rich-text para `post`.
- **Coleções:** CRUD de coleções, arrastar itens para dentro, vincular coleção a perk/tier (atalho para a engine de tiers-perks).
- **Analytics por conteúdo:** views, % conclusão, watch time, distribuição por tier, curva de retenção (pós-MVP), top conteúdos. Liga ao engajamento do CRM.
- **Aviso de despublicar/arquivar:** "X membros estão consumindo / Y têm acesso — confirmar".

#### 4.2 Membro (front hosted temável §24.2 → "Conteúdo gated")

- **Biblioteca do membro:** grid de coleções e itens. Itens **liberados** com play; itens **bloqueados** com cadeado + "Disponível no tier X" + CTA upgrade (upsell), mostrando só capa/título/teaser. Filtros por coleção/tipo. Badge "novo", "expira em N dias" (janela), "ao vivo agora".
- **Player:**
  - Stanbase-hosted: player HTML5 com signed URL, resume point, controles, watermark de overlay opcional (Member ID/nome translúcido — anti-screenshot/pirataria, §8.6), heartbeats de progresso.
  - Externo: embed do provider (YouTube/Vimeo/Twitch) só montado após `POST /access` devolver o `external_ref`.
  - Live: contagem regressiva quando `scheduled`, player de live quando `live`, "encerrada / VOD em breve" quando `ended`.
- **Estados de erro claros:** "disponível a partir de DD/MM" (scheduled), "disponibilidade encerrada" (expired), "exclusivo do tier X" (sem entitlement), "sua assinatura está inativa" (member inactive).
- **Continuar assistindo / histórico:** lista do que o membro consumiu (resume), alimentada por `content_consumption`.

---

### 5. Integrações externas

| Serviço | Como integra | MVP? |
|---|---|---|
| **YouTube** | Embed de vídeos *unlisted*/Members-only; (pós-MVP) YouTube Data API + Memberships para gating no provider e sync de membership-level; domain allowlist do embed. | Embed unlisted: MVP. Gating no provider: pós-MVP. |
| **Vimeo** | Vídeos *private* com domain-level privacy (whitelist do domínio da org) + embed; hashed URL. Forte para gating "na Stanbase" porque o Vimeo restringe por domínio. | MVP (embed privado). |
| **Twitch** | Embed de live/VOD; live *subscriber-only* e VODs de sub; verificação de entitlement via Twitch API (membro conecta conta, confere status de sub) ou sync inverso. | Embed: MVP. Sub-gating no provider: pós-MVP. |
| **Supabase Storage** | Hospedagem nativa (provider=stanbase): buckets privados + signed URLs + (opcional) proxy de streaming. | MVP. |
| **Transcode/CDN** (ex.: Mux/Cloudflare Stream/bunny) | Para VOD/HLS de qualidade + DRM/watermark + multi-bitrate. A camada de provider já permite plugar como mais um `content_provider`. | Pós-MVP (avaliar buy vs build). |
| **integrations-framework** | Connections (OAuth/token cifrado) por org para os providers; a verificação/sync de entitlement no provider passa por ele. | MVP para guardar credenciais; sync avançado pós-MVP. |
| **communication** | Notificar membros elegíveis quando `content.published` (e-mail/push). | MVP-light (webhook), campanha rica pós-MVP. |

> **Princípio (herda §09):** este domínio **não chama** Discord/canais; e para conteúdo externo, o caso (A) só precisa do `external_ref` (sem OAuth do membro). O caso (B) (gating no provider) é que depende de `integrations-framework` + conta conectada do membro.

---

### 6. Épicos & tarefas

#### Épico A — Modelo de dados & RLS
- A1 (M) Migration `content_items` estendida (provider, gating jsonb, janelas absolutas/relativas, live, status, índices de publish/expiry, GIN gating) + constraints.
- A2 (S) Migration `content_collections` + `content_collection_items` (N:N) + índices.
- A3 (M) Migration `content_consumption` (unique member×item, índices de engajamento).
- A4 (S) Migration `content_access_grants` (auditoria/rate-limit).
- A5 (S) Buckets Storage privados (media) + público (covers) + policies (sem leitura anônima de media).
- A6 (M) RLS por `org_id` em todas as tabelas novas + testes de isolamento (membro de org A não lê conteúdo de org B).
- A7 (S) Ajuste em `perks` config (`collection_id`) — coordenar com tiers-perks.

#### Épico B — Engine de gating (núcleo)
- B1 (L) Lib `evaluateAccess(member, item, now)`: lê entitlements ativos, resolve `gating.mode` (public/any_of_tiers/min_tier/collections), aplica status do membro + janela (absoluta/relativa) + estado de publicação. Função pura, testável, idempotente.
- B2 (M) `content-access` Edge Function: auth, evaluateAccess, geração de signed URL (Storage) / embed token, registro de grant, 403 com `reason` tipado.
- B3 (M) Filtro `available_to_me` em `GET /v1/content` reusando `evaluateAccess` (lista mostra locked/unlocked sem vazar media URL).
- B4 (S) Multi-tier gating: modos `any_of_tiers` e `min_tier` (resolução por `position`), testes de matriz tier×item.
- B5 (M) Janela relativa por membro: `first_access_at` + avaliação on-demand.

#### Épico C — Publicação & agendamento
- C1 (M) CRUD de content items + máquina de estados (draft/scheduled/published/unpublish/archive) com validações.
- C2 (M) `content-publish-cron` (promove scheduled→published, emite `content.published`).
- C3 (M) `content-expiry-cron` (janela absoluta → expired; transições de live por starts_at/ends_at).
- C4 (S) Webhook `content.published` + gancho de notificação a elegíveis (handoff p/ communication).
- C5 (S) Coleções CRUD + vínculo a perk/tier (atalho UI).

#### Épico D — Conteúdo hospedado (Stanbase) + signed URLs
- D1 (M) Upload multipart (`/content/{id}/upload-url`) + capa + validação de mime/tamanho.
- D2 (M) Signed URL renovável (TTL curto) para progressive MP4 + `Range`.
- D3 (L) (pós-MVP) `content-stream-proxy` para HLS segmentado / re-assinatura por segmento.
- D4 (S) `content-grant-reaper` (expira grants, detecta abuso por IP).

#### Épico E — Embeds externos & providers
- E1 (M) Modelo (A): item externo unlisted/private; `external_ref` só liberado pós-`evaluateAccess`; player de embed por provider (YouTube/Vimeo/Twitch).
- E2 (S) Vimeo domain-privacy + YouTube/Twitch domain allowlist de embed; preview no admin.
- E3 (S) `provider-health-check`: detectar provider offline, degradar embed, mostrar fallback ("conteúdo temporariamente indisponível").
- E4 (L) (pós-MVP) Modelo (B): gating no provider — sync membership Stanbase ↔ YouTube Members / Twitch sub via `integrations-framework` + conta conectada do membro.

#### Épico F — Live fechada gated
- F1 (M) Estados de live (scheduled/live/ended) + janela `[starts_at-pre, ends_at+grace]` no gating.
- F2 (M) Embed de live unlisted (Twitch/YouTube) liberado por `evaluateAccess`; corte de acesso em revogação (re-eval no refresh).
- F3 (L) (pós-MVP) Live Stanbase-hosted (HLS baixa latência + signed manifest por membro + max_concurrent).
- F4 (S) Converter live encerrada em VOD (status ended→published reusando o mesmo item).

#### Épico G — Consumo & CRM (engajamento)
- G1 (M) `POST /progress` + `POST /complete` + `content-consumption-aggregator` (throttle, upsert, anti-fraude de watch time).
- G2 (S) Escrita consolidada por sessão em `interactions` (timeline CRM) + evento `content.consumed`.
- G3 (S) Resume point / "continuar assistindo".
- G4 (M) `GET /content/{id}/analytics` (views, conclusão, watch time, por tier).

#### Épico H — Telas
- H1 (L) Admin: biblioteca + editor (gating multi-tier, agendamento, janelas, live) + uploader.
- H2 (M) Admin: coleções + analytics por conteúdo.
- H3 (L) Membro: biblioteca gated (locked/unlocked + upsell) + player (signed URL + embed) + estados de erro.
- H4 (S) Watermark de overlay no player + UX de janelas ("expira em N dias", "ao vivo agora").

#### Épico I — Segurança & anti-pirataria
- I1 (S) Watermark dinâmico (Member ID/nome) overlay no player hospedado.
- I2 (S) Rate-limit de `/access` por membro/IP + detecção de compartilhamento (muitos IPs/mesmo grant).
- I3 (S) Buckets privados auditados; nenhuma URL pública permanente de media; testes de bypass.

---

### 7. Dependências

| Depende de | Por quê |
|---|---|
| **fundacao** | Schema base, `org_id`, RLS, Storage, pg_cron/pgmq, convenções de migration. |
| **auth-rbac** | Permissão de admin para publicar/gerir conteúdo; JWT do membro para `evaluateAccess`; escopo por org. |
| **member-identity** | `members`/`member_id`; consumo e gating são por membro. |
| **tiers-perks** | **Fonte do gating:** lê `entitlements` ativos (perk `content` → coleção). Cortesia de conteúdo é entitlement manual. Sem isto, não há "quem pode ver". Dependência mais crítica. |
| **payments-billing** | `member.status` (active/grace/inactive) que `evaluateAccess` exige é escrito pelos webhooks Asaas; revogação por chargeback corta acesso. |
| **crm** | `interactions`/timeline e `member_metrics.engagement_score` recebem consumo de conteúdo. |
| **integrations-framework** | Guarda credenciais (Connections) dos providers; sync de membership-level no provider (modelo B, pós-MVP). |
| **communication** | Notifica membros elegíveis em `content.published`. |
| **webhooks** | Emite `content.published`/`content.consumed`/`content.expired`. |
| **design-system / admin-app / member-app** | Biblioteca, editor, player, estados de gating. |
| **observability-qa** | Métricas de provider offline, abuso de grants, taxa de erro de `/access`. |

> Dependência mais forte e bloqueante: **tiers-perks** (gating é leitura de entitlements). Depois, **payments-billing** (status do membro) e **integrations-framework** (credenciais de provider).

---

### 8. Riscos & decisões técnicas

1. **Vazamento de signed URL / hotlink.** Uma signed URL com TTL longo pode ser compartilhada (WhatsApp) e funcionar até expirar. Mitigação: TTL curto + renovação no player + escopo por membro + grant auditável + (HLS) re-assinatura por segmento. **Trade-off real:** MP4 progressive simples = link reutilizável durante o TTL. Aceitar no MVP; HLS/proxy pós-MVP.
2. **"Unlisted não é privado" (providers externos).** YouTube unlisted / Vimeo private com link conhecido pode ser reaberto por quem pegou o `external_ref`. Mitigação: não vazar o `external_ref` antes do `evaluateAccess`, Vimeo **domain-privacy** (só toca no domínio da org), YouTube embed domain allowlist. **Conteúdo de altíssimo valor não deveria ir em provider externo unlisted** — usar Stanbase-hosted com DRM/watermark (pós-MVP). Decisão de produto sobre nível de proteção (Open Questions §8.4).
3. **Screenshot / captura de tela.** Não há defesa técnica perfeita no navegador (DRM/EME só dificulta vídeo, não foto de tela). Mitigação realista: **watermark dinâmico** (Member ID/nome translúcido sobre o vídeo) que torna o vazamento **rastreável** ao membro → efeito dissuasório + base para banir. Comunicar como "marca d'água de proteção", não como bloqueio.
4. **Provider externo offline.** Se YouTube/Twitch cai, o embed quebra na hora do drop. Mitigação: `provider-health-check`, fallback UX ("indisponível, tente em instantes"), e — para conteúdo crítico — **mirror Stanbase-hosted** como contingência. Não há SLA sobre provider de terceiro; documentar.
5. **HLS gating é caro.** Re-assinar cada segmento via Edge Function adiciona latência e custo de invocação. Avaliar **buy** (Mux/Cloudflare Stream com signed playback + DRM) vs **build** (proxy próprio). Decisão de arquitetura pós-MVP. MVP = progressive MP4.
6. **Janela temporal vs. cache/CDN.** Se o media é cacheado em CDN com TTL maior que a janela de acesso, o conteúdo pode continuar acessível após `access_until`. Garantir que CDN respeita o TTL da signed URL e que expiração é checada no `evaluateAccess` (não só no cron). Conteúdo expirado **nunca** deve ter signed URL viva — TTL do grant ≤ tempo até `access_until`.
7. **Acesso durante live com revogação.** Membro com chargeback no meio da live: o corte só ocorre no próximo refresh do manifesto/heartbeat (latência = TTL). Aceitável; documentar janela de corte. Para Stanbase-hosted, TTL menor = corte mais rápido.
8. **Gating multi-tier ambíguo (semântica OR vs AND).** Item exige "tier Sócio OU Camarote" — OR é o esperado. Mas `min_tier` muda se a **ordem dos tiers** (`position`) mudar (admin reordena → "tier mínimo" resolve a outro conjunto). Recomendação: `min_tier` guarda o `tier_id` de referência e resolve por `position` no momento da avaliação; avisar admin que reordenar tiers afeta gating por `min_tier`. **OR é o default.**
9. **Inflação de métrica de engajamento.** Heartbeats falsificáveis no client podem inflar watch time → enganar engagement/churn da IA. Mitigação: validar plausibilidade temporal no aggregator (delta entre heartbeats ≈ tempo real), progresso monotônico para conclusão, rate-limit. Não confiar cegamente no client.
10. **Despublicar/arquivar conteúdo em consumo.** Membro está assistindo quando admin arquiva → cortar na hora ou deixar terminar? Recomendação: arquivar **nega novos `/access`** mas grants já emitidos valem até expirar (não cortar no meio). Confirmar (Open Questions §8.7).
11. **Modelagem perk content por lista de IDs (doc) vs coleção (este plano).** O doc §25.5 sugeria `content_item_ids:[]`. Mudamos para coleção para evitar re-resolver entitlements ao publicar item novo. **Decisão registrada** — alinhar com tiers-perks. Risco: divergência de doc; mitigar com nota no §25.5.
12. **Custo de storage/egress de VOD.** Vídeo é pesado; egress do Supabase Storage pode ser caro em escala. Avaliar CDN/transcode externo cedo se houver muito VOD hospedado. Pós-MVP, mas monitorar custo desde o início.
13. **Janela relativa nunca expira se nunca acessada.** Item "7 dias após desbloquear" fica disponível indefinidamente para quem nunca abriu. Isso é correto por design, mas confunde admin que esperava "some em 7 dias para todos". UX precisa deixar claro absoluto vs relativo (Open Questions §8.2).

---

### 9. Escopo MVP vs. depois

#### MVP (alinhado à Fase 2 do §29 — "integrações... conteúdo (YouTube/Twitch)")
- `content_items` + coleções + gating por **tier(s)** e por **coleção** (OR + min_tier), lendo entitlements (§09).
- Tipos: **VOD, post/bastidor** (live no MVP só como embed externo).
- **Provider externo via embed (modelo A):** YouTube unlisted, Vimeo private (domain-privacy), Twitch embed — `external_ref` só liberado pós-`evaluateAccess`.
- **Stanbase-hosted via signed URL** (progressive MP4 + Range, TTL curto renovável) em bucket privado.
- **Agendamento de publicação** (publish_at + cron) e **janela de acesso absoluta** ("VOD por 7 dias" via `access_until`).
- **Janela relativa por membro** (drip básico) — incluir se barato; senão pós-MVP.
- **Biblioteca do membro** com locked/unlocked + upsell; **player** com signed URL/embed + estados de erro.
- **Consumo registrado** (view/progress/complete) → `content_consumption` + `interaction` no CRM (engajamento básico).
- **Watermark de overlay** simples (anti-pirataria dissuasório) + buckets privados auditados.
- Webhook `content.published`.

#### Depois (Fases 3+)
- **Live fechada Stanbase-hosted** (HLS baixa latência, signed manifest por membro, max_concurrent).
- **HLS segmentado / `content-stream-proxy`** (re-assinatura por segmento) + DRM (EME/Widevine) — ou adoção de Mux/Cloudflare Stream.
- **Gating no provider (modelo B):** sync membership Stanbase ↔ YouTube Members-only / Twitch subscriber-only via `integrations-framework` + conta conectada do membro.
- **Analytics avançado** (curva de retenção, heatmap, top conteúdos por tier) e contribuição ponderada ao engagement/churn da IA.
- **Notificações ricas** de novo conteúdo (campanha segmentada por elegibilidade) via communication.
- **Transcode/CDN externo** + multi-bitrate + watermark forjado server-side.
- **Detecção de compartilhamento** sofisticada (fingerprint de device, ban automático).
