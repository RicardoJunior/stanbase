## 85. Oportunidades de Integração — catálogo de expansão

> Levantamento abrangente de oportunidades de integração da Stanbase, organizado por categoria, priorizado e agrupado em ondas de implementação. Este documento é um **backlog vivo**: cada item é um connector plugável que destrava perks configuráveis por tier, e novos itens entram sem refatorar a plataforma.
>
> Fonte de verdade do mecanismo: §09 (tiers-perks / `entitlement_sync_jobs` / `pending_requirement`), §10 (payments-billing / Asaas), §11 (passport / Wallet), §12 (verification-checkin), §13 (events-tickets), §14 (content-gating), §15 (community-channels), §16 (communication), §17/§18 (Hall of Fame / IA), §19 (framework de integrações: Connector + Connection + Mapping + Webhook-in + Reconcile), §20-§22 (API pública, webhooks in/out), §23 (MCP).

---

### 85.1 O modelo (relembrar)

A Stanbase é uma plataforma de membership white-label multi-tenant para comunidades de fãs (gamers/esports, times/torcidas, clubes de carro, baladas/clubes noturnos, creators, empresas/associações). **Toda integração entra como um connector plugável que destrava PERKS configuráveis atrelados a planos/tiers.**

O fluxo central é sempre o mesmo:

1. O **dono conecta a integração uma vez** (OAuth, API key, bot token ou webhook), de forma self-service, sem código.
2. O dono **arrasta o perk para o tier** e preenche um form curto (o config-schema do perk-type).
3. Ao **entrar no tier**, o `entitlement` provisiona o perk automaticamente (cargo no Discord, grupo de WhatsApp, cupom na loja, acesso a VOD, drop, etc.). Ao **sair do tier**, desprovisiona — sem intervenção manual.

Premissas inegociáveis:

- **Fácil para o dono:** self-service, sem código. O dono nunca toca em token cru; o front só vê status e metadados (§19.1.3).
- **Barato para a Stanbase ampliar:** registrar um novo connector + perk-type no catálogo é uma operação padronizada, não um projeto. O domínio de integrações é o **substrato genérico** (§19) sobre o qual todas as integrações concretas rodam.
- **PSP = Asaas** (split nativo); segredos cifrados (Vault/pgsodium, §25.6); RLS por `org_id`; Edge Functions TS/Deno; pgmq/pg_cron para filas e jobs; tudo via API `/v1`.

#### Como adicionamos uma nova integração

Passo a passo de plataforma para colocar qualquer item deste catálogo no ar para **todas as orgs** de uma vez:

1. **Registrar o connector no catálogo** (`connectors`): declarar `auth_type` (OAuth2 code / OAuth2 client-credentials / API key / bot token / webhook-only / connect-on-demand), endpoints, e o conjunto de **capabilities** (`identity`, `niche_verify`, `channel_sync`, `content_access`, `event_import`, `payments`, `wallet`, `automation`, `commerce`, `drop_fulfillment`, `loyalty`, `ads-conversion`, `messaging` — a taxonomia é extensível).
2. **Registrar o(s) perk-type(s)** que o connector destrava, cada um com:
   - **config-schema** (o form curto que o dono preenche ao arrastar o perk no tier: ex. "qual cargo", "qual playlist", "qual nível mínimo de rank");
   - **hook de provisionar** (`grant`) e **hook de desprovisionar** (`revoke`), idempotentes;
   - opcionalmente um **`pending_requirement`** (ex. "conecte sua conta Steam", "informe o endereço de entrega") que o engine de entitlements (§09 1.12) resolve antes de ativar o perk;
   - opcionalmente uma **regra de reavaliação** (re-sync periódico via pg_cron, ex. rank que muda no tempo).
3. **Implementar webhook-in** (se o provider notifica eventos) com verificação de assinatura (HMAC/timestamp), normalizando para eventos internos; e o **reconcile job** (pg_cron) que corrige drift comparando estado desejado × real.
4. **Pronto:** o connector aparece no catálogo de integrações de **todas as orgs**; cada dono conecta sua própria `Connection` (credenciais cifradas por org) e cria seus `Mappings` (tier→recurso externo). Nenhuma refatoração de plataforma; nenhum deploy por org.

> Princípio: o framework **não conhece regra de membership** — recebe intenções (`{provider, action, member, external_ref}`) e as materializa, ou recebe eventos e os normaliza. Quem decide "esse membro merece o perk" é `tiers-perks`; o framework é o **encanamento confiável**.

---

### 85.2 Catálogo por categoria

> Convenção de deduplicação: integrações que apareciam em mais de uma categoria foram mantidas na categoria mais natural e **referenciadas** nas demais (ex.: Discord vive em Comunidade & Mensageria; Twitch/YouTube vivem em Streaming & Conteúdo; Sympla/Ingresse/Eventbrite vivem em Eventos & Ticketing; Zapier/Make/n8n/Webhooks vivem em Automação; GA4/Meta CAPI vivem em Marketing & CRM; catracas/NFC/QR vivem em Acesso Físico). Prioridade: **must / should / could**. Esforço: **S / M / L**.

#### 85.2.1 Gaming & Esports

| Integração | O que faz | Perks que destrava | Verticais | Auth | Prio | Esforço |
|---|---|---|---|---|---|---|
| **Steam** | OpenID + Steam Web API: lê biblioteca, horas, conquistas, ownership para validar fã de verdade | Tier gateado por horas/ownership; cargo Discord pós-validação; badge de achievement; drop por nível Steam | gamers/esports, creators, empresas | OAuth (OpenID) | must | M |
| **Riot Games (LoL/Valorant/TFT)** | RSO OAuth + Riot API: lê rank, região, maestria; re-sync periódico | Tier por elo; cargo Discord por rank sincronizado; canal de scrims; badge de rank; drop regional | gamers/esports, creators, times | OAuth | must | L |
| **Discord (Linked Roles / Rich Presence)** | Estende o connector Discord (§15) com Linked Roles e Rich Presence para gatear cargo por atributo verificado e "jogando agora" | Cargo via Linked Roles (rank/horas); cargo temporário "ao vivo"; sala de voz do tier; selo verificado | gamers/esports, creators, times, baladas | OAuth | must | M |
| **Twitch (Drops + Subs/Channel Points)** | Helix + EventSub: gateia membership por sub, concede Drops, lê Channel Points | Tier por sub (T1/T2/T3); Drop por tier; cargo Discord espelhando sub; conteúdo sub-only | creators, gamers/esports, times | OAuth | should | M |
| **Faceit** | OAuth2 + Data API: lê nível (1-10), Elo, stats de CS2 | Tier por nível; canal de PUG/mix; grupo WhatsApp de scrims; badge de nível; vaga em campeonato | gamers/esports, creators | OAuth | should | M |
| **Start.gg** | GraphQL API: importa torneios, lê placements/entries/seeds | Lote de membro em torneio; acesso antecipado a registro; badge por colocação; canal de competidores | gamers/esports, empresas | OAuth | should | M |
| **Gamers Club** | Equivalente BR da Faceit para CS: lê nível/ranking (validação por código no perfil) | Tier por nível; canal de mix/PUG; grupo de scrims; badge; vaga prioritária em liga | gamers/esports, creators | API key | should | L |
| **Garena (Free Fire)** | Valida conta/ID Free Fire (código no nick/provedor) — base mobile gigante no BR | Tier por patente; grupo de WhatsApp (canal nativo da base FF); cargo Discord; sorteio | gamers/esports, creators | API key | should | L |
| **Generic Game Account Verifier (código no perfil)** | Fallback: valida posse de qualquer conta sem API pedindo código no nick/bio | Validação de conta de qualquer jogo → destrava qualquer perk de nicho; tier "conta verificada" | gamers/esports, creators, empresas | arquivo | should | S |
| **Xbox / PlayStation Network** | XSAPI (Xbox, acesso restrito) / PSN (sem API oficial estável — risco) | Tier por gamerscore/troféu; cargo por plataforma; badge de platina; drop por jogo | gamers/esports, creators | OAuth | could | L |
| **Battle.net (Blizzard)** | OAuth2 + Game Data API: lê progresso de WoW, OW, Hearthstone, Diablo | Tier por personagem/conquista; cargo de guilda/raid; canal por jogo; badge de feito | gamers/esports, creators | OAuth | could | M |
| **Epic Games / Fortnite** | Epic Account Services OAuth: identidade e ownership; stats via terceiros | Tier de jogadores Fortnite; cargo por ownership Epic; vaga em scrim; badge por stat | gamers/esports, creators | OAuth | could | L |
| **Challengermode** | API de tournaments/registrations: importa torneios/ligas (esports europeu/global) | Inscrição prioritária; cargo para inscritos; badge por colocação; canal de circuito | gamers/esports, empresas | OAuth | could | M |

> Ver também: **Riot/Epic/Xbox/PSN account link** e **Steam OpenID Login** em Identidade & Login (85.2.6); **Recompensas Steam/Riot** em Loyalty (85.2.11); **Esports / ligas competitivas** em Esporte & Torcida (85.2.12).

#### 85.2.2 Streaming & Conteúdo

| Integração | O que faz | Perks que destrava | Verticais | Auth | Prio | Esforço |
|---|---|---|---|---|---|---|
| **Conteúdo Gated nativo (Stanbase-hosted)** | `provider=stanbase` (§14): VOD/post/bastidor em bucket privado, signed URL por membro, watermark dinâmico | Biblioteca de VODs/posts gated por tier; "VOD por 7 dias"; watermark com Member ID; cortesia avulsa | todas | arquivo | must | M |
| **Twitch** | Conecta canal: lê sub/follower e libera embeds live/VOD sub-only por tier (EventSub HMAC) | Live sub-only gated; VODs de sub; "é assinante" como pré-requisito; cargo Discord espelhando sub | creators, gamers/esports, times | OAuth | must | M |
| **YouTube** | Canal da org: gating de unlisted/Members-only por tier; sync de membership-level (pós-MVP) | Vídeos unlisted por tier; concessão de Membership Level; lives fechadas; playlist exclusiva | creators, gamers/esports, times, empresas | OAuth | must | L |
| **Kick** | Canal Kick: valida sub/follower, libera embeds live/VOD por tier | Live fechada Kick; VODs exclusivos; "assinante Kick" como pré-requisito; cargo Discord | creators, gamers/esports | OAuth | should | M |
| **Vimeo** | Vídeos privados com domain-privacy (whitelist do domínio) embedados e gated por tier | VODs privados por tier; showcase exclusivo; masterclasses; hashed URL pós-entitlement | creators, empresas, clubes de carro | OAuth | should | M |
| **TikTok** | Valida follow/engajamento e referencia conteúdo/lives por tier | "Segue no TikTok" como pré-requisito; badge fã verificado; lives; cargo Discord; sorteio | creators, baladas, gamers/esports | OAuth | should | M |
| **Instagram** | Valida follow (Graph API) e referencia Close Friends/Stories por tier | "Segue no Instagram" como pré-requisito; curadoria de Close Friends (semi-manual); badge | creators, baladas, times | OAuth | should | M |
| **Podcast / RSS Feed Gated** | Gera feed RSS privado e autenticado por membro (token assinado, revoga ao sair) | Feed privado do tier; episódios bônus/ad-free; early access; arquivo histórico gated | creators, empresas, gamers/esports, clubes de carro | arquivo | should | M |
| **Spotify** | Playlists colaborativas/privadas e validação "segue o artista" como perk | Playlist colaborativa do tier; setlist do show; "segue o artista" como pré-requisito; badge | creators, baladas, times | OAuth | could | M |
| **Apple Music** | MusicKit (JWT developer + user token): playlists curadas e engajamento como perk | Playlist curada do tier; "biblioteca/follow" como pré-requisito; badge; setlist do evento | creators, baladas | OAuth | could | M |
| **Importação Patreon** | Importa patrons/tiers/benefícios (one-shot) para migrar base ao Stanbase | Migração de patrons; mapeamento de tiers; badge "membro desde [data]"; acesso a coleções migradas | creators, gamers/esports | OAuth | could | L |
| **Mux / Cloudflare Stream** | Streaming profissional HLS multi-bitrate com signed playback + DRM | VODs adaptativos gated; lives de baixa latência; DRM forte; corte rápido em revogação | creators, gamers/esports, times | API key | could | L |
| **Substack / Newsletter Gated** | Importa/valida assinantes pagos (Substack/beehiiv) e libera arquivo gated | Arquivo de posts pagos por tier; "assinante pago" como pré-requisito; convite à lista; badge fundador | creators, empresas | API key | could | M |

> Ver também: **Web Push / FCM / APNs / WhatsApp Cloud API** em Email/Push/SMS (85.2.8); **Zoom / YouTube Live / Twitch (acesso a evento online)** em Eventos (85.2.4).

#### 85.2.3 Comunidade & Mensageria

| Integração | O que faz | Perks que destrava | Verticais | Auth | Prio | Esforço |
|---|---|---|---|---|---|---|
| **Discord** | Bot + OAuth: atribui/remove cargos e libera canais por tier; reconcilia via `guildMemberRemove` | Cargo exclusivo por tier; canal/categoria privada; cargo de verificação; cor de nick; convite a voice/stage | todas | OAuth (bot + user) | must | M |
| **Telegram** | Bot gera convites de uso único e gerencia entrada/saída em grupos/canais; job de reconciliação | Grupo VIP por tier; canal de broadcast; convite único expirável; kick/ban ao sair | creators, gamers/esports, times, baladas, empresas | API key + webhook | must | M |
| **WhatsApp (Cloud API oficial)** | Embedded Signup (Meta): adiciona a grupos/Comunidades e dispara transacionais/campanha por tier | Grupo/Comunidade do tier; lista de transmissão; convite por tier; boas-vindas; atendimento prioritário | times, baladas, creators, empresas, clubes de carro | OAuth (Meta) + webhook | must | L |
| **Slack** | Convida/remove de canais privados e user groups por tier (workspace pago p/ admin scopes) | Canal privado por tier; canais premium; user group; deactivate/kick ao sair | empresas, creators, gamers/esports | OAuth | should | M |
| **Circle.so** | Admin/Headless API: acesso a spaces/space groups e member tags por tier | Space/Space Group por tier; member tag; convite a cursos/eventos; revogação ao sair | creators, empresas, gamers/esports | API key | should | M |
| **Discourse / Fórum nativo** | Admin API + DiscourseConnect (SSO): grupos, badges e categorias por tier | Categorias privadas; Discourse group; badge/título; trust level elevado; remoção ao sair | clubes de carro, empresas, gamers/esports, creators | API key + SSO | should | M |
| **WhatsApp via BSP (360dialog / Gupshup / Z-API)** | Camada de provedor BSP brasileiro para orgs que já têm número (disparo/gestão de grupos em escala) | Campanha por tier via número próprio; convite a grupo/Comunidade; transacionais; fila prioritária | times, baladas, creators, empresas | API key + webhook | should | M |
| **Reddit** | Aprova approved users em subreddits privados e atribui flair por tier | Subreddit privado por tier; flair exclusivo; remoção de approved ao sair | gamers/esports, creators, clubes de carro | OAuth | could | M |
| **Guilded** | Alternativa ao Discord (esports/clans): cargos e canais por tier via bot | Cargo Guilded por tier; canais privados; verificação; remoção ao sair | gamers/esports | API key + webhook | could | M |
| **Matrix / Element** | Homeserver federado/self-host: rooms/spaces criptografados por tier (soberania de dados) | Room/space privado; power level elevado; space federado; kick ao sair | gamers/esports, empresas, creators | API key | could | M |
| **Mighty Networks** | Spaces e planos do app por tier (concorrente do Circle) | Spaces privados; plano/level do Mighty; cursos/eventos gated; revogação ao sair | creators, empresas | API key | could | M |
| **Facebook Groups** | Auto-aprova entrada e remove (best-effort, Graph API restrita) | Aprovação automática no grupo; triagem por Member ID; remoção ao sair | times, baladas, empresas | OAuth | could | L |

> Ver também: **Discord Login** em Identidade & Login (85.2.6); **Telegram Bot (notificações)** em Email/Push/SMS (85.2.8); **Slack/Microsoft Teams/Google Workspace** (provisionamento corporativo) em Empresas & Produtividade (85.2.13).

#### 85.2.4 Eventos & Ticketing

| Integração | O que faz | Perks que destrava | Verticais | Auth | Prio | Esforço |
|---|---|---|---|---|---|---|
| **Sympla** | Importa eventos/ingressos/check-ins da maior plataforma BR; ingresso vira passport pass escaneável | Lote de membro / acesso antecipado; cupom de membro; pass no Wallet; evento tier_gated; badge por presença | todas | OAuth/API key + webhook | must | L |
| **Ingresse** | Gêmeo da Sympla (forte em festas/festivais/baladas): importa e espelha ingressos como passes | Pré-venda do tier; pass com QR; cortesia de membro; lista VIP/camarote; funil lead→membro | baladas, creators, times, empresas | OAuth/API key + webhook | must | L |
| **Listas de Balada / Guest List & RSVP nativo** | Módulo nativo: entrar no tier já inclui o nome na lista da casa (§13.1.7) | Nome automático na guest list; cortesia/drink; entrada free até X hora; camarote VIP; pass na porta | baladas, creators | nativo | must | S |
| **Controle de Presença & Check-in (Scanner Stanbase)** | Portaria nativa (§12): valida pass/QR online+offline, marca presença, anti-reuso; consumidor de todos os connectors de ticketing | Entrada via pass; fila prioritária por tier; badge por presença; reentrada controlada; porteiro vê tier | todas | nativo | must | M |
| **RSVP & Confirmação (eventos da área de membro)** | Eventos exclusivos de tier com RSVP e capacidade limitada, sem ticketing pago (§13.1.8) | Meet&greet/watch party com RSVP; vaga limitada + waitlist; pass de confirmação; lembrete no canal | creators, gamers/esports, clubes de carro, empresas, times | nativo | must | S |
| **Eventbrite** | Importa eventos/attendees globalmente (orgs internacionais/corporativas) | Acesso antecipado / promo code; pass com QR; evento tier_gated; badge de presença | empresas, creators, clubes de carro, gamers/esports | OAuth + webhook | should | M |
| **Shotgun** | Importa eventos da plataforma global de nightlife/eletrônica; guest list e presale por tier | Presale/lote do tier; guest list automática; pass com QR; skip-the-line | baladas, creators | OAuth/API key + webhook | should | M |
| **Eventim / Eventim Brasil** | Ticketing de grandes eventos/arenas: importa alto volume, valida sócio-torcedor na portaria | Pré-venda de sócio-torcedor; setor/cadeira cativa; pass complementar; prioridade em clássicos | times, creators, empresas | API key / B2B + webhook | should | L |
| **Zoom / YouTube Live / Twitch (acesso a evento online)** | Libera link/sala de evento online só para tiers elegíveis (provisiona/revoga) | Link Zoom / sala privada; live unlisted/sub-only; auto-registro em webinar; watch party/AMA | creators, gamers/esports, empresas | OAuth + webhook | should | M |
| **Webhook genérico de Ticketing / Zapier-Make** | Fallback universal: recebe vendas/check-ins de qualquer fonte e cria tickets/passes (§19.1.10) | Qualquer ingresso externo vira pass; lote por tier via automação; check-in de qualquer fonte; RSVP de form | todas | webhook (HMAC) / API key | should | S |
| **Hotmart / Kiwify (ingresso/workshop)** | Importa compras de ingressos/inscrições de eventos ao vivo e concede acesso/pass | Inscrição em workshop vira acesso; preço de membro; pass com QR; gravação (VOD) por tier | creators, empresas | API key + webhook | could | M |
| **Meetup** | Sincroniza grupos/eventos, importa RSVPs e presença (cadência recorrente) | Evento do grupo na área de membro; vaga prioritária; badge de frequência; encontro privado do tier | clubes de carro, empresas, gamers/esports, creators | OAuth + webhook | could | M |
| **Google Calendar / Apple Calendar (ICS)** | Add-to-Calendar / feed ICS assinável; mantém data sincronizada em postponements | Evento no calendário com lembrete; atualização automática de data; agenda assinável; alerta de lote | empresas, creators, clubes de carro, gamers/esports, times | arquivo (ICS) / OAuth | could | S |

> Ver também: **Bilheteria oficial do clube** e **catraca de estádio** em Esporte & Torcida (85.2.12); **Catraca/NFC/QR/Geofencing/Biometria** em Analytics & Acesso Físico (85.2.14).

#### 85.2.5 Pagamentos & Finanças (além do Asaas)

| Integração | O que faz | Perks que destrava | Verticais | Auth | Prio | Esforço |
|---|---|---|---|---|---|---|
| **Pix Automático (recorrência via banco)** | Débito Pix recorrente autorizado no app do banco; MDR mínimo (§13.2.2) | Tier recorrente que renova sozinho; sócio com mensalidade Pix; renovação silenciosa anti-churn | times, empresas, clubes de carro, creators | webhook | must | M |
| **Antecipação de Recebíveis** | Recebe à vista vendas parceladas; spread (juros pass-through − custo Asaas) (§13.3) | Tier em até 12x com org recebendo líquido; lote fundador parcelado; viabiliza tiers vitalícios caros | clubes de carro, times, empresas, gamers/esports | API key | must | M |
| **Régua de Cobrança / Recuperação (dunning)** | Retentativas e comunicação multicanal sobre estado da assinatura (§10.1.9) | Mantém acesso no grace period; link "pagar agora via Pix"/"trocar cartão"; recupera inadimplente | times, empresas, creators, clubes de carro | webhook | must | M |
| **Mercado Pago** | PSP alternativo: Pix, cartão, boleto, saldo MP, split nativo de marketplace | Ativa perk quando Pix/cartão confirma; checkout com saldo MP; tier via boleto; desconto saldo MP | creators, empresas, baladas, times | OAuth | should | L |
| **Stripe (Payments + Connect + Billing)** | PSP internacional: multimoeda, recorrência global, repasse a contas conectadas | Tier internacional em USD/EUR; assinatura recorrente global; membership para audiência gringa; tier global founder | creators, gamers/esports, empresas | OAuth | should | L |
| **Boleto Bancário (registrado)** | Método para quem não tem cartão/Pix; libera acesso na compensação | Tier anual PJ via boleto; ingresso/lote por boleto; cobrança PJ com nota | empresas, clubes de carro, times | webhook | should | S |
| **Emissão de NF (eNotas)** | Orquestra NFS-e em qualquer prefeitura a partir de cada transação paga | NF automática no recibo; "membership com NF" para PJ; envio da NFS-e por e-mail | empresas, clubes de carro, creators | API key | should | M |
| **Carteira & Cashback de Membro (loyalty/créditos)** | Carteira interna de créditos/cashback por org (ledger nativo); recompra | Cashback % vira saldo (mais no VIP); saldo abatido no checkout; créditos de boas-vindas; moeda para drops | baladas, times, creators, gamers/esports | API key | should | L |
| **Apple Pay / Google Pay** | Botões de carteira do dispositivo sobre o PSP; reduz fricção no mobile | Checkout 1-tap; compra rápida na fila da balada; renovação/upgrade sem digitar cartão | baladas, gamers/esports, creators, times | API key | should | M |
| **PayPal** | Carteira/checkout global para audiência internacional | Tier via PayPal por fã gringo; apoio recorrente; ingresso online; role de apoiador internacional | creators, gamers/esports | OAuth | could | M |
| **PicPay** | Carteira BR popular com jovens/gamers: QR/saldo e parcelamento próprio | Tier com saldo PicPay; cashback como perk; ingresso de balada; desconto PicPay | baladas, gamers/esports, times | API key | could | M |
| **Cartão Internacional / Multi-moeda** | Aceita cartão estrangeiro com câmbio e antifraude (faceta do Stripe) | Tier "global" com cartão estrangeiro; membership para diáspora; ingresso multilíngue | gamers/esports, creators, times | OAuth | could | L |
| **Emissão de NF (NFe.io)** | Alternativa fiscal de NFS-e/NF-e por transação | NFS-e por assinatura/parcela; consolidação fiscal de mensalidades; recibo fiscal no portal | empresas, creators, times | API key | could | M |
| **Cripto / Stablecoin (USDC)** | Pagamento em stablecoin para audiência web3 (conversão a fiat) | Tier em USDC; membership internacional sem fricção bancária; perk colecionável on-chain | gamers/esports, creators | API key | could | L |

> Ver também: **Mercado Livre / Mercado Pago Pontos**, **Dotz**, **Livelo** (loyalty) em 85.2.11; **Cartão NFC cashless** em 85.2.14.

#### 85.2.6 Identidade & Login

| Integração | O que faz | Perks que destrava | Verticais | Auth | Prio | Esforço |
|---|---|---|---|---|---|---|
| **Google Sign-In** | Login social Google: email verificado, nome, foto, onboarding sem senha | Cadastro 1-clique destrava tier free; avatar/nome sincronizados; área logada; email verificado p/ entregas | todas | OAuth | must | S |
| **Apple Sign-In** | Login Apple ID com Hide My Email; obrigatório em apps iOS com login social | Cadastro 1-clique no iOS; identidade privada (relay); área de membro mobile | creators, gamers/esports, times, baladas | OAuth | must | M |
| **Discord Login** | Login Discord traz `discord_id` → provisiona cargos/canais automaticamente | Cargo por tier; canais privados; sync de nickname; remoção automática ao sair | gamers/esports, creators, times, clubes de carro | OAuth | must | M |
| **Telefone + OTP (SMS/WhatsApp)** | Verificação de celular por OTP; identidade por telefone (chave p/ perks de WhatsApp) | Entrada no grupo WhatsApp do tier; lista de transmissão; login passwordless; avisos no número validado | times, baladas, clubes de carro, creators, empresas | API key | must | M |
| **Gov.br (login federado nacional)** | Login Gov.br: CPF verificado e selo (bronze/prata/ouro) como prova real | Tier verificado por identidade real; anti-multiconta (1 por CPF); sorteios regulados; tier por selo ouro | empresas, times, baladas | OAuth | should | L |
| **Validação de CPF (Serpro/Serasa/Datavalid)** | Valida situação cadastral e nome×CPF para membro real e único | Tier só a CPF válido; 1 membership por CPF; recibo de sócio com CPF; desconto condicionado a CPF ativo | times, empresas, baladas | API key | should | M |
| **Verificação de idade / Age Gate** | Confirma maioridade (DOB + checagem leve, evolui p/ KYC) | Tier 18+ (balada/bebida); conteúdo restrito por idade; ingresso 18+; bloqueio de perk a menores | baladas, creators, gamers/esports | API key | should | S |
| **Magic Link / Email passwordless** | Autenticação por link no email, sem senha | Onboarding sem senha; recuperação simples; email verificado p/ entrega de perks | empresas, creators, clubes de carro, times | API key | should | S |
| **KYC / Verificação documental (Idwall, Unico, Onfido)** | Documento + selfie/liveness + facematch para provar identidade | Selo "membro verificado"; tier premium pós-KYC; credencial com foto; benefícios de alto valor sem fraude | empresas, times, baladas | webhook | should | L |
| **Steam OpenID Login** | Login Steam vincula SteamID; base para perks de jogos/inventário | Identidade gamer verificada; tier por ownership/horas; lobbies exclusivos; perk de chave Steam | gamers/esports, creators | OAuth | should | M |
| **Facebook / Meta Login** | Login Facebook para público mais amplo/velho | Cadastro 1-clique; identidade social; pré-preenchimento p/ perks de evento | times, clubes de carro, empresas | OAuth | could | S |
| **X / Twitter Login** | Login X traz handle; gating por seguir/engajar | Badge de identidade social; tier que exige seguir a conta; shoutout/RT; acesso antecipado a drops | creators, gamers/esports, times | OAuth | could | M |
| **Riot / Epic / Xbox / PSN account link** | Vincula contas de jogo (ID/region) para validar rank/posse/roles | Role/skin validada; tier por rank mínimo; lobbies/scrims; perk in-game ao entrar no tier | gamers/esports, creators | OAuth | could | L |
| **Passkeys / WebAuthn (FIDO2)** | Login biométrico/dispositivo sem senha | Login biométrico rápido; segurança para tiers premium; selo "conta protegida" | empresas, creators, gamers/esports | API key | could | M |

#### 85.2.7 Commerce & Merch

| Integração | O que faz | Perks que destrava | Verticais | Auth | Prio | Esforço |
|---|---|---|---|---|---|---|
| **Shopify** | Admin API + Price Rules/Discounts + Webhooks + Fulfillment: cupons por tier, validação de compra, fulfillment de drops | Cupom exclusivo do tier; preço de membro; frete grátis; early-access; brinde no checkout; store credit | times, creators, gamers/esports, clubes de carro, empresas | OAuth | must | L |
| **Nuvemshop (Tiendanube)** | Líder BR/LatAm: OAuth2 + webhooks HMAC + Coupons/Discounts/Orders | Cupom do tier; preço de membro; frete grátis; brinde em pedido; early-access; selo de membro | times, creators, clubes de carro, empresas, baladas | OAuth | must | L |
| **Catálogo de produtos & Drops (nativo Stanbase)** | Loja interna: produtos/brindes/drops vendidos no checkout Stanbase com split (§13/§14) | Drop físico/digital do tier; preço/lote de membro; brinde incluso; early-access; merch numerado (Fundador #042) | todas | API key | should | L |
| **Yampi** | Checkout BR forte em creators/infoprodutos: User-Token + Secret + webhooks | Cupom do tier; order bump/brinde; validação de compra → badge; frete grátis | creators, times, empresas | API key | should | M |
| **WooCommerce** | REST API (Consumer Key/Secret) + webhooks HMAC: lojas WordPress self-hosted | Cupom do tier; preço de membro; frete grátis; brinde; early-access; compra → badge | creators, clubes de carro, empresas, times | API key | should | M |
| **Printful** | Print-on-demand global: drops físicos por entitlement, sem estoque do dono | Drop de boas-vindas; merch exclusivo do tier; brinde anual de fidelidade; kit fundador; item personalizado | creators, times, gamers/esports, clubes de carro | OAuth | should | L |
| **Loja Integrada** | Lojas de PMEs/clubes no BR: cupons e sync de pedidos | Cupom do tier; preço por categoria; frete grátis; brinde; validação de pedido | empresas, clubes de carro, times | API key | could | M |
| **Printify** | POD multi-fornecedor (alternativa ao Printful, custo competitivo) | Drop de merch; produto exclusivo do nível; brinde de fidelidade; kit fundador/edição limitada | creators, gamers/esports, times | API key | could | M |
| **Cartpanda** | Checkout BR para creators/infoprodutos: cupons e validação de compra | Cupom do tier; order bump/upsell; desconto; compra → entitlement | creators, empresas | API key | could | M |
| **Spreadshirt / Spring (Teespring)** | Merch POD para creators com storefront próprio | Cupom/desconto na loja do creator; produto exclusivo do tier (link privado); early-access; brinde por antiguidade | creators, gamers/esports | API key | could | M |
| **Cuponomia / Clube de cupons de parceiros** | Agrega cupons/cashback de marcas como perk (afiliados) | Clube de descontos por tier; cashback de membro; cupom de marca ao subir de tier | empresas, times, clubes de carro | API key | could | M |
| **Mercado Livre / Mercado Shops** | OAuth2 + webhooks de orders: valida compra de produto oficial, concede badge/cupom | Compra oficial → badge/entitlement; cupom Mercado Shops; selo de comprador no Hall of Fame | times, clubes de carro, empresas | OAuth | could | L |
| **Amazon Seller / Storefront (afiliado)** | PA-API (Associates): curadoria de produtos como perk + receita de afiliado | Lista de equipamentos do tier (setup do pro); link de afiliado; early-access a recomendações | creators, gamers/esports, clubes de carro | API key | could | M |

#### 85.2.8 Email, Push & SMS

| Integração | O que faz | Perks que destrava | Verticais | Auth | Prio | Esforço |
|---|---|---|---|---|---|---|
| **Resend** | E-mail transacional/marketing dev-first: API + webhooks de entrega assinados | Newsletter do tier; boas-vindas; entrega de drop/gift; ingresso com Add to Wallet; alerta de conteúdo; dunning | todas | API key + webhook | must | M |
| **Amazon SES** | E-mail de baixíssimo custo + SNS para bounce/complaint; alto volume | Mesmos perks de e-mail em grande volume; transacionais de billing escaláveis | times, creators, empresas, gamers/esports | API key + webhook | must | M |
| **Web Push (VAPID)** | Push nativo do navegador/PWA, sem terceiro | "Conteúdo novo do seu tier"; abertura de lote; live começando; lembrete de evento; subiu no Hall of Fame | todas | API key (VAPID) | must | M |
| **WhatsApp Cloud API (Meta)** | API oficial 1:1 e broadcast por template aprovado (§30); compartilha connection com community-channels | Aviso de drop; ingresso com Add to Wallet; confirmação/renovação; convite a grupo; atendimento 1:1 premium | todas | OAuth (Meta) + webhook | must | L |
| **SendGrid (Twilio)** | E-mail consolidado: Marketing Campaigns, Event Webhook, supressões | Newsletter por tier; boas-vindas; entrega de gift; supressão LGPD; sequências de reativação | empresas, creators, times, gamers/esports | API key + webhook | should | M |
| **Mailgun** | E-mail transacional/marketing + validação de e-mail (região EU p/ LGPD) | Perks de e-mail por tier; validação anti-bounce; roteamento de respostas (inbound) | empresas, creators, times | API key + webhook | should | M |
| **OneSignal** | Push multicanal (web + mobile) gerenciado: segmentação, agendamento | Push gated por tier (web/app); "acesso VIP liberado"; re-engajamento; anúncio de novo canal | gamers/esports, creators, baladas, times | API key + webhook | should | M |
| **Zenvia** | Mensageria BR-first: SMS, WhatsApp BSP, RCS, voz; cobertura nas operadoras | SMS de evento/check-in; lembrete de cobrança; OTP; WhatsApp BSP; RCS rico | baladas, times, empresas, clubes de carro | API key + webhook | should | M |
| **Twilio (SMS / Verify / Messaging)** | SMS, OTP e mensageria global (também WhatsApp BSP) | SMS transacional; OTP/Verify; lembrete de cobrança; WhatsApp via Twilio; SMS internacional | empresas, gamers/esports, creators, times, baladas | API key + webhook | should | M |
| **Postmark** | E-mail premium de alta entregabilidade; streams separados | Transacionais ultraconfiáveis (recibo, ingresso, gift); stream dedicado; dunning com alta chegada | empresas, clubes de carro, creators, times | API key + webhook | could | S |
| **Firebase Cloud Messaging (FCM)** | Push gratuito Android/iOS/Web (quando houver app nativo) | Push mobile gated por tier; alerta de lote no celular; lembrete; conquista no app | gamers/esports, creators, times, baladas | API key (service account) | could | M |
| **APNs — marketing** | Push iOS nativo de marketing/lifecycle (distinto do APNs do passport) | Push iOS gated por tier; convite VIP no iPhone; lembrete de evento | gamers/esports, creators, times | API key (.p8 JWT) | could | M |
| **RCS Business Messaging (Google)** | SMS rico no Android (cards, botões, marca verificada) via BSP | Card de evento com botão de compra; convite VIP com imagem/CTA; renovação com botão de pagamento | baladas, times, creators, empresas | API key (BSP) + webhook | could | L |
| **Telegram Bot (notificações)** | Reusa connection Telegram + capability messaging (custo zero/msg) | Aviso de drop/conteúdo/evento por DM; lembrete; canal de avisos do tier | gamers/esports, creators, clubes de carro, times | API key + webhook | could | S |

#### 85.2.9 Marketing & CRM externos

| Integração | O que faz | Perks que destrava | Verticais | Auth | Prio | Esforço |
|---|---|---|---|---|---|---|
| **RD Station Marketing & CRM** | Líder SMB BR: sync de contatos/eventos + webhook de lead-score/conversão aciona perk | Tier por lead-score; fluxo de nutrição do tier; cupom para "em risco"; badge "indicado"; acesso antecipado por segmento | empresas, creators, times, clubes de carro, baladas | OAuth | must | M |
| **HubSpot** | Espelha base como contacts/companies/deals; workflows e lifecycle acionam perks | Tier por deal fechado/lifecycle; convite a evento; cupom de retenção; badge NPS promotor; grupo WhatsApp por smart list | empresas, creators, gamers/esports, times | OAuth | must | M |
| **Meta Ads (CAPI + Custom Audiences)** | Envia conversões server-side e sincroniza audiências/lookalike (Pixel + CAPI) | Lote para quem converteu via Meta; early-access para Custom Audience; oferta de upgrade segmentada; perk de indicação | baladas, creators, times, clubes de carro, gamers/esports | OAuth | must | L |
| **Rastreamento de pixels & tags (GTM / GA4 / server-side)** | Injeta/gere pixels e tags via GTM no front/checkout; expõe eventos de membership | Habilita atribuição dos connectors de Ads; badge/segmento de origem; funil de recuperação de carrinho | todas | API key | must | M |
| **UTM tracking & atribuição de origem** | Captura/persiste UTMs e click-ids no checkout e no perfil (nativo) | Badge "veio da campanha X"; lote/cupom por link específico; cross-promo de parceiro/creator; boas-vindas por origem | todas | webhook | must | S |
| **Programa de afiliados / indicação (referral)** | Link/código único por membro; perk ao indicador e indicado na conversão (nativo) | Badge "Embaixador" + cargo; mês grátis por indicação; cupom para indicado; tier "Fundador-Indicador"; Hall de Top Indicadores | todas | webhook | must | M |
| **Mailchimp** | Audiências/tags + automações de e-mail como gatilho leve | Newsletter VIP por tag; cupom de boas-vindas; badge "Engajado" por abertura/clique; sorteio segmentado | creators, empresas, clubes de carro, baladas | OAuth | should | S |
| **ActiveCampaign** | Automação comportamental e scoring acionam perks por jornada | Cargo Discord por deal score; cupom de upgrade; reativação (mês grátis); acesso antecipado por automação | creators, empresas, gamers/esports, times | API key | should | M |
| **Customer.io** | Event-driven: recebe eventos de membership e dispara mensagens/perks comportamentais | Onboarding por jornada; cupom de retenção; badge de marco (30 dias); convite VIP push/in-app | gamers/esports, creators, empresas, baladas | API key | should | M |
| **Google Ads (Conversions + Customer Match)** | Upload de conversões offline e listas Customer Match por tier | Cupom de boas-vindas por campanha Google; audiência de upgrade; "primeiro mês grátis" por conversão offline | empresas, creators, clubes de carro, times | OAuth | should | L |
| **WhatsApp Marketing via BSP (Take/Zenvia/Twilio/360dialog)** | Marketing/CRM outbound segmentado por tier (broadcast/templates HSM); distinto do channel_sync | Lista de transmissão VIP; cupom por template; concierge premium; convite a grupo na ativação | baladas, times, clubes de carro, creators, empresas | API key | should | M |
| **TikTok Ads (Events API)** | Conversões server-side e audiências por tier (público jovem) | Lote para quem veio do TikTok; drop/ingresso para audiência do tier; badge "veio do TikTok" | baladas, creators, gamers/esports, times | OAuth | could | M |
| **Brevo (ex-Sendinblue)** | Contatos/listas para e-mail + SMS marketing acessível (alternativa Mailchimp/RD) | Newsletter VIP por lista; cupom de boas-vindas; badge de engajamento; SMS de pré-venda | creators, empresas, baladas, clubes de carro | API key | could | S |
| **Segment / RudderStack (CDP)** | Publica eventos/perfis num CDP que faz fan-out para N ferramentas | Habilita perks de qualquer destino (1 conexão → N tools); segmento computado como gatilho; atribuição unificada | empresas, creators, gamers/esports, times | API key | could | M |

#### 85.2.10 Automação & No-code/Dev

| Integração | O que faz | Perks que destrava | Verticais | Auth | Prio | Esforço |
|---|---|---|---|---|---|---|
| **Zapier** | App oficial (§22): triggers (member.created, tier_changed, checkin, payment) e actions p/ 7.000+ apps | Perk "concedido por automação"; convite a grupo externo por Zap; brinde de parceiro; tag/segmento alimentado | todas | OAuth | must | M |
| **Webhooks de saída (Outbound)** | Endpoints HTTPS do dono recebem eventos assinados (HMAC) em tempo real (§22) | Perk "webhook custom"; provisionamento em sistema legado; trigger de benefício parceiro; baixa em member.churned | todas | webhook | must | S |
| **API REST pública + OpenAPI/Swagger** | A própria API `/v1` documentada (§21): connector base que tudo consome | Qualquer perk custom sobre entitlements; área de membro headless; concessão programática; GET /verify | todas | API key | must | M |
| **SDK JS/React + Embeds** | Componentes (`<TierCheckout/>`, `<MemberCard/>`, `<AddToWallet/>`, `<VerifyBadge/>`) e iframes (§5.3/§24.3) | Checkout embutido; member card embutido; badge de verificação em site parceiro; botão Add to Wallet | todas | API key (publishable) | must | M |
| **Make (Integromat)** | Cenários visuais multi-step sobre a mesma API/webhooks (forte no BR) | Perk por cenário Make; fluxo multi-etapa com condição externa; roteamento p/ múltiplos destinos; revogação coordenada | creators, empresas, clubes de carro, gamers/esports, baladas | OAuth | should | M |
| **n8n** | Node oficial (self-host/cloud) para donos técnicos/agências; open-source sem custo/op | Perk por workflow self-hosted; provisionamento de sistemas internos; sync com legado; regras avançadas | empresas, creators, gamers/esports, clubes de carro | API key | should | M |
| **Webhooks de entrada (Inbound / Custom trigger)** | Endpoint por org que converte POSTs externos assinados em ações de membership | Perk por sinal externo (comprou na loja → tag/perk); upgrade por condição confirmada; entitlement avulso; tier de cortesia | empresas, creators, gamers/esports, times, clubes de carro | webhook | should | M |
| **MCP Server (agentes de IA)** | Servidor MCP (§23) expõe a Stanbase como ferramentas para agentes do dono | Concessão de perk por IA; cortesia por copilot via linguagem natural; upgrade conversacional; emissão de passport por agente | empresas, creators, gamers/esports, times | OAuth | should | M |
| **Google Sheets** | Connector bidirecional: exporta base/segmentos e importa linhas como gatilho | Perk ao adicionar à planilha (lista VIP); lote por planilha de pré-cadastro; tag por coluna; cortesia em massa | empresas, clubes de carro, times, baladas, creators | OAuth | should | M |
| **Notion** | Sincroniza membros/segmentos e serve conteúdo gated hospedado no Notion | Wiki Notion exclusivo do tier; página/database privado; diretório de membros; convite a workspace | creators, empresas, gamers/esports | OAuth | could | M |
| **Airtable** | Sincroniza membros/entitlements e dispara perks a partir de registros | Perk por status Airtable; lista de espera/curadoria libera lote; segmento por view; cortesia por form | empresas, creators, clubes de carro, gamers/esports | OAuth | could | M |
| **Pipedream** | Automação orientada a código serverless para devs | Perk por workflow com código; integração com APIs de nicho; provisionamento custom por evento composto | gamers/esports, creators, empresas | API key | could | S |
| **CLI / SDKs de servidor (Node, Python)** | SDKs gerados do OpenAPI + CLI para scripts/jobs em lote (§28) | Concessão em massa via script; batch de revogação/renovação; provisionamento em CI/CD; sync agendado | empresas, gamers/esports, creators | API key | could | S |
| **Discord/Slack Bot framework (chatops)** | Entrega eventos de membership a um bot do dono para automação operacional (distinto do perk de cargo) | Alerta interno (superfã assinou / em risco); comando de bot p/ conceder perk; notificação de check-in/venda no ops | gamers/esports, creators, times, baladas, empresas | webhook | could | S |

#### 85.2.11 Loyalty, Rewards & Web3

| Integração | O que faz | Perks que destrava | Verticais | Auth | Prio | Esforço |
|---|---|---|---|---|---|---|
| **Pontos & Cashback nativo (Stanbase Points Engine)** | Motor interno de pontos/XP: credita por ação, troca por perks; alimenta Hall of Fame (§18) | Saldo na carteirinha; resgate por brinde/drop; cashback em pontos por renovação; multiplicador por tier; subida automática por X pontos; ranking | todas | nativo | must | L |
| **POAP (Proof of Attendance)** | Emite colecionável on-chain de presença no check-in (§12) | POAP no check-in; perk por X POAPs; drop para holders; badge por coleção; acesso antecipado token-gated | gamers/esports, times, baladas, creators, clubes de carro | API key | should | M |
| **Token-Gating / NFT-Gating** | Verifica posse de NFT/token na wallet (Alchemy/Moralis) e usa como prova (niche_verify) | Tier/cargo para holders; grupo de holders; lote de holder; conteúdo gated; desconto na loja | gamers/esports, creators, times, clubes de carro, baladas | API key + wallet | should | M |
| **Wallet Connect (MetaMask / WalletConnect)** | Vincula wallet via SIWE (sem custódia de chave); habilita verificações on-chain | Habilita token-gating; recebimento de drops on-chain; "wallet verificada" como pré-requisito; selo no Hall of Fame | gamers/esports, creators, times, clubes de carro, baladas | SIWE / WalletConnect | should | M |
| **Sorteios & Giveaways (engine de premiação)** | Sorteios com elegibilidade por tier/segmento/pontos e seleção auditável | Entrada automática por tier; cotas extras por pontos; sorteio de ingresso/meet&greet; ganhador recebe entitlement | todas | nativo (+ VRF/Random.org opcional) | should | M |
| **Recompensas Steam / Riot (códigos in-game)** | Reusa niche_verify Steam/Riot (§19.5) + distribuição de código/lote | Código de skin/cosmético por tier; drop in-game validado; crédito por pontos; role validada → cargo; ranking de horas | gamers/esports | OAuth/OpenID + arquivo/API key | should | M |
| **Proof-of-Membership on-chain (SBT / NFT de carteirinha)** | Emite carteirinha como SBT/NFT (espelha passport §11 on-chain) | Carteirinha como SBT; acesso a parceiros que verificam o SBT; selo "Fundador" on-chain; interoperabilidade Web3 | gamers/esports, creators, times, clubes de carro | API key + wallet | could | L |
| **Colecionáveis digitais / NFT Drops** | Cria/distribui colecionáveis (thirdweb/Crossmint) com mint gasless ou claim por e-mail | Drop colecionável do tier; edição limitada (Founding); colecionável de momento (gol/set); prova de antiguidade | gamers/esports, creators, times, baladas, clubes de carro | API key | could | M |
| **Gleam / SweepWidget (engajamento/viralização)** | Campanhas de tarefas (seguir, compartilhar, indicar) que dão entradas/pontos | Pontos por tarefa; entradas extras em giveaway; perk por trilha; ranking de indicações; acesso antecipado por engajamento | creators, gamers/esports, baladas, times | API key + webhook | could | S |
| **Selos & Badges verificáveis (Open Badges / VC)** | Emite conquistas do Hall of Fame como badges portáveis verificáveis | Badge "Fundador"/"1 ano de casa"/"10 eventos"; credencial no LinkedIn; perk por conjunto de badges; badge de associado | empresas, creators, gamers/esports, clubes de carro | API key / nativo | could | M |
| **Reward Fulfillment (gift cards & vouchers)** | Agregador (Tremendous/YouGotaGift/rede BR) entrega recompensas resgatáveis por pontos | Resgate de pontos por gift card; voucher de parceiro; prêmio de sorteio digital; recompensa de indicação | empresas, creators, gamers/esports, baladas, times | API key | could | M |
| **Dotz** | Programa de pontos BR de massa: credita Dotz ou aceita como prova de relacionamento | Cashback em Dotz por renovação; Dotz como brinde; resgate de Dotz por ingresso/produto; bônus por indicação | empresas, times, clubes de carro, baladas | API key / OAuth | could | L |
| **Livelo** | Maior coalizão de pontos BR (Bradesco/BB): acúmulo/transferência como perk premium | Acúmulo Livelo por tier premium; transferência bonificada; resgate de experiências; bônus de boas-vindas | empresas, times, clubes de carro | API key / OAuth | could | L |
| **Mercado Livre / Mercado Pago Pontos (Meli+)** | Pontos/benefícios do ecossistema MP/Meli+ como recompensa | Pontos MP por renovação; cashback Meli; benefício Meli+ exclusivo; crédito de boas-vindas | empresas, creators, times, baladas | OAuth / API key | could | L |

#### 85.2.12 Esporte & Torcida

| Integração | O que faz | Perks que destrava | Verticais | Auth | Prio | Esforço |
|---|---|---|---|---|---|---|
| **Sócio-Torcedor / Programa de Sócio (genérico via API/CSV)** | Conecta plataforma de sócio existente (Avanti, Fiel Torcedor, Meu Timão, etc.); cruza base por CPF/e-mail; niche_verify genérico com fallback CSV | Carteirinha unificada no Wallet; cargo/canal só p/ sócio adimplente; grupo WhatsApp do tier; preço de membro em ingressos; badge "Sócio desde [ano]"; desconto na loja | times, empresas | API key / arquivo | must | L |
| **Controle de acesso a estádio / catraca** | Integra catracas (Hikvision, ControlID, Topdata, Madis) ou gate da bilheteria; QR Stanbase abre catraca, check-in volta como evento | Entrada pela carteirinha no Wallet; setor/cadeira exclusiva do tier; fila prioritária; presença credita Hall of Fame; lounge de sócio Patrono | times, baladas, empresas | API key / webhook | must | L |
| **Bilheteria oficial do clube** | Integra bilheteria (Futebol Card, Eleven Tickets, própria); estende event_import com preço/lote de sócio; ingresso vira pass | Lote/preço de membro; acesso antecipado à venda; ingresso no Wallet com QR; cadeira garantida por categoria; meia/taxa zerada | times, empresas | API key / webhook | must | L |
| **Carteirinha digital de sócio no Wallet** | Variante "sócio" do passport (§08, §11): emite/atualiza carteirinha com categoria, tempo de casa e QR | Carteirinha no celular; QR p/ catraca e parceiros; selo "sócio desde [ano]"; atualização automática de categoria | times, empresas, clubes de carro | OAuth | must | S |
| **API de futebol / placar ao vivo (API-Football/SofaScore/Opta)** | Chave global da Stanbase; org escolhe time/competição; eventos de jogo viram gatilhos de perk | Drop/cupom automático na vitória; conteúdo pós-jogo liberado no apito; jogo da rodada empurrado; narração ao vivo só p/ membros; badge sazonal | times, gamers/esports | API key | should | M |
| **Parceiros e clube de vantagens do time** | Rede de patrocinadores/cashback; usa a rota pública de validação (§09) como prova no balcão, sem integração do parceiro | Carteira de descontos no Wallet; cupom/cashback de patrocinador por tier; voucher de parceiro; ranking de uso; experiências de patrocinador | times, empresas, baladas, clubes de carro | API key / webhook | should | M |
| **Esports / ligas competitivas (Riot/Steam/FACEIT/torneios)** | Para clubes com braço de esports: reusa niche_verify Steam/Riot e adiciona FACEIT/torneios | Cargo validado por rank; vaga em scrim/hub privado; skin/role validada; watch party com o time; ranking de horas | gamers/esports, times, creators | OAuth / API key | should | M |
| **Estatísticas e mídia social do clube/atletas** | Conecta canais oficiais (YouTube/Instagram/X) para gated content e sinal de superfã | Bastidores/entrevistas gated; live de coletiva/treino só p/ membros; selo "torcedor engajado"; acesso antecipado a anúncios | times, creators, gamers/esports | OAuth | should | M |
| **Cartola FC / Fantasy do clube** | Integra fantasy (Cartola/ligas próprias); valida participação e importa pontuação (endpoints não oficiais, exploratório) | Liga privada do tier; cargo "Cartoleiro Mito"; ranking no Hall of Fame; premiação mensal ao líder; dicas só p/ membros | times, gamers/esports, creators | OAuth / API key | could | M |
| **Federações / ligas (CBF, federações, NBB, LBF)** | Dados de federação (tabela, súmulas, filiados); APIs raras → import por arquivo/scraping autorizado | Perk para atleta federado verificado; agenda oficial; conteúdo oficial gated; credencial de associado validada | times, empresas, gamers/esports | API key / arquivo | could | L |

#### 85.2.13 Empresas & Produtividade

| Integração | O que faz | Perks que destrava | Verticais | Auth | Prio | Esforço |
|---|---|---|---|---|---|---|
| **Zapier / Make / n8n (automação corporativa)** | Triggers/actions para o stack do dono provisionar perks em qualquer ferramenta não listada (§22) | Perk custom via automação; adicionar membro premium a sistema interno; boas-vindas multi-app; conceder/revogar acesso a SaaS | empresas, creators, gamers/esports, times | API key | must | S |
| **Slack (Connect + canais)** | Workspace da org: provisiona/desprovisiona em canais, user groups e Slack Connect por tier | Canal privado do tier; user group/@-menção; canal Slack Connect com parceiros; AMA com liderança; remoção ao sair | empresas, creators, gamers/esports | OAuth | must | M |
| **SSO / SAML & OIDC (entrada B2B)** | Login federado: membro de empresa parceira ganha tier por claim; SCIM para deprovision | Tier automático ao logar com IdP; tier por claim/grupo SAML; onboarding sem cadastro; conteúdo por domínio; deprovision automático | empresas, times, gamers/esports | OAuth | should | L |
| **Microsoft 365 / Teams (Entra ID)** | Microsoft Graph: provisiona em grupos, Teams e canais; libera SSO corporativo | Team/canal exclusivo; grupo M365; reunião/live event; SSO; site SharePoint; remoção ao sair | empresas, times | OAuth | should | L |
| **Google Workspace (Grupos + Drive)** | Admin SDK: associação em Google Groups e compartilhamento de Drive por tier | Entrada em Group; pasta/Shared Drive; Calendar de eventos; documento colaborativo; revogação ao sair | empresas, creators, clubes de carro | OAuth | should | M |
| **Clube de Vantagens Corporativo (TotalPass/Wellhub/iFood Benefícios)** | Catálogo de vantagens/cupons de parceiros liberado como perk do tier | Cupom/voucher de parceiro; código único anti-fraude; clube completo só p/ premium; Gympass como perk; revogação ao sair | empresas, times, clubes de carro, creators | API key | should | M |
| **Associações / Gestão de sócios (conselhos, sindicatos)** | Valida adimplência/regularidade do sócio e libera carteirinha, voto e benefícios | Carteirinha no Wallet; direito a voto a adimplentes; validação pública "sócio regular"; convênios por categoria; bloqueio ao ficar inadimplente; tempo de associação no Hall | empresas, clubes de carro, times | API key | should | M |
| **RH / Benefícios & Folha (Gupy, Sólides, TOTVS RH, Senior)** | Sincroniza colaboradores e atribui/remove tier por vínculo/cargo/setor (webhook ou CSV) | Colaborador ativo → tier base; tier por cargo/setor; membership no pacote de RH; desligamento remove perks; tempo de casa → badge | empresas | API key | could | M |
| **Intranet / Wiki corporativa (Notion, Confluence, SharePoint)** | Libera espaços/páginas/bases de conhecimento por tier | Wiki exclusivo do tier; diretório interno; convite a workspace como guest; documentos restritos; remoção ao sair | empresas, creators | OAuth | could | M |
| **Calendário corporativo & Agendamento (Calendly, Cal.com, Google/Outlook)** | Convida a eventos exclusivos e libera links de agendamento de mentoria/atendimento por tier | Convite a eventos/lives; link de mentoria 1:1; slot VIP prioritário; ICS do evento; sala recorrente do tier | empresas, creators, gamers/esports | OAuth | could | S |
| **CRM / Sales B2B (Salesforce, Pipedrive)** | Sincroniza tier/atributos com o CRM comercial para alinhar relacionamento e vendas | Tier vira propriedade no CRM; segmento de premium para campanhas; CS notificado em upgrade; condição comercial por tier | empresas, creators | OAuth | could | M |
| **Assinatura eletrônica & Documentos (Clicksign, ZapSign, D4Sign, DocuSign)** | Dispara/acompanha assinatura de termos/contratos como pré-requisito ou perk | Tier ativado pós-assinatura (gating); certificado de membro assinado; NDA destrava confidencial; contrato de embaixador; status na timeline | empresas, creators, clubes de carro | API key | could | M |

> Nota: **HubSpot/RD Station/Webhooks de saída/Microsoft Teams login** acima sobrepõem-se a Marketing & CRM (85.2.9) e Automação (85.2.10) — mantidos aqui na faceta de **provisionamento corporativo** (acesso a canais/grupos/SaaS), lá na faceta de **dados/marketing**.

#### 85.2.14 Analytics, Dados & Acesso Físico

| Integração | O que faz | Perks que destrava | Verticais | Auth | Prio | Esforço |
|---|---|---|---|---|---|---|
| **Google Analytics 4 (GA4)** | Envia eventos de membership (signup, upgrade, perk, churn) e cria audiências (Measurement Protocol) | Funil de conversão por tier no admin; audiência "prestes a dar churn"; conteúdo recomendado por comportamento; retenção por perk | todas | API key | must | S |
| **Meta Pixel + Conversions API (CAPI)** | Eventos server-side de conversão para otimizar/mensurar anúncios (pós-iOS14) | Audiência look-alike; retargeting de visitantes de planos; atribuição por anúncio; exclusão de membros ativos | creators, baladas, clubes de carro, times, empresas | API key | must | M |
| **QR Code de entrada / Validação na portaria** | Gera QR dinâmico na carteirinha e valida via app scanner, conferindo tier em tempo real (baixo hardware) | Fila/lista exclusiva na porta; carteirinha com QR que comprova tier; check-in de uso único; lote validado na entrada | baladas, times, clubes de carro, creators, empresas | OAuth | must | M |
| **Webhook genérico / Zapier / Make (analytics)** | Dispara eventos de entitlement para qualquer endpoint/automação no-code | Perk custom via no-code; sync com sistema legado; transacional ao provisionar; registro em planilha/Notion/Airtable | todas | webhook | must | S |
| **Mixpanel** | Behavioral analytics: retenção/coortes por tier | Coortes de retenção; perk surpresa para mais engajados; segmento de inatividade p/ win-back; adoption de cada perk | creators, gamers/esports, empresas | API key | should | M |
| **TikTok Pixel + Events API** | Eventos de assinatura/upgrade para otimizar anúncios e audiências (canal jovem) | Look-alike de membros; retargeting de planos; atribuição por campanha TikTok; exclusão de ativos | creators, baladas, gamers/esports | API key | should | M |
| **Segment / RudderStack (CDP)** | Camada de roteamento: 1 connector alimenta GA4, Meta, Mixpanel, CRM (self-host p/ LGPD) | Hub que destrava analytics/CRM downstream; perfil unificado web/app/físico; identity resolution (email/telefone/NFC) | empresas, creators, times, baladas | API key | should | L |
| **Export de dados / BI (CSV, Sheets, BigQuery, Looker Studio)** | Exporta membros/transações/uso de perks para planilha/warehouse/dashboard | Dashboard de MRR e churn por tier; relatório de uso por perk; export p/ reconciliação contábil; audiência p/ e-mail/CRM | empresas, times, creators, clubes de carro | OAuth | should | M |
| **Catraca / Turnstile (Topdata, Control iD, Henry, Madis)** | Libera/bloqueia catracas por tier ativo, sincronizando entitlement com o controlador físico | Acesso na catraca da sede/arena só p/ pagos; entrada VIP; academia/lounge do sócio; deprovision na catraca ao cancelar | times, empresas, clubes de carro, baladas | API key | should | L |
| **Plataforma de ticketing físico (Sympla, Eventbrite)** | Sincroniza membros com eventos e libera lotes/ingressos de tier, com check-in unificado | Lote/código de ingresso de membro; ingresso para tier alto; lista credenciada na portaria; fila VIP/early access | creators, baladas, times, clubes de carro | OAuth | should | M |
| **Amplitude** | Behavioral cohorts e jornada para entender o path-to-upgrade | Cohort "pronto para upgrade"; mapa free→premium; alerta de queda de engajamento; recomendação de perk | creators, empresas, gamers/esports | API key | could | M |
| **PostHog (analytics + feature flags)** | Product analytics, session replay e flags self-host (LGPD) para experimentar perks | A/B test de pacotes de perks; session replay do checkout; rollout gradual de perk; coorte para perk surpresa | creators, empresas, gamers/esports | API key | could | M |
| **Pulseira/Cartão NFC e RFID (cashless)** | Vincula tag NFC ao membro para identificação, cashless e validação de tier em eventos | Pulseira de tier que libera VIP; cashless com desconto de tier; credencial física na portaria; fast-lane | baladas, times, clubes de carro, creators | API key | could | L |
| **Geofencing / Check-in por localização** | Detecta presença num raio geográfico (sede/estádio/encontro) para perks de presença | Badge de presença por comparecer; perk só resgatável no raio (drop geolocalizado); pontos por check-in físico; cupom no local | clubes de carro, times, baladas, creators | OAuth | could | M |
| **Biometria facial de acesso** | Reconhecimento facial cadastrado libera acesso físico sem cartão, validando tier | Entrada sem fila por face (premium); acesso a camarote/VIP; check-in invisível; revogação do rosto ao sair | baladas, times, empresas | API key | could | L |

---

### 85.3 Ondas de implementação

> Priorização cruzando **valor × esforço × dependência do MVP**. A regra: a Onda 1 entrega o "coração" de cada vertical e os connectors âncora; a Onda 2 amplia cobertura e diferenciação; a Onda 3 é exploratória/sob-demanda. Tudo abaixo entra pelo mesmo molde de connector + perk-type — as ondas são sequência de **priorização**, não de re-arquitetura.

#### Onda 1 — `must` (alto valor, logo após o MVP)

Connectors âncora e os perks que definem cada vertical. Vários já nascem no MVP (§14, §15, §19) e aqui se consolidam.

- **Comunidade:** Discord, Telegram, WhatsApp (Cloud API oficial). — São o "lugar onde a comunidade vive"; o cargo/grupo por tier é o perk mais demandado e o coração das verticais gamer/creator/torcida.
- **Conteúdo:** Conteúdo Gated nativo (Stanbase-hosted), Twitch, YouTube. — Gating é fundação (§14); Twitch/YouTube cobrem creators e esports, a maior fonte de demanda.
- **Eventos:** Sympla, Ingresse, Guest List & RSVP nativo, Scanner de check-in nativo, RSVP da área de membro. — Importação dos dois maiores players BR + a portaria nativa que consome todo ticketing + os módulos nativos de baixo esforço/altíssimo engajamento.
- **Pagamentos:** Pix Automático, Antecipação de Recebíveis, Régua de Cobrança/dunning. — Margem (recorrência sem MDR + spread de antecipação) e proteção do MRR; já são alavancas estratégicas do modelo.
- **Identidade:** Google Sign-In, Apple Sign-In, Discord Login, Telefone + OTP. — Onboarding sem fricção; Apple é obrigatório em iOS; OTP é a chave dos perks de WhatsApp no BR.
- **Commerce:** Shopify, Nuvemshop. — Líder global + líder BR; cupom/preço de membro é perk universal de quase todas as verticais.
- **Comunicação:** Resend, Amazon SES, Web Push (VAPID), WhatsApp Cloud API. — Canais de notificação que tornam todo perk "perceptível"; baratos/inclusos na comissão.
- **Marketing/CRM:** RD Station, HubSpot, Meta Ads (CAPI), Pixels & Tags (GTM/GA4), UTM tracking, Programa de afiliados/indicação. — Aquisição e loop de crescimento nativo; sem pixels/UTM não existe atribuição que destrava perks de campanha.
- **Automação:** Zapier, Webhooks de saída, API REST pública + OpenAPI, SDK JS/React + Embeds. — A espinha dorsal e o "não vê sua ferramenta? a gente conecta" para a cauda longa.
- **Loyalty:** Pontos & Cashback nativo (Points Engine). — Motor interno em que os connectors de loyalty externos plugam; alavanca de retenção/LTV.
- **Esporte & Torcida:** Sócio-Torcedor genérico (API/CSV), Controle de acesso a estádio/catraca, Bilheteria oficial do clube, Carteirinha digital de sócio no Wallet. — O coração da vertical torcida; a carteirinha de sócio é o perk âncora visível.
- **Empresas:** Zapier/Make/n8n corporativo, Slack (Connect + canais). — Connector universal B2B + o canal corporativo padrão.
- **Analytics/Físico:** GA4, Meta Pixel/CAPI, QR de portaria, Webhook genérico. — Medição base + portaria de baixo hardware/alto valor para nightlife e eventos.

#### Onda 2 — `should` (amplia cobertura e diferencia)

Segundos players de cada categoria, connectors BR-first complementares e perks de diferenciação.

- **Gaming:** Faceit, Start.gg, Gamers Club, Garena (Free Fire), Generic Game Account Verifier. — Cobrem CS competitivo (Faceit/Gamers Club), FGC (Start.gg) e a base mobile gigante BR (Free Fire); o verifier genérico cobre a cauda longa de jogos sem API.
- **Conteúdo:** Kick, Vimeo, TikTok, Instagram, Podcast/RSS Gated. — Creators que migraram para Kick; gating robusto (Vimeo domain-privacy); validação de follow; membership de podcast.
- **Comunidade:** Slack, Circle.so, Discourse/Fórum, WhatsApp via BSP. — Cobrem B2B, creators com comunidade montada, fóruns de clubes/associações e quem já opera via BSP.
- **Eventos:** Eventbrite, Shotgun, Eventim, Zoom/YouTube Live/Twitch (acesso online), Webhook genérico de ticketing. — Internacional/corporativo, nightlife global, sócio-torcedor de arena, eventos híbridos e a rede de segurança universal.
- **Pagamentos:** Mercado Pago, Stripe, Boleto, eNotas, Carteira & Cashback, Apple/Google Pay. — Rota internacional, PJ/associação, nota fiscal e conversão mobile.
- **Identidade:** Gov.br, Validação de CPF, Age Gate, Magic Link, KYC, Steam OpenID Login. — Confiança/regulação BR, anti-multiconta, idade (balada), KYC para alto valor.
- **Commerce:** Catálogo nativo de Drops, Yampi, WooCommerce, Printful. — Loja interna para quem não tem e-commerce + checkouts BR + POD para drops físicos sem estoque.
- **Comunicação:** SendGrid, Mailgun, OneSignal, Zenvia, Twilio. — Alternativas enterprise de e-mail/push + mensageria BR e global.
- **Marketing/CRM:** Mailchimp, ActiveCampaign, Customer.io, Google Ads, WhatsApp Marketing BSP. — Automação comportamental e fechamento do loop de aquisição.
- **Automação:** Make, n8n, Webhooks de entrada, MCP Server, Google Sheets. — No-code popular no BR, automação reversa, IA-first e a planilha do dono não técnico.
- **Loyalty:** POAP, Token-Gating, Wallet Connect, Sorteios/Giveaways, Recompensas Steam/Riot. — Engajamento de presença, gating web3 e premiação.
- **Esporte:** API de futebol/placar, Clube de vantagens do time, Esports/ligas competitivas, Mídia social do clube. — Gatilhos de jogo, benefícios de patrocinador e a ponte torcida↔esports.
- **Empresas:** SSO/SAML/OIDC, Microsoft 365/Teams, Google Workspace, Clube de Vantagens Corporativo, Gestão de sócios/associações. — Entrada B2B federada e provisionamento corporativo.
- **Analytics/Físico:** Mixpanel, TikTok Pixel, Segment/RudderStack, Export BI, Catraca/Turnstile, Ticketing físico. — Analytics de produto, CDP e acesso físico em sede/arena.

#### Onda 3 — `could` / exploratório (sob demanda)

Plataformas nichadas, dependentes de parceria comercial, de API instável, ou que esperam um pré-requisito (app nativo, demanda real).

- **Gaming:** Xbox/PSN, Battle.net, Epic/Fortnite, Challengermode. — APIs restritas/sem API oficial estável ou nicho menor no BR.
- **Conteúdo:** Spotify, Apple Music, Importação Patreon, Mux/Cloudflare Stream, Substack. — Sem paywall nativo robusto, migração one-shot ou decisão buy-vs-build pós-MVP.
- **Comunidade:** Reddit, Guilded, Matrix, Mighty Networks, Facebook Groups. — Volume menor no BR ou Graph API restrita.
- **Eventos:** Hotmart/Kiwify, Meetup, Google/Apple Calendar (ICS). — Nichos recorrentes e conveniência de calendário.
- **Pagamentos:** PayPal, PicPay, Cartão internacional, NFe.io, Cripto/Stablecoin. — Métodos adicionais e web3 de nicho com cautela de compliance.
- **Identidade:** Facebook/Meta Login, X/Twitter Login, Riot/Epic/Xbox/PSN account link, Passkeys. — Login secundário, gating social leve e segurança avançada exploratória.
- **Commerce:** Loja Integrada, Printify, Cartpanda, Spreadshirt/Spring, Cuponomia, Mercado Livre/Shops, Amazon afiliado. — Cauda longa de lojas e curadoria de afiliados.
- **Comunicação:** Postmark, FCM, APNs marketing, RCS, Telegram Bot. — Premium de deliverability e canais que esperam app nativo ou agente verificado.
- **Marketing/CRM:** TikTok Ads, Brevo, Segment/RudderStack. — Canais e CDP para orgs avançadas.
- **Automação:** Notion, Airtable, Pipedream, CLI/SDKs servidor, Bot framework chatops. — Sobreposição com Sheets ou público dev menor.
- **Loyalty:** SBT on-chain, NFT Drops, Gleam/SweepWidget, Open Badges, Reward Fulfillment, Dotz, Livelo, Meli+ Pontos. — Web3 com barreira de gas/UX e programas de pontos que exigem parceria comercial pesada.
- **Esporte:** Cartola FC/Fantasy, Federações/ligas. — APIs não oficiais/raras; exploratório.
- **Empresas:** RH/Folha, Intranet/Wiki, Calendário/Agendamento, CRM/Sales B2B, Assinatura eletrônica. — Fragmentação de APIs de RH e sobreposição com módulos nativos.
- **Analytics/Físico:** Amplitude, PostHog, NFC/RFID cashless, Geofencing, Biometria facial. — Sobreposição com Mixpanel ou alto atrito de hardware/LGPD (biometria sensível).

---

### 85.4 Nota de extensibilidade — por que este é um backlog vivo

O valor estratégico deste catálogo não é a lista em si, mas o fato de ele ser **acionável sem refatorar a plataforma**. Cada item — dos 13 da Onda 1 até o último exploratório da Onda 3 — entra pelo **mesmo molde** descrito em 85.1:

- **Sem novo domínio, sem novo deploy por org.** Registrar um connector é uma linha em `connectors` + código de um adapter que implementa os hooks `grant`/`revoke` e (se aplicável) `verifyWebhook`/`reconcile`. O framework (§19) já fornece Connection cifrada por org, Mapping configurável, fila (pgmq), jobs (pg_cron), webhooks in/out e observabilidade. Nada disso é reescrito por integração.
- **O perk-type é a unidade de reuso.** Padrões recorrentes — "cargo/canal por tier" (channel_sync), "validar atributo de conta" (niche_verify), "liberar conteúdo" (content_access), "cupom/desconto de loja" (commerce), "drop físico" (drop_fulfillment), "distribuição de código" — são perk-types genéricos. Um novo provider quase sempre **reaproveita um perk-type existente** (ex.: Guilded reusa ~90% da engine de cargos do Discord; Printify reusa o `drop_fulfillment` do Printful; Token-Gating reusa o `niche_verify` de leitura de atributo). O custo marginal de cada novo connector cai à medida que a biblioteca de perk-types cresce.
- **Self-service do lado do dono é automático.** Como o connector declara seu config-schema e capabilities, a UI do catálogo, as telas de mapeamento e o form do perk são **renderizados a partir do schema** — o dono conecta e arrasta o perk sem que a Stanbase escreva tela específica.
- **A cauda longa tem rede de segurança.** Para tudo que ainda não tem connector dedicado, os fallbacks universais já estão na Onda 1/2: **Webhooks (in/out)**, **API pública + OpenAPI**, **Zapier/Make/n8n**, e os verifiers genéricos (Generic Game Account Verifier, Webhook genérico de ticketing). Isso sustenta a postura de produto "não vê sua ferramenta? a gente conecta pra você" sem prometer um connector nativo para cada caso.
- **Priorização é re-ordenável, não re-arquitetável.** Promover um item da Onda 3 para a Onda 1 (porque um cliente grande pediu) é uma decisão de **roadmap**, não de engenharia de plataforma. O catálogo pode crescer indefinidamente — novos jogos, novas lojas, novos PSPs, novos canais — e cada adição é incremental e isolada.

Em resumo: o modelo plugável transforma "integrações" de um custo linear (cada uma um projeto) em um **backlog priorizável** onde a plataforma já pagou o custo fixo do encanamento. Este documento é, portanto, vivo: itens entram, sobem de onda e são entregues conforme demanda, sempre pelo mesmo caminho.
