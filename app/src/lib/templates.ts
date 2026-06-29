/**
 * Vertical templates (§1 + Q35) — pre-fill the onboarding so a new owner can
 * "montar o membership em um dia". Each template suggests tiers, perks, brand
 * theme, custom attributes and integrations to connect.
 */
import type { OrgTheme, Period, PerkTypeKey } from "@/types/domain";

export interface TierTemplate {
  name: string;
  price: number;
  period: Period;
  color: string;
  capacity: number | null;
  perks: string[]; // perk names this tier grants (resolved to ids on create)
}

export interface PerkTemplate {
  type: PerkTypeKey;
  name: string;
  config: Record<string, string | number>;
}

export interface VerticalTemplate {
  key: string;
  label: string;
  blurb: string;
  vertical: string;
  logoText: string;
  tagline: string;
  theme: OrgTheme;
  tiers: TierTemplate[];
  perks: PerkTemplate[];
  attributes: string[];
  suggestedConnections: string[];
}

const art = (a: string, b: string) => `radial-gradient(130% 150% at 80% 0%, ${a} 0%, ${b} 58%)`;

export const TEMPLATES: VerticalTemplate[] = [
  {
    key: "esports",
    label: "Gamer / esports",
    blurb: "Fã · Membro · VIP · Founder",
    vertical: "esports",
    logoText: "minha line",
    tagline: "A nação do time, mais perto do que nunca.",
    theme: { primary: "#6d28d9", accent: "#b8965a", defaultMode: "dark", darkEnabled: true, memberCardArt: art("#2a1d52", "#15140f") },
    tiers: [
      { name: "Fã", price: 0, period: "monthly", color: "#5d584c", capacity: null, perks: ["Cargo Membro"] },
      { name: "Membro", price: 19, period: "monthly", color: "#6d28d9", capacity: null, perks: ["VOD dos campeonatos", "Grupo no Telegram", "10% na loja"] },
      { name: "VIP", price: 49, period: "monthly", color: "#b8965a", capacity: null, perks: ["Bastidores da line", "Cargo VIP"] },
      { name: "Founder", price: 600, period: "annual", color: "#e7d3a6", capacity: 100, perks: ["Camiseta oficial", "Meet & greet"] },
    ],
    perks: [
      { type: "discord_role", name: "Cargo Membro", config: { role: "Membro" } },
      { type: "discord_role", name: "Cargo VIP", config: { role: "VIP" } },
      { type: "exclusive_content", name: "VOD dos campeonatos", config: { title: "VODs", provider: "YouTube" } },
      { type: "exclusive_content", name: "Bastidores da line", config: { title: "Bastidores", provider: "Twitch" } },
      { type: "telegram_group", name: "Grupo no Telegram", config: { group: "Insiders" } },
      { type: "discount", name: "10% na loja", config: { label: "Loja oficial", percent: 10 } },
      { type: "drop", name: "Camiseta oficial", config: { item: "Jersey 2026" } },
      { type: "custom", name: "Meet & greet", config: { label: "Meet & greet" } },
    ],
    attributes: ["gamertag", "jogo_principal"],
    suggestedConnections: ["discord", "youtube", "telegram"],
  },
  {
    key: "car-club",
    label: "Clube de carro",
    blurb: "Visitante · Associado · Piloto · Fundador",
    vertical: "car-club",
    logoText: "meu clube",
    tagline: "A estrada é melhor entre os nossos.",
    theme: { primary: "#b91c1c", accent: "#b8965a", defaultMode: "dark", darkEnabled: true, memberCardArt: art("#3a1717", "#15140f") },
    tiers: [
      { name: "Visitante", price: 0, period: "monthly", color: "#5d584c", capacity: null, perks: ["Grupo no WhatsApp"] },
      { name: "Associado", price: 29, period: "monthly", color: "#b91c1c", capacity: null, perks: ["Adesivo do clube", "15% em parceiros"] },
      { name: "Piloto", price: 79, period: "monthly", color: "#b8965a", capacity: null, perks: ["Track days exclusivos", "Cargo no Discord"] },
      { name: "Fundador", price: 900, period: "annual", color: "#e7d3a6", capacity: 50, perks: ["Placa de fundador", "Reconhecimento"] },
    ],
    perks: [
      { type: "whatsapp_group", name: "Grupo no WhatsApp", config: { group: "Garagem" } },
      { type: "drop", name: "Adesivo do clube", config: { item: "Kit de adesivos" } },
      { type: "discount", name: "15% em parceiros", config: { label: "Oficinas parceiras", percent: 15 } },
      { type: "event_access", name: "Track days exclusivos", config: { kind: "Lote de membro" } },
      { type: "discord_role", name: "Cargo no Discord", config: { role: "Piloto" } },
      { type: "drop", name: "Placa de fundador", config: { item: "Placa numerada" } },
      { type: "recognition", name: "Reconhecimento", config: { badge: "Fundador" } },
    ],
    attributes: ["modelo_carro", "placa"],
    suggestedConnections: ["whatsapp", "discord"],
  },
  {
    key: "team",
    label: "Time / torcida",
    blurb: "Torcedor · Sócio · Sócio Ouro · Camarote",
    vertical: "football",
    logoText: "meu time",
    tagline: "Cores que a gente carrega no peito.",
    theme: { primary: "#1d4ed8", accent: "#b8965a", defaultMode: "dark", darkEnabled: true, memberCardArt: art("#16284f", "#15140f") },
    tiers: [
      { name: "Torcedor", price: 0, period: "monthly", color: "#5d584c", capacity: null, perks: ["Grupo no Telegram"] },
      { name: "Sócio", price: 39, period: "monthly", color: "#1d4ed8", capacity: null, perks: ["Desconto em ingressos", "Conteúdo dos bastidores"] },
      { name: "Sócio Ouro", price: 99, period: "monthly", color: "#b8965a", capacity: null, perks: ["Lote de sócio", "Cargo no Discord"] },
      { name: "Camarote", price: 1200, period: "annual", color: "#e7d3a6", capacity: 30, perks: ["Experiência no camarote", "Reconhecimento"] },
    ],
    perks: [
      { type: "telegram_group", name: "Grupo no Telegram", config: { group: "Torcida" } },
      { type: "discount", name: "Desconto em ingressos", config: { label: "Ingressos", percent: 20 } },
      { type: "exclusive_content", name: "Conteúdo dos bastidores", config: { title: "Bastidores", provider: "YouTube" } },
      { type: "event_access", name: "Lote de sócio", config: { kind: "Lote de membro" } },
      { type: "discord_role", name: "Cargo no Discord", config: { role: "Sócio Ouro" } },
      { type: "custom", name: "Experiência no camarote", config: { label: "Camarote" } },
      { type: "recognition", name: "Reconhecimento", config: { badge: "Camarote" } },
    ],
    attributes: ["cadeira", "time_do_coracao"],
    suggestedConnections: ["telegram", "youtube", "discord"],
  },
  {
    key: "nightclub",
    label: "Balada / clube noturno",
    blurb: "Lista · Frequentador · VIP · Black",
    vertical: "nightlife",
    logoText: "minha casa",
    tagline: "A noite é de quem é de casa.",
    theme: { primary: "#db2777", accent: "#e7d3a6", defaultMode: "dark", darkEnabled: true, memberCardArt: art("#3a1430", "#15140f") },
    tiers: [
      { name: "Lista", price: 0, period: "monthly", color: "#5d584c", capacity: null, perks: ["Grupo no WhatsApp"] },
      { name: "Frequentador", price: 49, period: "monthly", color: "#db2777", capacity: null, perks: ["Entrada na lista", "Desconto no open"] },
      { name: "VIP", price: 129, period: "monthly", color: "#b8965a", capacity: null, perks: ["Mesa VIP", "Cargo no Discord"] },
      { name: "Black", price: 1500, period: "annual", color: "#e7d3a6", capacity: 40, perks: ["Camarote da casa", "Reconhecimento"] },
    ],
    perks: [
      { type: "whatsapp_group", name: "Grupo no WhatsApp", config: { group: "Lista VIP" } },
      { type: "event_access", name: "Entrada na lista", config: { kind: "Acesso antecipado" } },
      { type: "discount", name: "Desconto no open", config: { label: "Open bar", percent: 25 } },
      { type: "custom", name: "Mesa VIP", config: { label: "Mesa garantida" } },
      { type: "discord_role", name: "Cargo no Discord", config: { role: "VIP" } },
      { type: "custom", name: "Camarote da casa", config: { label: "Camarote" } },
      { type: "recognition", name: "Reconhecimento", config: { badge: "Black" } },
    ],
    attributes: ["aniversario", "drink_favorito"],
    suggestedConnections: ["whatsapp", "discord"],
  },
  {
    key: "creator",
    label: "Creator",
    blurb: "Seguidor · Apoiador · Insider · Founding Member",
    vertical: "creator",
    logoText: "meu canal",
    tagline: "Perto de quem faz acontecer.",
    theme: { primary: "#ea580c", accent: "#b8965a", defaultMode: "dark", darkEnabled: true, memberCardArt: art("#3a2310", "#15140f") },
    tiers: [
      { name: "Seguidor", price: 0, period: "monthly", color: "#5d584c", capacity: null, perks: ["Comunidade no Discord"] },
      { name: "Apoiador", price: 15, period: "monthly", color: "#ea580c", capacity: null, perks: ["Conteúdo exclusivo", "Cargo de apoiador"] },
      { name: "Insider", price: 39, period: "monthly", color: "#b8965a", capacity: null, perks: ["Lives fechadas", "Bastidores"] },
      { name: "Founding Member", price: 400, period: "annual", color: "#e7d3a6", capacity: 100, perks: ["Brinde fundador", "Reconhecimento"] },
    ],
    perks: [
      { type: "discord_role", name: "Comunidade no Discord", config: { role: "Seguidor" } },
      { type: "exclusive_content", name: "Conteúdo exclusivo", config: { title: "Posts e vídeos", provider: "YouTube" } },
      { type: "discord_role", name: "Cargo de apoiador", config: { role: "Apoiador" } },
      { type: "exclusive_content", name: "Lives fechadas", config: { title: "Lives", provider: "Twitch" } },
      { type: "exclusive_content", name: "Bastidores", config: { title: "Bastidores", provider: "YouTube" } },
      { type: "drop", name: "Brinde fundador", config: { item: "Kit fundador" } },
      { type: "recognition", name: "Reconhecimento", config: { badge: "Founding Member" } },
    ],
    attributes: ["rede_principal", "como_conheceu"],
    suggestedConnections: ["discord", "youtube", "twitch"],
  },
  {
    key: "company",
    label: "Empresa / associação",
    blurb: "Cliente · Membro · Premium · Embaixador",
    vertical: "association",
    logoText: "minha marca",
    tagline: "Um relacionamento que vale a pena.",
    theme: { primary: "#0f766e", accent: "#b8965a", defaultMode: "light", darkEnabled: true, memberCardArt: art("#0e2c2a", "#15140f") },
    tiers: [
      { name: "Cliente", price: 0, period: "monthly", color: "#5d584c", capacity: null, perks: ["Comunidade no WhatsApp"] },
      { name: "Membro", price: 59, period: "monthly", color: "#0f766e", capacity: null, perks: ["Conteúdo premium", "Desconto em produtos"] },
      { name: "Premium", price: 149, period: "monthly", color: "#b8965a", capacity: null, perks: ["Suporte prioritário", "Eventos exclusivos"] },
      { name: "Embaixador", price: 1500, period: "annual", color: "#e7d3a6", capacity: 25, perks: ["Brinde de embaixador", "Reconhecimento"] },
    ],
    perks: [
      { type: "whatsapp_group", name: "Comunidade no WhatsApp", config: { group: "Clientes" } },
      { type: "exclusive_content", name: "Conteúdo premium", config: { title: "Materiais", provider: "Vimeo" } },
      { type: "discount", name: "Desconto em produtos", config: { label: "Produtos", percent: 15 } },
      { type: "custom", name: "Suporte prioritário", config: { label: "Suporte VIP" } },
      { type: "event_access", name: "Eventos exclusivos", config: { kind: "Ingresso incluso" } },
      { type: "drop", name: "Brinde de embaixador", config: { item: "Kit embaixador" } },
      { type: "recognition", name: "Reconhecimento", config: { badge: "Embaixador" } },
    ],
    attributes: ["empresa", "cargo"],
    suggestedConnections: ["whatsapp", "vimeo"],
  },
  {
    key: "fitness",
    label: "Academia / Fitness",
    blurb: "Visitante · Aluno · Premium · Black",
    vertical: "fitness",
    logoText: "minha academia",
    tagline: "Sua melhor versão, com a gente do seu lado.",
    theme: { primary: "#16a34a", accent: "#b8965a", defaultMode: "dark", darkEnabled: true, memberCardArt: art("#103a26", "#15140f") },
    tiers: [
      { name: "Visitante", price: 0, period: "monthly", color: "#5d584c", capacity: null, perks: ["Grupo no WhatsApp"] },
      { name: "Aluno", price: 89, period: "monthly", color: "#16a34a", capacity: null, perks: ["Treinos em vídeo", "Comunidade no Telegram"] },
      { name: "Premium", price: 149, period: "monthly", color: "#b8965a", capacity: null, perks: ["Aulas ao vivo", "Acompanhamento nutricional"] },
      { name: "Black", price: 1500, period: "annual", color: "#e7d3a6", capacity: 50, perks: ["Personal dedicado", "Reconhecimento"] },
    ],
    perks: [
      { type: "whatsapp_group", name: "Grupo no WhatsApp", config: { group: "Alunos" } },
      { type: "exclusive_content", name: "Treinos em vídeo", config: { title: "Biblioteca de treinos", provider: "YouTube" } },
      { type: "telegram_group", name: "Comunidade no Telegram", config: { group: "Treino & dieta" } },
      { type: "exclusive_content", name: "Aulas ao vivo", config: { title: "Aulas", provider: "YouTube" } },
      { type: "custom", name: "Acompanhamento nutricional", config: { label: "Nutri" } },
      { type: "custom", name: "Personal dedicado", config: { label: "Personal" } },
      { type: "recognition", name: "Reconhecimento", config: { badge: "Black" } },
    ],
    attributes: ["objetivo", "plano_de_treino"],
    suggestedConnections: ["whatsapp", "youtube", "telegram"],
  },
  {
    key: "education",
    label: "Curso / Escola",
    blurb: "Ouvinte · Aluno · Pro · Mentoria",
    vertical: "education",
    logoText: "minha escola",
    tagline: "Aprenda com quem faz — junto com a turma.",
    theme: { primary: "#2563eb", accent: "#b8965a", defaultMode: "dark", darkEnabled: true, memberCardArt: art("#13294f", "#15140f") },
    tiers: [
      { name: "Ouvinte", price: 0, period: "monthly", color: "#5d584c", capacity: null, perks: ["Comunidade no Discord"] },
      { name: "Aluno", price: 49, period: "monthly", color: "#2563eb", capacity: null, perks: ["Aulas e VODs", "Grupo no Telegram"] },
      { name: "Pro", price: 99, period: "monthly", color: "#b8965a", capacity: null, perks: ["Lives fechadas", "Certificado"] },
      { name: "Mentoria", price: 1200, period: "annual", color: "#e7d3a6", capacity: 30, perks: ["Mentoria ao vivo", "Reconhecimento"] },
    ],
    perks: [
      { type: "discord_role", name: "Comunidade no Discord", config: { role: "Aluno" } },
      { type: "exclusive_content", name: "Aulas e VODs", config: { title: "Curso", provider: "YouTube" } },
      { type: "telegram_group", name: "Grupo no Telegram", config: { group: "Turma" } },
      { type: "exclusive_content", name: "Lives fechadas", config: { title: "Lives", provider: "YouTube" } },
      { type: "recognition", name: "Certificado", config: { badge: "Concluinte" } },
      { type: "custom", name: "Mentoria ao vivo", config: { label: "Mentoria" } },
      { type: "recognition", name: "Reconhecimento", config: { badge: "Mentoria" } },
    ],
    attributes: ["area_de_interesse", "nivel"],
    suggestedConnections: ["discord", "youtube"],
  },
  {
    key: "community",
    label: "Igreja / Comunidade",
    blurb: "Visitante · Membro · Mantenedor · Padrinho",
    vertical: "faith",
    logoText: "minha comunidade",
    tagline: "Mais perto, em comunhão.",
    theme: { primary: "#4f46e5", accent: "#b8965a", defaultMode: "light", darkEnabled: true, memberCardArt: art("#1e1b4b", "#15140f") },
    tiers: [
      { name: "Visitante", price: 0, period: "monthly", color: "#5d584c", capacity: null, perks: ["Grupo no WhatsApp"] },
      { name: "Membro", price: 25, period: "monthly", color: "#4f46e5", capacity: null, perks: ["Estudos e conteúdos", "Grupo no Telegram"] },
      { name: "Mantenedor", price: 80, period: "monthly", color: "#b8965a", capacity: null, perks: ["Cultos e lives", "Reconhecimento"] },
      { name: "Padrinho", price: 900, period: "annual", color: "#e7d3a6", capacity: null, perks: ["Brinde", "Reconhecimento"] },
    ],
    perks: [
      { type: "whatsapp_group", name: "Grupo no WhatsApp", config: { group: "Comunidade" } },
      { type: "exclusive_content", name: "Estudos e conteúdos", config: { title: "Estudos", provider: "YouTube" } },
      { type: "telegram_group", name: "Grupo no Telegram", config: { group: "Avisos" } },
      { type: "exclusive_content", name: "Cultos e lives", config: { title: "Cultos", provider: "YouTube" } },
      { type: "drop", name: "Brinde", config: { item: "Kit do membro" } },
      { type: "recognition", name: "Reconhecimento", config: { badge: "Padrinho" } },
    ],
    attributes: ["ministerio", "cidade"],
    suggestedConnections: ["whatsapp", "youtube"],
  },
  {
    key: "podcast",
    label: "Podcast / Newsletter",
    blurb: "Ouvinte · Apoiador · Insider · Patrono",
    vertical: "podcast",
    logoText: "meu programa",
    tagline: "Bastidores e episódios extras, só pra quem apoia.",
    theme: { primary: "#0d9488", accent: "#b8965a", defaultMode: "dark", darkEnabled: true, memberCardArt: art("#0e3330", "#15140f") },
    tiers: [
      { name: "Ouvinte", price: 0, period: "monthly", color: "#5d584c", capacity: null, perks: ["Comunidade no Discord"] },
      { name: "Apoiador", price: 15, period: "monthly", color: "#0d9488", capacity: null, perks: ["Episódios extras", "Grupo no Telegram"] },
      { name: "Insider", price: 35, period: "monthly", color: "#b8965a", capacity: null, perks: ["Bastidores", "Cargo de apoiador"] },
      { name: "Patrono", price: 400, period: "annual", color: "#e7d3a6", capacity: 100, perks: ["Brinde patrono", "Reconhecimento"] },
    ],
    perks: [
      { type: "discord_role", name: "Comunidade no Discord", config: { role: "Ouvinte" } },
      { type: "exclusive_content", name: "Episódios extras", config: { title: "Episódios", provider: "Spotify" } },
      { type: "telegram_group", name: "Grupo no Telegram", config: { group: "Apoiadores" } },
      { type: "exclusive_content", name: "Bastidores", config: { title: "Bastidores", provider: "YouTube" } },
      { type: "discord_role", name: "Cargo de apoiador", config: { role: "Apoiador" } },
      { type: "drop", name: "Brinde patrono", config: { item: "Kit patrono" } },
      { type: "recognition", name: "Reconhecimento", config: { badge: "Patrono" } },
    ],
    attributes: ["como_conheceu", "plataforma_preferida"],
    suggestedConnections: ["discord", "spotify", "telegram"],
  },
];

export const getTemplate = (key: string): VerticalTemplate | undefined =>
  TEMPLATES.find((t) => t.key === key);
