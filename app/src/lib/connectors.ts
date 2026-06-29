/**
 * Connector catalog (§20.1) — the global, standardized definition of each
 * provider. Each connector declares its REAL auth model and the actual
 * credential fields its API requires, so the connect form matches the provider
 * (Discord ≠ WhatsApp ≠ Sympla). Sources verified against each provider's docs.
 *
 * v0: credentials are collected and the connection is marked connected (secrets
 * are masked, not stored in clear). REPLAN: the real OAuth code exchange / API
 * verification call + encrypted secret storage happen server-side (Edge Function).
 */
import type { PerkTypeKey } from "@/types/domain";

export type ConnectorCategory =
  | "payments"
  | "content"
  | "events"
  | "communication"
  | "identity"
  | "niche"
  | "channels"
  | "automation";

export type AuthKind = "oauth" | "api_key" | "bot" | "manual";

export interface CredentialField {
  key: string;
  label: string;
  type: "text" | "secret" | "url" | "select" | "textarea";
  required?: boolean;
  placeholder?: string;
  help?: string; // short hint: where to find it
  options?: string[];
}

export interface ConnectorAuth {
  kind: AuthKind;
  /** OAuth: scopes requested at the consent screen. */
  scopes?: string[];
  /** where the org sets up the app / gets the credentials. */
  docsUrl?: string;
  /** one-line description of the flow. */
  note?: string;
  /** credential fields the org provides (besides the OAuth consent, if any). */
  fields: CredentialField[];
}

export interface Connector {
  provider: string;
  label: string;
  category: ConnectorCategory;
  blurb: string;
  perkTypes: PerkTypeKey[];
  resourceLabel?: string; // label for tier→resource mapping
  auth: ConnectorAuth;
}

/** OAuth callback the org whitelists in the provider's app (display-only). */
export const oauthCallback = (provider: string) =>
  `https://api.stanbase.com/v1/integrations/${provider}/callback`;

export const CONNECTOR_CATEGORIES: { key: ConnectorCategory; label: string }[] = [
  { key: "payments", label: "Pagamentos" },
  { key: "channels", label: "Canais & comunidade" },
  { key: "content", label: "Conteúdo" },
  { key: "events", label: "Eventos" },
  { key: "communication", label: "Comunicação" },
  { key: "niche", label: "Perks de nicho" },
  { key: "identity", label: "Identidade" },
  { key: "automation", label: "Automação & API" },
];

export const CONNECTORS: Connector[] = [
  // ── pagamentos (PSP de lançamento) ──────────────────────────────
  {
    provider: "asaas",
    label: "Asaas",
    category: "payments",
    blurb: "Pix e cartão com split nativo via subcontas. PSP do checkout.",
    perkTypes: [],
    auth: {
      kind: "api_key",
      docsUrl: "https://docs.asaas.com",
      note: "O Asaas processa o checkout (Pix/cartão) e faz o split automático da comissão via subcontas.",
      fields: [
        { key: "access_token", label: "API Key (access_token)", type: "secret", required: true, help: "Asaas → Integrações → API Key" },
        { key: "wallet_id", label: "Wallet ID (subconta p/ split)", type: "text", required: true, help: "ID da carteira que recebe o repasse da org" },
        { key: "environment", label: "Ambiente", type: "select", options: ["sandbox", "production"], required: true },
      ],
    },
  },
  // ── canais ──────────────────────────────────────────────────────
  {
    provider: "discord",
    label: "Discord",
    category: "channels",
    blurb: "Cargos automáticos por tier + verificação via bot.",
    perkTypes: ["discord_role"],
    resourceLabel: "Cargo (Role ID)",
    auth: {
      kind: "bot",
      docsUrl: "https://discord.com/developers/applications",
      scopes: ["bot", "identify", "guilds.join"],
      note: "Crie um app no Developer Portal, adicione um Bot com permissão “Gerenciar Cargos” e convide-o ao servidor.",
      fields: [
        { key: "bot_token", label: "Bot Token", type: "secret", required: true, help: "Aba Bot → Reset Token" },
        { key: "guild_id", label: "ID do servidor (Guild ID)", type: "text", required: true, placeholder: "123456789012345678", help: "Modo desenvolvedor → clique direito no servidor → Copiar ID" },
        { key: "client_id", label: "Client ID", type: "text", help: "Aba OAuth2 — usado na verificação do membro" },
        { key: "client_secret", label: "Client Secret", type: "secret", help: "Aba OAuth2" },
      ],
    },
  },
  {
    provider: "telegram",
    label: "Telegram",
    category: "channels",
    blurb: "Entrada/saída de grupos e canais por tier.",
    perkTypes: ["telegram_group"],
    resourceLabel: "Chat ID do grupo",
    auth: {
      kind: "bot",
      docsUrl: "https://t.me/BotFather",
      note: "Crie um bot com o @BotFather e adicione-o como administrador do grupo/canal.",
      fields: [
        { key: "bot_token", label: "Bot Token", type: "secret", required: true, placeholder: "123456:ABC-DEF...", help: "Mensagem do @BotFather após /newbot" },
      ],
    },
  },
  {
    provider: "whatsapp",
    label: "WhatsApp",
    category: "channels",
    blurb: "Grupos e mensagens via API oficial (Cloud API / BSP).",
    perkTypes: ["whatsapp_group"],
    resourceLabel: "Grupo/lista",
    auth: {
      kind: "api_key",
      docsUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api",
      note: "WhatsApp Cloud API (Meta). Requer um app Meta com o produto WhatsApp e um usuário do sistema.",
      fields: [
        { key: "phone_number_id", label: "Phone Number ID", type: "text", required: true, help: "WhatsApp → API Setup" },
        { key: "waba_id", label: "WhatsApp Business Account ID (WABA)", type: "text", required: true, help: "Configurações da conta do WhatsApp Business" },
        { key: "access_token", label: "Token de acesso permanente", type: "secret", required: true, help: "Token de usuário do sistema (não o temporário)" },
        { key: "app_secret", label: "App Secret", type: "secret", required: true, help: "Configurações do app Meta → Básico" },
        { key: "verify_token", label: "Webhook Verify Token", type: "text", help: "Você define este valor ao configurar o webhook" },
      ],
    },
  },
  // ── conteúdo ────────────────────────────────────────────────────
  {
    provider: "youtube",
    label: "YouTube",
    category: "content",
    blurb: "VODs, lives fechadas e memberships por tier.",
    perkTypes: ["exclusive_content"],
    resourceLabel: "Playlist/Channel ID",
    auth: {
      kind: "oauth",
      docsUrl: "https://console.cloud.google.com/apis/credentials",
      scopes: ["youtube.readonly", "youtube.force-ssl"],
      note: "Autorize a conta do canal com o Google. A Stanbase troca o código pelo token no servidor.",
      fields: [
        { key: "channel_id", label: "Channel ID (opcional)", type: "text", placeholder: "UC...", help: "Confirmado automaticamente após autorizar" },
      ],
    },
  },
  {
    provider: "twitch",
    label: "Twitch",
    category: "content",
    blurb: "Conteúdo subs-only e bastidores por tier.",
    perkTypes: ["exclusive_content"],
    resourceLabel: "Canal",
    auth: {
      kind: "oauth",
      docsUrl: "https://dev.twitch.tv/console/apps",
      scopes: ["channel:read:subscriptions", "moderator:read:followers"],
      note: "Autorize o canal (broadcaster) com a Twitch.",
      fields: [
        { key: "broadcaster", label: "Login do canal (opcional)", type: "text", placeholder: "auroraesports" },
      ],
    },
  },
  {
    provider: "spotify",
    label: "Spotify",
    category: "content",
    blurb: "Episódios e playlists exclusivos por tier (podcasts/creators).",
    perkTypes: ["exclusive_content"],
    resourceLabel: "Playlist/Show",
    auth: {
      kind: "oauth",
      docsUrl: "https://developer.spotify.com/dashboard",
      scopes: ["user-read-email", "playlist-read-private"],
      note: "Autorize o app do Spotify (OAuth 2.0).",
      fields: [
        { key: "client_id", label: "Client ID", type: "text", required: true },
        { key: "client_secret", label: "Client Secret", type: "secret", required: true },
      ],
    },
  },
  {
    provider: "vimeo",
    label: "Vimeo",
    category: "content",
    blurb: "Vídeos privados com acesso condicionado ao tier.",
    perkTypes: ["exclusive_content"],
    resourceLabel: "Pasta/álbum",
    auth: {
      kind: "api_key",
      docsUrl: "https://developer.vimeo.com/apps",
      scopes: ["private", "video_files"],
      note: "Gere um token pessoal (Personal Access Token) com escopo “private”.",
      fields: [
        { key: "access_token", label: "Access Token (pessoal)", type: "secret", required: true, help: "Sua app no developer.vimeo.com → Generate token" },
      ],
    },
  },
  // ── eventos ─────────────────────────────────────────────────────
  {
    provider: "sympla",
    label: "Sympla",
    category: "events",
    blurb: "Importar/sincronizar eventos e ingressos.",
    perkTypes: ["event_access"],
    resourceLabel: "Evento",
    auth: {
      kind: "api_key",
      docsUrl: "https://developers.sympla.com.br/api-doc/",
      note: "Token enviado no header s_token. Gere em Minha Conta → Integrações.",
      fields: [
        { key: "s_token", label: "API Token (s_token)", type: "secret", required: true, help: "Sympla → Minha Conta → Integrações → Criar chave de acesso" },
      ],
    },
  },
  {
    provider: "ingresse",
    label: "Ingresse",
    category: "events",
    blurb: "Lote de membro e acesso antecipado.",
    perkTypes: ["event_access"],
    resourceLabel: "Evento",
    auth: {
      kind: "api_key",
      docsUrl: "https://www.ingresse.com",
      note: "Autenticação HMAC: a chave pública identifica e a privada assina cada requisição.",
      fields: [
        { key: "public_key", label: "Public Key", type: "text", required: true },
        { key: "private_key", label: "Private Key", type: "secret", required: true, help: "Usada para assinar (HMAC) — nunca enviada na requisição" },
      ],
    },
  },
  // ── nicho ───────────────────────────────────────────────────────
  {
    provider: "steam",
    label: "Steam",
    category: "niche",
    blurb: "Conecta a conta de jogo do membro (Steam OpenID).",
    perkTypes: ["custom"],
    resourceLabel: "Recurso",
    auth: {
      kind: "api_key",
      docsUrl: "https://steamcommunity.com/dev/apikey",
      note: "Web API Key para ler dados; o membro vincula a conta via “Login com Steam” (OpenID).",
      fields: [
        { key: "web_api_key", label: "Steam Web API Key", type: "secret", required: true, help: "steamcommunity.com/dev/apikey" },
      ],
    },
  },
  {
    provider: "riot",
    label: "Riot Games",
    category: "niche",
    blurb: "Valida conta e rank do membro.",
    perkTypes: ["custom"],
    resourceLabel: "Recurso",
    auth: {
      kind: "api_key",
      docsUrl: "https://developer.riotgames.com",
      note: "API Key do Developer Portal. Vínculo de conta (RSO) requer aprovação da Riot.",
      fields: [
        { key: "api_key", label: "API Key (RGAPI-…)", type: "secret", required: true, help: "developer.riotgames.com → Dashboard" },
      ],
    },
  },
  // ── identidade (login social) ───────────────────────────────────
  {
    provider: "google",
    label: "Google",
    category: "identity",
    blurb: "Login social do membro (OAuth 2.0).",
    perkTypes: [],
    auth: {
      kind: "oauth",
      docsUrl: "https://console.cloud.google.com/apis/credentials",
      scopes: ["openid", "email", "profile"],
      note: "Crie credenciais OAuth no Google Cloud e cole o Client ID/Secret.",
      fields: [
        { key: "client_id", label: "Client ID", type: "text", required: true, placeholder: "…apps.googleusercontent.com" },
        { key: "client_secret", label: "Client Secret", type: "secret", required: true },
      ],
    },
  },
  {
    provider: "apple",
    label: "Apple",
    category: "identity",
    blurb: "Sign in with Apple.",
    perkTypes: [],
    auth: {
      kind: "oauth",
      docsUrl: "https://developer.apple.com/account/resources/identifiers",
      note: "Sign in with Apple usa um Services ID + chave privada (.p8).",
      fields: [
        { key: "services_id", label: "Services ID (client_id)", type: "text", required: true, placeholder: "com.suacomunidade.app" },
        { key: "team_id", label: "Team ID", type: "text", required: true },
        { key: "key_id", label: "Key ID", type: "text", required: true },
        { key: "private_key", label: "Chave privada (.p8)", type: "textarea", required: true, help: "Conteúdo do arquivo AuthKey_XXXX.p8" },
      ],
    },
  },
  {
    provider: "x",
    label: "X",
    category: "identity",
    blurb: "Login social + verificação de fã (OAuth 2.0).",
    perkTypes: [],
    auth: {
      kind: "oauth",
      docsUrl: "https://developer.x.com/en/portal/dashboard",
      scopes: ["users.read", "tweet.read"],
      note: "Crie um app no Developer Portal do X (OAuth 2.0).",
      fields: [
        { key: "client_id", label: "Client ID", type: "text", required: true },
        { key: "client_secret", label: "Client Secret", type: "secret", required: true },
      ],
    },
  },
  // ── comunicação ─────────────────────────────────────────────────
  {
    provider: "mailchimp",
    label: "Mailchimp",
    category: "communication",
    blurb: "Sincroniza membros e dispara campanhas de e-mail.",
    perkTypes: [],
    auth: {
      kind: "api_key",
      docsUrl: "https://mailchimp.com/developer/marketing/",
      note: "API Key + Audience (lista) para sincronizar contatos.",
      fields: [
        { key: "api_key", label: "API Key", type: "secret", required: true, help: "Account → Extras → API keys (inclui o data center, ex.: -us21)" },
        { key: "audience_id", label: "Audience ID", type: "text", required: true, help: "Audience → Settings → Unique id" },
      ],
    },
  },
  // ── automação & api ─────────────────────────────────────────────
  {
    provider: "zapier",
    label: "Zapier",
    category: "automation",
    blurb: "Liga a Stanbase a milhares de apps.",
    perkTypes: [],
    auth: {
      kind: "manual",
      docsUrl: "https://zapier.com/apps",
      note: "No Zapier, conecte o app Stanbase usando uma API Key gerada em Desenvolvedores.",
      fields: [
        { key: "api_key", label: "API Key Stanbase", type: "text", required: true, placeholder: "sk_live_…", help: "Gere em Desenvolvedores → API Keys e cole no Zapier" },
      ],
    },
  },
  {
    provider: "webhooks",
    label: "Webhooks",
    category: "automation",
    blurb: "Eventos de saída assinados (HMAC) para o seu backend.",
    perkTypes: [],
    auth: {
      kind: "manual",
      note: "Informe a URL que receberá os eventos. Cada entrega é assinada (HMAC-SHA256).",
      fields: [
        { key: "endpoint_url", label: "URL do endpoint", type: "url", required: true, placeholder: "https://seu-app.com/webhooks/stanbase" },
        { key: "events", label: "Eventos (separados por vírgula)", type: "text", placeholder: "member.created, subscription.payment_succeeded" },
      ],
    },
  },
];

export const getConnector = (provider: string): Connector | undefined =>
  CONNECTORS.find((c) => c.provider === provider);

/** Which connector powers a given perk type (if any). */
export const connectorForPerkType = (perkType: PerkTypeKey): Connector | undefined =>
  CONNECTORS.find((c) => c.perkTypes.includes(perkType));

/** Mask a secret value for storage/display (keep last 4). */
export const maskSecret = (v: string): string =>
  v.length <= 4 ? "••••" : "••••" + v.slice(-4);
