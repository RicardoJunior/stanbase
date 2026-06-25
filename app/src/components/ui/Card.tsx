import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "bg-surface border border-line rounded-2xl transition-[transform,box-shadow] duration-300",
        className
      )}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  eyebrow,
  action,
  className,
}: {
  title: ReactNode;
  eyebrow?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-line", className)}>
      <div>
        {eyebrow && <div className="eyebrow text-[0.62rem] mb-1.5">{eyebrow}</div>}
        <h3 className="font-display text-xl leading-tight">{title}</h3>
      </div>
      {action}
    </div>
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-6", className)} {...props} />;
}
