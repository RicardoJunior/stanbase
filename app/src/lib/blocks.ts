/**
 * Landing page builder — block catalog (§24). The member LP is a composable list
 * of CURATED blocks: the owner adds/reorders/edits them, but each block has a
 * fixed, well-designed layout (modelos de objeto + limites de customização), so
 * the page stays on-brand. Adding a block type = one entry here + one renderer.
 */
import type { LandingBlock } from "@/types/domain";

export type FieldType = "text" | "textarea" | "image" | "url" | "select" | "switch" | "list";

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
  placeholder?: string;
  itemFields?: FieldDef[]; // for type: "list"
  itemLabel?: string; // singular name for list items
}

export interface BlockDef {
  type: string;
  label: string;
  group: "abertura" | "conteúdo" | "prova" | "conversão";
  description: string;
  /** auto blocks pull live data (tiers/perks) and have fewer/zero content fields. */
  fields: FieldDef[];
  default: Record<string, any>;
  /** singleton blocks (hero) shouldn't be added twice in the palette hint. */
  singleton?: boolean;
}

export const BLOCK_DEFS: BlockDef[] = [
  {
    type: "hero",
    label: "Hero",
    group: "abertura",
    description: "Abertura com título, subtítulo, botões e a carteirinha.",
    singleton: true,
    fields: [
      { key: "eyebrow", label: "Eyebrow", type: "text" },
      { key: "title", label: "Título", type: "textarea" },
      { key: "subtitle", label: "Subtítulo", type: "textarea" },
      { key: "primaryLabel", label: "Botão principal", type: "text" },
      { key: "secondaryLabel", label: "Botão secundário", type: "text" },
      { key: "align", label: "Alinhamento", type: "select", options: ["left", "center"] },
      { key: "showCard", label: "Mostrar carteirinha", type: "switch" },
      { key: "imageUrl", label: "Imagem (no lugar da carteirinha)", type: "image" },
    ],
    default: {
      eyebrow: "Membership oficial",
      title: "",
      subtitle: "",
      primaryLabel: "Ver planos",
      secondaryLabel: "Já sou membro",
      align: "left",
      showCard: true,
      imageUrl: "",
    },
  },
  {
    type: "richtext",
    label: "Texto",
    group: "conteúdo",
    description: "Um bloco de título + parágrafo.",
    fields: [
      { key: "eyebrow", label: "Eyebrow", type: "text" },
      { key: "heading", label: "Título", type: "text" },
      { key: "body", label: "Texto", type: "textarea" },
      { key: "align", label: "Alinhamento", type: "select", options: ["left", "center"] },
    ],
    default: { eyebrow: "", heading: "Sobre a comunidade", body: "Conte aqui a história e o propósito da sua comunidade.", align: "center" },
  },
  {
    type: "text_image",
    label: "Texto + Imagem",
    group: "conteúdo",
    description: "Texto de um lado, imagem do outro.",
    fields: [
      { key: "eyebrow", label: "Eyebrow", type: "text" },
      { key: "heading", label: "Título", type: "text" },
      { key: "body", label: "Texto", type: "textarea" },
      { key: "imageUrl", label: "Imagem (URL)", type: "image" },
      { key: "imageSide", label: "Lado da imagem", type: "select", options: ["right", "left"] },
      { key: "ctaLabel", label: "Botão (opcional)", type: "text" },
    ],
    default: { eyebrow: "", heading: "Mais perto de quem importa", body: "Descreva um benefício ou momento da sua comunidade.", imageUrl: "", imageSide: "right", ctaLabel: "" },
  },
  {
    type: "image",
    label: "Imagem",
    group: "conteúdo",
    description: "Uma imagem larga com legenda.",
    fields: [
      { key: "imageUrl", label: "Imagem (URL)", type: "image" },
      { key: "caption", label: "Legenda", type: "text" },
      { key: "width", label: "Largura", type: "select", options: ["wide", "full"] },
    ],
    default: { imageUrl: "", caption: "", width: "wide" },
  },
  {
    type: "features",
    label: "Destaques",
    group: "conteúdo",
    description: "Grade de 2–3 cards de valor.",
    fields: [
      { key: "eyebrow", label: "Eyebrow", type: "text" },
      { key: "heading", label: "Título", type: "text" },
      { key: "columns", label: "Colunas", type: "select", options: ["2", "3"] },
      {
        key: "items", label: "Cards", type: "list", itemLabel: "card",
        itemFields: [
          { key: "title", label: "Título", type: "text" },
          { key: "body", label: "Texto", type: "textarea" },
        ],
      },
    ],
    default: {
      eyebrow: "Por que entrar",
      heading: "O que você ganha",
      columns: "3",
      items: [
        { title: "Proximidade", body: "Canais e momentos exclusivos com quem você admira." },
        { title: "Perks de verdade", body: "Benefícios que só membros têm, entregues na hora." },
        { title: "Reconhecimento", body: "Seu lugar de honra entre os maiores fãs." },
      ],
    },
  },
  {
    type: "perks",
    label: "Vitrine de perks",
    group: "conteúdo",
    description: "Mostra automaticamente os perks dos tiers.",
    fields: [
      { key: "eyebrow", label: "Eyebrow", type: "text" },
      { key: "heading", label: "Título", type: "text" },
    ],
    default: { eyebrow: "Benefícios", heading: "Tudo que você desbloqueia" },
  },
  {
    type: "tiers",
    label: "Planos",
    group: "conversão",
    description: "A grade de planos (puxa os tiers configurados).",
    singleton: true,
    fields: [
      { key: "eyebrow", label: "Eyebrow", type: "text" },
      { key: "heading", label: "Título", type: "text" },
      { key: "note", label: "Nota (rodapé)", type: "text" },
    ],
    default: { eyebrow: "Escolha seu nível", heading: "Planos de membro", note: "sem mensalidade · cancele quando quiser" },
  },
  {
    type: "stats",
    label: "Números",
    group: "prova",
    description: "Métricas em destaque (ex.: 2.4k membros).",
    fields: [
      {
        key: "items", label: "Números", type: "list", itemLabel: "número",
        itemFields: [
          { key: "value", label: "Valor", type: "text" },
          { key: "label", label: "Rótulo", type: "text" },
        ],
      },
    ],
    default: { items: [{ value: "2.4k", label: "membros" }, { value: "98%", label: "renovam" }, { value: "120+", label: "perks entregues" }] },
  },
  {
    type: "testimonials",
    label: "Depoimentos",
    group: "prova",
    description: "O que os membros dizem.",
    fields: [
      { key: "eyebrow", label: "Eyebrow", type: "text" },
      { key: "heading", label: "Título", type: "text" },
      {
        key: "items", label: "Depoimentos", type: "list", itemLabel: "depoimento",
        itemFields: [
          { key: "quote", label: "Citação", type: "textarea" },
          { key: "author", label: "Autor", type: "text" },
          { key: "role", label: "Papel/tier", type: "text" },
        ],
      },
    ],
    default: {
      eyebrow: "Quem é de casa",
      heading: "A voz da comunidade",
      items: [
        { quote: "Melhor decisão que tomei — me sinto parte de algo.", author: "João S.", role: "Founder" },
        { quote: "Os perks valem cada centavo. Recomendo demais.", author: "Marina A.", role: "VIP" },
      ],
    },
  },
  {
    type: "faq",
    label: "FAQ",
    group: "conversão",
    description: "Perguntas frequentes (accordion).",
    fields: [
      { key: "eyebrow", label: "Eyebrow", type: "text" },
      { key: "heading", label: "Título", type: "text" },
      {
        key: "items", label: "Perguntas", type: "list", itemLabel: "pergunta",
        itemFields: [
          { key: "q", label: "Pergunta", type: "text" },
          { key: "a", label: "Resposta", type: "textarea" },
        ],
      },
    ],
    default: {
      eyebrow: "Dúvidas",
      heading: "Perguntas frequentes",
      items: [
        { q: "Posso cancelar quando quiser?", a: "Sim. Sem fidelidade — você cancela a qualquer momento e mantém o acesso até o fim do período pago." },
        { q: "Como recebo minha carteirinha?", a: "Assim que você assina, ela fica disponível na sua área de membro e pode ser adicionada à Apple/Google Wallet." },
        { q: "Quais formas de pagamento?", a: "Pix à vista e cartão de crédito (com parcelamento nos planos elegíveis)." },
      ],
    },
  },
  {
    type: "video",
    label: "Vídeo",
    group: "conteúdo",
    description: "Um vídeo incorporado (YouTube/Vimeo).",
    fields: [
      { key: "eyebrow", label: "Eyebrow", type: "text" },
      { key: "heading", label: "Título", type: "text" },
      { key: "url", label: "URL do vídeo", type: "url" },
    ],
    default: { eyebrow: "", heading: "Assista", url: "" },
  },
  {
    type: "gallery",
    label: "Galeria",
    group: "conteúdo",
    description: "Grade de imagens.",
    fields: [
      { key: "heading", label: "Título", type: "text" },
      {
        key: "images", label: "Imagens", type: "list", itemLabel: "imagem",
        itemFields: [{ key: "url", label: "URL", type: "image" }],
      },
    ],
    default: { heading: "Momentos", images: [{ url: "" }, { url: "" }, { url: "" }] },
  },
  {
    type: "cta",
    label: "Chamada final",
    group: "conversão",
    description: "Bloco de conversão com botão.",
    fields: [
      { key: "eyebrow", label: "Eyebrow", type: "text" },
      { key: "title", label: "Título", type: "text" },
      { key: "subtitle", label: "Subtítulo", type: "textarea" },
      { key: "ctaLabel", label: "Botão", type: "text" },
    ],
    default: { eyebrow: "Pronto?", title: "Faça parte hoje", subtitle: "Vire membro e desbloqueie tudo que a comunidade tem a oferecer.", ctaLabel: "Ver planos" },
  },
  {
    type: "divider",
    label: "Divisor",
    group: "conteúdo",
    description: "Espaço ou linha entre blocos.",
    fields: [{ key: "style", label: "Estilo", type: "select", options: ["line", "space"] }],
    default: { style: "line" },
  },
];

export const blockDef = (type: string): BlockDef | undefined => BLOCK_DEFS.find((b) => b.type === type);

let counter = 0;
export function newBlock(type: string): LandingBlock {
  const def = blockDef(type)!;
  counter += 1;
  return { id: `blk_${type}_${counter}_${Math.random().toString(36).slice(2, 6)}`, type, content: structuredClone(def.default) };
}

/** A rich, on-brand default landing for a fresh org (so it's never "discreto"). */
export function buildDefaultLanding(org: { name: string; tagline: string }): LandingBlock[] {
  const mk = (type: string, content: Record<string, any>): LandingBlock => {
    const b = newBlock(type);
    b.content = { ...b.content, ...content };
    return b;
  };
  return [
    mk("hero", {
      title: org.tagline,
      subtitle: `Vire membro da ${org.name}, ganhe sua carteirinha digital e acesse perks, conteúdo e eventos exclusivos.`,
    }),
    mk("features", {}),
    mk("perks", {}),
    mk("tiers", {}),
    mk("faq", {}),
    mk("cta", { subtitle: `Faça parte da ${org.name} e desbloqueie tudo.` }),
  ];
}
