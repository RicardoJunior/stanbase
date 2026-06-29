import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Check, Gift, Plus, Minus, Quote, ImageIcon, Play } from "lucide-react";
import { listTiers, listPerks } from "@/lib/api";
import { BRL, installmentsAllowed, installmentOptions } from "@/lib/billing";
import { perkIdsForTier } from "@/lib/entitlements";
import { MemberCard } from "@/components/MemberCard";
import type { DBSnapshot, LandingBlock, Organization } from "@/types/domain";

export interface BlockCtx {
  org: Organization;
  db: DBSnapshot;
  orgSlug: string;
  /** preview mode disables navigation (used in the admin builder). */
  preview?: boolean;
}

type C = Record<string, any>;

const Section = ({ children, className = "" }: { children: ReactNode; className?: string }) => (
  <section className={`max-w-6xl mx-auto px-6 ${className}`}>{children}</section>
);

const Eyebrow = ({ children }: { children: ReactNode }) =>
  children ? <span className="eyebrow" style={{ color: "var(--color-accent)" }}>{children}</span> : null;

function ImageOrPlaceholder({ url, className, style }: { url?: string; className?: string; style?: React.CSSProperties }) {
  if (url) return <img src={url} alt="" className={className} style={style} loading="lazy" />;
  return (
    <div
      className={`flex items-center justify-center ${className ?? ""}`}
      style={{ background: "color-mix(in srgb, var(--color-accent) 14%, var(--color-surface))", ...style }}
    >
      <ImageIcon size={36} style={{ color: "var(--color-accent)", opacity: 0.5 }} />
    </div>
  );
}

function PrimaryBtn({ to, children, ctx }: { to: string; children: ReactNode; ctx: BlockCtx }) {
  const cls = "inline-block rounded-full px-6 py-3 font-medium text-center transition-transform hover:-translate-y-0.5";
  const style = { background: "var(--color-primary)", color: "var(--color-primary-contrast)" };
  if (ctx.preview) return <span className={cls} style={style}>{children}</span>;
  return <Link to={to} className={cls} style={style}>{children}</Link>;
}

export function BlockRenderer({ block, ctx }: { block: LandingBlock; ctx: BlockCtx }) {
  const c = block.content as C;
  switch (block.type) {
    case "hero": return <Hero c={c} ctx={ctx} />;
    case "richtext": return <RichText c={c} />;
    case "text_image": return <TextImage c={c} />;
    case "image": return <ImageBlock c={c} />;
    case "features": return <Features c={c} />;
    case "perks": return <Perks c={c} ctx={ctx} />;
    case "tiers": return <Tiers c={c} ctx={ctx} />;
    case "stats": return <Stats c={c} />;
    case "testimonials": return <Testimonials c={c} />;
    case "faq": return <Faq c={c} />;
    case "video": return <Video c={c} />;
    case "gallery": return <Gallery c={c} />;
    case "cta": return <Cta c={c} ctx={ctx} />;
    case "divider": return <Divider c={c} />;
    default: return null;
  }
}

function Hero({ c, ctx }: { c: C; ctx: BlockCtx }) {
  const { org, orgSlug } = ctx;
  const tiers = listTiers(ctx.db, org.id);
  const topTier = tiers[tiers.length - 1];
  const center = c.align === "center";
  const media = c.imageUrl ? (
    <img src={c.imageUrl} alt="" className="rounded-2xl w-full object-cover max-h-[420px]" />
  ) : c.showCard !== false ? (
    <MemberCard orgLogoText={org.logoText} memberName="seu maior fã" memberIdCode="B7K2M9X4" tierName={topTier?.name ?? "Founder"} tierColor={org.theme.accent} joinedAt={new Date().toISOString()} art={org.theme.memberCardArt} showQr={false} interactive={!ctx.preview} />
  ) : null;
  return (
    <Section className={`pt-16 pb-12 ${media && !center ? "grid md:grid-cols-2 gap-12 items-center" : ""}`}>
      <div className={center ? "text-center max-w-3xl mx-auto" : ""}>
        <Eyebrow>{c.eyebrow}</Eyebrow>
        <h1 className="font-display text-[clamp(2.4rem,5vw,3.8rem)] leading-[1.05] mt-3 mb-4">{c.title}</h1>
        {c.subtitle && <p className={`text-muted text-lg mb-7 ${center ? "mx-auto max-w-xl" : "max-w-md"}`}>{c.subtitle}</p>}
        <div className={`flex gap-3 flex-wrap ${center ? "justify-center" : ""}`}>
          {c.primaryLabel && <PrimaryBtn to={`/m/${orgSlug}/checkout/${topTier?.id ?? ""}`} ctx={ctx}>{c.primaryLabel}</PrimaryBtn>}
          {c.secondaryLabel && (
            ctx.preview
              ? <span className="rounded-full px-6 py-3 font-medium border border-line">{c.secondaryLabel}</span>
              : <Link to={`/m/${orgSlug}/login`} className="rounded-full px-6 py-3 font-medium border border-line hover:border-content/40 transition-colors">{c.secondaryLabel}</Link>
          )}
        </div>
      </div>
      {media && !center && <div>{media}</div>}
      {media && center && <div className="mt-10 max-w-md mx-auto">{media}</div>}
    </Section>
  );
}

function RichText({ c }: { c: C }) {
  const center = c.align !== "left";
  return (
    <Section className="py-14">
      <div className={`${center ? "text-center max-w-2xl mx-auto" : "max-w-2xl"}`}>
        <Eyebrow>{c.eyebrow}</Eyebrow>
        {c.heading && <h2 className="font-display text-3xl mt-2 mb-3">{c.heading}</h2>}
        <p className="text-muted text-lg leading-relaxed whitespace-pre-line">{c.body}</p>
      </div>
    </Section>
  );
}

function TextImage({ c }: { c: C }) {
  const left = c.imageSide === "left";
  return (
    <Section className="py-14">
      <div className="grid md:grid-cols-2 gap-10 items-center">
        <div className={left ? "md:order-2" : ""}>
          <Eyebrow>{c.eyebrow}</Eyebrow>
          {c.heading && <h2 className="font-display text-3xl mt-2 mb-3">{c.heading}</h2>}
          <p className="text-muted text-lg leading-relaxed whitespace-pre-line mb-5">{c.body}</p>
          {c.ctaLabel && <span className="inline-block rounded-full px-5 py-2.5 text-sm font-medium" style={{ background: "var(--color-primary)", color: "var(--color-primary-contrast)" }}>{c.ctaLabel}</span>}
        </div>
        <div className={left ? "md:order-1" : ""}>
          <ImageOrPlaceholder url={c.imageUrl} className="rounded-2xl w-full aspect-[4/3] object-cover" />
        </div>
      </div>
    </Section>
  );
}

function ImageBlock({ c }: { c: C }) {
  const full = c.width === "full";
  return (
    <figure className={full ? "my-10" : "max-w-6xl mx-auto px-6 my-10"}>
      <ImageOrPlaceholder url={c.imageUrl} className={`w-full object-cover ${full ? "max-h-[520px]" : "rounded-2xl aspect-[16/7]"}`} />
      {c.caption && <figcaption className="text-center text-muted text-sm mt-3 font-mono">{c.caption}</figcaption>}
    </figure>
  );
}

function Features({ c }: { c: C }) {
  const cols = c.columns === "2" ? "md:grid-cols-2" : "md:grid-cols-3";
  const items: C[] = c.items ?? [];
  return (
    <Section className="py-14">
      {(c.eyebrow || c.heading) && (
        <div className="text-center mb-10">
          <Eyebrow>{c.eyebrow}</Eyebrow>
          {c.heading && <h2 className="font-display text-3xl mt-2">{c.heading}</h2>}
        </div>
      )}
      <div className={`grid ${cols} gap-5`}>
        {items.map((it, i) => (
          <div key={i} className="rounded-2xl border border-line p-6" style={{ background: "var(--color-surface)", borderTop: "2px solid var(--color-accent)" }}>
            <h3 className="font-display text-xl mb-2">{it.title}</h3>
            <p className="text-muted">{it.body}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Perks({ c, ctx }: { c: C; ctx: BlockCtx }) {
  const tiers = listTiers(ctx.db, ctx.org.id);
  const allPerks = listPerks(ctx.db, ctx.org.id);
  // unique perks across tiers, in tier order
  const seen = new Set<string>();
  const ordered: { name: string; tier: string; color: string }[] = [];
  for (const t of tiers) {
    for (const id of perkIdsForTier(t.id, tiers)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const p = allPerks.find((x) => x.id === id);
      if (p) ordered.push({ name: p.name, tier: t.name, color: t.color });
    }
  }
  return (
    <Section className="py-14">
      <div className="text-center mb-10">
        <Eyebrow>{c.eyebrow}</Eyebrow>
        {c.heading && <h2 className="font-display text-3xl mt-2">{c.heading}</h2>}
      </div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {ordered.map((p, i) => (
          <div key={i} className="flex items-center gap-3 rounded-xl border border-line px-4 py-3.5" style={{ background: "var(--color-surface)" }}>
            <span className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}>
              <Gift size={16} style={{ color: "var(--color-accent)" }} />
            </span>
            <div>
              <div className="text-sm font-medium">{p.name}</div>
              <div className="text-[0.68rem] font-mono uppercase tracking-wide" style={{ color: p.color }}>a partir de {p.tier}</div>
            </div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Tiers({ c, ctx }: { c: C; ctx: BlockCtx }) {
  const { org, orgSlug } = ctx;
  const tiers = listTiers(ctx.db, org.id);
  const perks = listPerks(ctx.db, org.id);
  const topTier = tiers[tiers.length - 1];
  return (
    <Section className="py-14">
      <div className="text-center mb-10">
        <Eyebrow>{c.eyebrow}</Eyebrow>
        {c.heading && <h2 className="font-display text-3xl mt-2">{c.heading}</h2>}
      </div>
      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-5">
        {tiers.map((tier) => {
          const tierPerks = perks.filter((p) => perkIdsForTier(tier.id, tiers).includes(p.id));
          const inst = installmentsAllowed(tier.period) && tier.price > 0 ? installmentOptions(tier.price, tier.period).at(-1) : null;
          const featured = tier.id === topTier?.id;
          const cta = (
            <span className="rounded-full px-5 py-2.5 text-sm font-medium text-center block" style={featured ? { background: "var(--color-primary)", color: "var(--color-primary-contrast)" } : { border: "1px solid var(--color-border)" }}>
              {tier.price === 0 ? "Entrar grátis" : `Assinar ${tier.name}`}
            </span>
          );
          return (
            <div key={tier.id} className="rounded-2xl border p-6 flex flex-col" style={{ borderColor: featured ? tier.color : "var(--color-border)", background: "var(--color-surface)", boxShadow: featured ? `0 24px 50px -30px ${tier.color}` : undefined }}>
              <div className="flex items-center gap-2 mb-1">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: tier.color }} />
                <h3 className="font-display text-xl">{tier.name}</h3>
              </div>
              <p className="text-muted text-sm min-h-[40px]">{tier.description}</p>
              <div className="my-4">
                <span className="font-display text-4xl">{tier.price === 0 ? "Grátis" : BRL(tier.price)}</span>
                {tier.price > 0 && <span className="text-muted text-sm"> /{tier.period === "annual" ? "ano" : tier.period === "monthly" ? "mês" : tier.period}</span>}
              </div>
              {inst && <div className="text-xs text-muted -mt-2 mb-3">ou {inst.n}× de {BRL(inst.installmentValue)}</div>}
              <ul className="space-y-2 flex-1 mb-5">
                {tierPerks.slice(0, 5).map((p) => (
                  <li key={p.id} className="flex items-start gap-2 text-sm"><Check size={15} style={{ color: tier.color }} className="mt-0.5 shrink-0" />{p.name}</li>
                ))}
                {tierPerks.length === 0 && <li className="flex items-center gap-2 text-sm text-muted"><Gift size={14} /> Acesso à comunidade</li>}
              </ul>
              {ctx.preview ? cta : <Link to={`/m/${orgSlug}/checkout/${tier.id}`} className="hover:-translate-y-0.5 transition-transform">{cta}</Link>}
            </div>
          );
        })}
      </div>
      {c.note && <p className="text-center text-muted text-sm mt-6 font-mono">{c.note}</p>}
    </Section>
  );
}

function Stats({ c }: { c: C }) {
  const items: C[] = c.items ?? [];
  return (
    <Section className="py-12">
      <div className="grid grid-cols-3 gap-6 text-center">
        {items.map((it, i) => (
          <div key={i}>
            <div className="font-display text-[clamp(2rem,5vw,3.2rem)]" style={{ color: "var(--color-accent)" }}>{it.value}</div>
            <div className="font-mono text-[0.7rem] uppercase tracking-[0.16em] text-muted mt-1">{it.label}</div>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Testimonials({ c }: { c: C }) {
  const items: C[] = c.items ?? [];
  return (
    <Section className="py-14">
      <div className="text-center mb-10">
        <Eyebrow>{c.eyebrow}</Eyebrow>
        {c.heading && <h2 className="font-display text-3xl mt-2">{c.heading}</h2>}
      </div>
      <div className="grid md:grid-cols-2 gap-5">
        {items.map((it, i) => (
          <figure key={i} className="rounded-2xl border border-line p-6" style={{ background: "var(--color-surface)" }}>
            <Quote size={22} style={{ color: "var(--color-accent)" }} />
            <blockquote className="font-display text-xl leading-snug mt-3 mb-4">“{it.quote}”</blockquote>
            <figcaption className="text-sm"><span className="font-medium">{it.author}</span>{it.role && <span className="text-muted"> · {it.role}</span>}</figcaption>
          </figure>
        ))}
      </div>
    </Section>
  );
}

function Faq({ c }: { c: C }) {
  const items: C[] = c.items ?? [];
  const [open, setOpen] = useState<number | null>(0);
  return (
    <Section className="py-14 max-w-3xl">
      <div className="text-center mb-8">
        <Eyebrow>{c.eyebrow}</Eyebrow>
        {c.heading && <h2 className="font-display text-3xl mt-2">{c.heading}</h2>}
      </div>
      <div className="divide-y divide-line border-y border-line">
        {items.map((it, i) => {
          const isOpen = open === i;
          return (
            <div key={i}>
              <button onClick={() => setOpen(isOpen ? null : i)} className="w-full flex items-center justify-between gap-4 py-4 text-left">
                <span className="font-display text-lg">{it.q}</span>
                {isOpen ? <Minus size={18} className="shrink-0 text-muted" /> : <Plus size={18} className="shrink-0 text-muted" />}
              </button>
              {isOpen && <p className="text-muted pb-4 -mt-1 leading-relaxed">{it.a}</p>}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function toEmbed(url: string): string | null {
  if (!url) return null;
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]+)/);
  if (yt) return `https://www.youtube.com/embed/${yt[1]}`;
  const vm = url.match(/vimeo\.com\/(\d+)/);
  if (vm) return `https://player.vimeo.com/video/${vm[1]}`;
  return url;
}

function Video({ c }: { c: C }) {
  const embed = toEmbed(c.url);
  return (
    <Section className="py-14 max-w-4xl">
      {(c.eyebrow || c.heading) && (
        <div className="text-center mb-6">
          <Eyebrow>{c.eyebrow}</Eyebrow>
          {c.heading && <h2 className="font-display text-3xl mt-2">{c.heading}</h2>}
        </div>
      )}
      <div className="rounded-2xl overflow-hidden border border-line aspect-video" style={{ background: "var(--color-surface)" }}>
        {embed ? (
          <iframe src={embed} className="w-full h-full" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen title="vídeo" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted"><Play size={40} style={{ color: "var(--color-accent)" }} /></div>
        )}
      </div>
    </Section>
  );
}

function Gallery({ c }: { c: C }) {
  const images: C[] = c.images ?? [];
  return (
    <Section className="py-14">
      {c.heading && <h2 className="font-display text-3xl text-center mb-8">{c.heading}</h2>}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {images.map((im, i) => (
          <ImageOrPlaceholder key={i} url={im.url} className="rounded-xl w-full aspect-square object-cover" />
        ))}
      </div>
    </Section>
  );
}

function Cta({ c, ctx }: { c: C; ctx: BlockCtx }) {
  const tiers = listTiers(ctx.db, ctx.org.id);
  const top = tiers[tiers.length - 1];
  return (
    <Section className="py-16">
      <div className="rounded-3xl border border-line text-center px-6 py-14" style={{ background: "var(--color-surface)" }}>
        <Eyebrow>{c.eyebrow}</Eyebrow>
        <h2 className="font-display text-[clamp(2rem,4vw,3rem)] mt-2 mb-3">{c.title}</h2>
        {c.subtitle && <p className="text-muted text-lg max-w-xl mx-auto mb-7">{c.subtitle}</p>}
        {c.ctaLabel && <PrimaryBtn to={`/m/${ctx.orgSlug}/checkout/${top?.id ?? ""}`} ctx={ctx}>{c.ctaLabel}</PrimaryBtn>}
      </div>
    </Section>
  );
}

function Divider({ c }: { c: C }) {
  if (c.style === "space") return <div className="py-8" />;
  return <div className="max-w-6xl mx-auto px-6 my-4"><div className="h-px bg-line" /></div>;
}
