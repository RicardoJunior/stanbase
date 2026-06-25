/**
 * Perk-type catalog (§12.2 "modelo plugável"). Each perk type declares the
 * integration it needs (if any), a short config schema (→ admin form), and
 * whether it's revocable (Q57). Adding an integration = registering a connector
 * + perk type here → appears for every org.
 */
import type { PerkType } from "@/types/domain";

export const PERK_CATALOG: PerkType[] = [
  {
    key: "exclusive_content",
    label: "Conteúdo exclusivo",
    integration: "youtube",
    description: "VOD, live fechada ou bastidores liberados por tier.",
    configSchema: [
      { key: "title", label: "Título", type: "text" },
      { key: "provider", label: "Provedor", type: "select", options: ["YouTube", "Twitch", "Vimeo"] },
      { key: "url", label: "URL/Playlist", type: "url" },
    ],
    isRevocable: false,
  },
  {
    key: "event_access",
    label: "Acesso a evento",
    integration: null,
    description: "Lote de membro, acesso antecipado ou ingresso incluso.",
    configSchema: [
      { key: "kind", label: "Tipo", type: "select", options: ["Lote de membro", "Acesso antecipado", "Ingresso incluso"] },
    ],
    isRevocable: true,
  },
  {
    key: "discord_role",
    label: "Cargo no Discord",
    integration: "discord",
    description: "Atribui/remove um cargo no servidor por tier.",
    configSchema: [{ key: "role", label: "Nome do cargo", type: "text" }],
    isRevocable: true,
  },
  {
    key: "telegram_group",
    label: "Grupo no Telegram",
    integration: "telegram",
    description: "Entrada em grupo fechado por tier.",
    configSchema: [{ key: "group", label: "Nome do grupo", type: "text" }],
    isRevocable: true,
  },
  {
    key: "whatsapp_group",
    label: "Comunidade no WhatsApp",
    integration: "whatsapp",
    description: "Grupo/comunidade no WhatsApp (API oficial).",
    configSchema: [{ key: "group", label: "Nome da comunidade", type: "text" }],
    isRevocable: true,
  },
  {
    key: "discount",
    label: "Desconto",
    integration: null,
    description: "Desconto na loja oficial ou em parceiros.",
    configSchema: [
      { key: "label", label: "Descrição", type: "text" },
      { key: "percent", label: "Percentual (%)", type: "number" },
    ],
    isRevocable: false,
  },
  {
    key: "drop",
    label: "Brinde / Drop",
    integration: null,
    description: "Brinde físico ou digital concedido ao membro.",
    configSchema: [{ key: "item", label: "Item", type: "text" }],
    isRevocable: false,
  },
  {
    key: "recognition",
    label: "Reconhecimento",
    integration: null,
    description: "Badge ou posição no Hall of Fame.",
    configSchema: [{ key: "badge", label: "Badge", type: "text" }],
    isRevocable: true,
  },
  {
    key: "custom",
    label: "Custom",
    integration: null,
    description: "Benefício definido pela org com regra própria.",
    configSchema: [{ key: "label", label: "Descrição", type: "text" }],
    isRevocable: true,
  },
];

export const perkType = (key: string): PerkType | undefined =>
  PERK_CATALOG.find((p) => p.key === key);
