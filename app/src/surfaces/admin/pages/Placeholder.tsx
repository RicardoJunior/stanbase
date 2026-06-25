import { Construction } from "lucide-react";
import { SectionHead } from "@/components/ui";

/** Honest stub for modules outside the v0 cut (roadmap V1+). */
export default function Placeholder({ module }: { module: string }) {
  return (
    <div>
      <SectionHead eyebrow="Módulo" title={module} />
      <div className="bg-surface border border-line rounded-2xl border-t-2 border-t-gold p-12 text-center">
        <div className="flex justify-center text-gold-deep mb-4">
          <Construction size={32} strokeWidth={1.4} />
        </div>
        <h3 className="font-display text-xl mb-2">Fora do corte da v0</h3>
        <p className="text-muted max-w-md mx-auto text-[0.95rem]">
          Este módulo entra no <strong>V1</strong> do roadmap (§90.4). A v0 entrega o loop de valor mínimo:
          tiers &amp; perks, checkout com split e parcelamento, Passport e validação pública.
        </p>
        <p className="text-muted/70 text-xs mt-4 font-mono">documentado em docs/plan/90-roadmap.md</p>
      </div>
    </div>
  );
}
