import { useEffect, useRef, useState } from "react";
import { Check, ChevronsUpDown, Search } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * shadcn-style combobox: button → popover with a search box + filtered list +
 * check on the selected item. Also accepts free text (any value), so e.g. any
 * Google Font family works even if not in the suggestion list.
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder = "Selecionar…",
  searchPlaceholder = "Buscar…",
  previewFont = false,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  searchPlaceholder?: string;
  previewFont?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const filtered = options.filter((o) => o.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 80);
  const exact = options.some((o) => o.toLowerCase() === q.trim().toLowerCase());
  const apply = (v: string) => {
    onChange(v);
    setOpen(false);
    setQ("");
  };

  return (
    <div className={cn("relative", className)} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 border border-line rounded-xl px-3 py-2.5 bg-surface hover:border-content/30 transition-colors text-left"
      >
        <span className="truncate text-sm" style={previewFont && value ? { fontFamily: `"${value}", sans-serif` } : undefined}>
          {value || <span className="text-muted">{placeholder}</span>}
        </span>
        <ChevronsUpDown size={15} className="text-muted shrink-0" />
      </button>
      {open && (
        <div className="absolute z-[60] mt-2 w-full min-w-[220px] rounded-2xl border border-line bg-surface shadow-card overflow-hidden">
          <div className="p-2 border-b border-line relative">
            <Search size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && q.trim()) apply(q.trim()); }}
              placeholder={searchPlaceholder}
              className="w-full bg-surface-2 border border-line rounded-lg pl-8 pr-3 py-2 text-sm focus:outline-none focus:border-[var(--color-primary)]"
            />
          </div>
          <div className="max-h-60 overflow-y-auto py-1">
            {q.trim() && !exact && (
              <button onClick={() => apply(q.trim())} className="w-full text-left px-3 py-2 text-sm hover:bg-surface-2 flex items-center gap-2">
                Usar <span className="font-medium">“{q.trim()}”</span>
              </button>
            )}
            {filtered.map((o) => (
              <button
                key={o}
                onClick={() => apply(o)}
                className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-surface-2"
                style={previewFont ? { fontFamily: `"${o}", sans-serif` } : undefined}
              >
                <span className="truncate">{o}</span>
                {o === value && <Check size={14} className="text-[var(--color-primary)] shrink-0" />}
              </button>
            ))}
            {filtered.length === 0 && !q.trim() && <div className="px-3 py-3 text-sm text-muted">Digite para buscar</div>}
          </div>
        </div>
      )}
    </div>
  );
}
