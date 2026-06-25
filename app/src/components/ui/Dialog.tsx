import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

export function Dialog({
  open,
  onClose,
  title,
  eyebrow,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  eyebrow?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;
  const widths = { sm: "max-w-md", md: "max-w-xl", lg: "max-w-3xl" };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-obsidian/50 backdrop-blur-sm" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          "relative w-full bg-surface border border-line rounded-2xl shadow-[0_40px_100px_-40px_rgba(22,21,15,.7)] max-h-[88vh] overflow-hidden flex flex-col",
          widths[size]
        )}
      >
        <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-line">
          <div>
            {eyebrow && <div className="eyebrow text-[0.62rem] mb-1.5">{eyebrow}</div>}
            {title && <h3 className="font-display text-xl">{title}</h3>}
          </div>
          <button onClick={onClose} className="text-muted hover:text-content transition-colors" aria-label="Fechar">
            <X size={20} />
          </button>
        </div>
        <div className="p-6 overflow-y-auto">{children}</div>
        {footer && <div className="px-6 py-4 border-t border-line flex justify-end gap-3 bg-surface-2/40">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}
