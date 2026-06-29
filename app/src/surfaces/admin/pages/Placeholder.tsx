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
        <h3 className="font-display text-xl mb-2">Em breve</h3>
        <p className="text-muted max-w-md mx-auto text-[0.95rem]">
          Este módulo está a caminho. Por enquanto, você já pode configurar tiers &amp; perks, a página do
          membro, receber pagamentos e validar membros na portaria.
        </p>
      </div>
    </div>
  );
}
