import { cn } from "@/lib/cn";

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-1 border-b border-line overflow-x-auto">
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          className={cn(
            "px-4 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors",
            value === t.value
              ? "border-[var(--color-primary)] text-content"
              : "border-transparent text-muted hover:text-content"
          )}
        >
          {t.label}
          {t.count !== undefined && (
            <span className="ml-1.5 font-mono text-[0.7rem] text-muted">{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
