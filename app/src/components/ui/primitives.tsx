import type { InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

/* ── brand atoms ─────────────────────────────────────────────── */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("eyebrow", className)}>{children}</span>;
}

export function SectionHead({
  eyebrow,
  title,
  desc,
  action,
}: {
  eyebrow?: string;
  title: ReactNode;
  desc?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-6 mb-7 flex-wrap">
      <div className="max-w-2xl">
        {eyebrow && <Eyebrow className="mb-2">{eyebrow}</Eyebrow>}
        <h2 className="font-display text-[1.7rem] leading-tight">{title}</h2>
        {desc && <p className="text-muted mt-2 text-[0.98rem] leading-relaxed">{desc}</p>}
      </div>
      {action}
    </div>
  );
}

/* ── badges / chips ──────────────────────────────────────────── */
type Tone = "neutral" | "gold" | "success" | "warning" | "danger" | "primary";
const toneClasses: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted border-line",
  gold: "bg-gold/10 text-gold-deep border-gold/40",
  success: "bg-success/10 text-success border-success/30",
  warning: "bg-warning/10 text-warning border-warning/30",
  danger: "bg-danger/10 text-danger border-danger/30",
  primary: "bg-[var(--color-primary)]/10 text-[var(--color-primary)] border-[var(--color-primary)]/30",
};

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[0.66rem] tracking-wide uppercase",
        toneClasses[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

export function Dot({ color }: { color: string }) {
  return <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: color }} />;
}

/* ── stat (metric tile) ──────────────────────────────────────── */
export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "up" | "down";
}) {
  return (
    <div className="bg-surface border border-line rounded-2xl border-t-2 border-t-gold p-5">
      <div className="font-mono text-[0.6rem] tracking-[0.16em] uppercase text-muted mb-2">{label}</div>
      <div className="font-display text-[2rem] leading-none">{value}</div>
      {hint && (
        <div
          className={cn(
            "mt-2 text-[0.8rem]",
            tone === "up" ? "text-success" : tone === "down" ? "text-danger" : "text-muted"
          )}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

/* ── avatar ──────────────────────────────────────────────────── */
export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  const initials = name.split(" ").slice(0, 2).map((n) => n[0]).join("").toUpperCase();
  return (
    <span
      className="inline-flex items-center justify-center rounded-full bg-surface-2 border border-line font-mono text-muted"
      style={{ width: size, height: size, fontSize: size * 0.36 }}
    >
      {initials}
    </span>
  );
}

/* ── empty state ─────────────────────────────────────────────── */
export function EmptyState({ icon, title, desc, action }: { icon?: ReactNode; title: string; desc?: string; action?: ReactNode }) {
  return (
    <div className="text-center py-16 px-6">
      {icon && <div className="text-gold-deep flex justify-center mb-3">{icon}</div>}
      <div className="font-display text-lg">{title}</div>
      {desc && <p className="text-muted mt-1.5 text-sm max-w-sm mx-auto">{desc}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/* ── form fields ─────────────────────────────────────────────── */
const fieldBase =
  "w-full bg-surface border border-line rounded-xl px-3.5 py-2.5 text-[0.95rem] text-content " +
  "placeholder:text-muted/60 focus:outline-none focus:border-[var(--color-primary)] transition-colors";

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <label className={cn("block font-mono text-[0.66rem] tracking-[0.12em] uppercase text-muted mb-1.5", className)}>
      {children}
    </label>
  );
}

export function Field({ label, hint, children }: { label?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-4">
      {label && <Label>{label}</Label>}
      {children}
      {hint && <p className="text-muted text-xs mt-1">{hint}</p>}
    </div>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(fieldBase, className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(fieldBase, "min-h-[90px] resize-y", className)} {...props} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(fieldBase, "appearance-none cursor-pointer pr-9", className)} {...props}>
      {children}
    </select>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2.5"
      role="switch"
      aria-checked={checked}
    >
      <span
        className={cn(
          "w-9 h-5 rounded-full transition-colors relative",
          checked ? "bg-[var(--color-primary)]" : "bg-surface-2 border border-line"
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-paper shadow transition-transform",
            checked && "translate-x-4"
          )}
        />
      </span>
      {label && <span className="text-sm text-content">{label}</span>}
    </button>
  );
}
