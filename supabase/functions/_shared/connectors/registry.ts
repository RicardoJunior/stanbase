// Adapter registry — single lookup the framework uses to resolve a provider to
// its real implementation. Adding an integration = drop a `<provider>.ts` file
// and register it here. Login providers (email/phone/google/apple/x/facebook)
// are NOT here: login is Supabase Auth, configured at the platform level.
import type { ProviderAdapter } from "./types.ts";

import { asaasAdapter } from "./asaas.ts";
import { discordAdapter } from "./discord.ts";
import { telegramAdapter } from "./telegram.ts";
import { whatsappAdapter } from "./whatsapp.ts";
import { youtubeAdapter } from "./youtube.ts";
import { twitchAdapter } from "./twitch.ts";
import { spotifyAdapter } from "./spotify.ts";
import { vimeoAdapter } from "./vimeo.ts";
import { symplaAdapter } from "./sympla.ts";
import { ingresseAdapter } from "./ingresse.ts";
import { steamAdapter } from "./steam.ts";
import { riotAdapter } from "./riot.ts";
import { mailchimpAdapter } from "./mailchimp.ts";
import { zapierAdapter } from "./zapier.ts";
import { webhooksAdapter } from "./webhooks.ts";

const ADAPTERS: ProviderAdapter[] = [
  asaasAdapter,
  discordAdapter,
  telegramAdapter,
  whatsappAdapter,
  youtubeAdapter,
  twitchAdapter,
  spotifyAdapter,
  vimeoAdapter,
  symplaAdapter,
  ingresseAdapter,
  steamAdapter,
  riotAdapter,
  mailchimpAdapter,
  zapierAdapter,
  webhooksAdapter,
];

const BY_PROVIDER = new Map<string, ProviderAdapter>(ADAPTERS.map((a) => [a.provider, a]));

export const getAdapter = (provider: string): ProviderAdapter | undefined => BY_PROVIDER.get(provider);

export const requireAdapter = (provider: string): ProviderAdapter => {
  const a = BY_PROVIDER.get(provider);
  if (!a) throw new Error(`Provider sem adapter: ${provider}`);
  return a;
};

export const allAdapters = (): ProviderAdapter[] => ADAPTERS;
