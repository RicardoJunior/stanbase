import { useEffect, useRef, useState } from "react";
import { HexColorPicker } from "react-colorful";
import { cn } from "@/lib/cn";

const PRESETS = [
  "#6d28d9", "#b91c1c", "#1d4ed8", "#db2777", "#ea580c", "#0f766e",
  "#b8965a", "#16150f", "#5d584c", "#f5f3ed", "#fffefb", "#15140f",
];

/** Color picker: swatch button → popover with HSV picker + hex + presets. */
export function ColorField({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className={cn("relative", className)} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2.5 w-full border border-line rounded-xl px-2.5 py-2 bg-surface hover:border-content/30 transition-colors"
      >
        <span className="w-7 h-7 rounded-lg border border-line shrink-0" style={{ background: value }} />
        <span className="font-mono text-sm text-content">{value?.toUpperCase()}</span>
      </button>
      {open && (
        <div className="sb-colorpicker absolute z-[60] mt-2 p-3 rounded-2xl border border-line bg-surface shadow-card w-[230px]">
          <HexColorPicker color={value} onChange={onChange} />
          <div className="flex items-center gap-1.5 mt-3">
            <span className="text-muted text-sm font-mono">#</span>
            <input
              value={(value || "").replace("#", "")}
              onChange={(e) => onChange("#" + e.target.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 6))}
              className="flex-1 bg-surface-2 border border-line rounded-lg px-2 py-1.5 font-mono text-sm uppercase focus:outline-none focus:border-[var(--color-primary)]"
              maxLength={6}
            />
          </div>
          <div className="grid grid-cols-6 gap-1.5 mt-3">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => onChange(p)}
                className="w-full aspect-square rounded-md border border-line hover:scale-110 transition-transform"
                style={{ background: p }}
                aria-label={p}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
