import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "gold" | "ghost" | "subtle" | "danger";
type Size = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const base =
  "inline-flex items-center justify-center gap-2 rounded-full font-body font-medium " +
  "transition-[transform,box-shadow,background,color,border-color] duration-200 " +
  "disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap select-none";

const variants: Record<Variant, string> = {
  primary:
    "bg-[var(--color-primary)] text-[var(--color-primary-contrast)] border border-transparent hover:-translate-y-0.5 hover:shadow-[0_12px_30px_-10px_rgba(22,21,15,.45)]",
  gold: "bg-gold text-obsidian border border-transparent hover:-translate-y-0.5 hover:shadow-[0_12px_30px_-10px_rgba(184,150,90,.5)]",
  ghost: "bg-transparent text-content border border-line hover:border-content",
  subtle: "bg-surface-2 text-content border border-line hover:border-content/40",
  danger: "bg-danger text-white border border-transparent hover:-translate-y-0.5",
};

const sizes: Record<Size, string> = {
  sm: "text-[0.82rem] px-3.5 py-1.5",
  md: "text-[0.92rem] px-5 py-2.5",
  lg: "text-base px-7 py-3",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", className, ...props }, ref) => (
    <button ref={ref} className={cn(base, variants[variant], sizes[size], className)} {...props} />
  )
);
Button.displayName = "Button";
