import { useMemo, useState, type CSSProperties } from "react";
import {
  Plus, ChevronUp, ChevronDown, Pencil, Trash2, GripVertical, RotateCcw, ExternalLink, Eye,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useStore } from "@/lib/store";
import { getLanding, updateOrgLanding, resetOrgLanding } from "@/lib/api";
import { BLOCK_DEFS, blockDef, newBlock, type FieldDef } from "@/lib/blocks";
import { resolveThemeVars } from "@/lib/theme";
import { SectionHead, Button, Dialog, Field, Input, Textarea, Select, Switch, Label, Badge } from "@/components/ui";
import { BlockRenderer, type BlockCtx } from "@/surfaces/member/blocks/BlockRenderer";
import { useAdminOrg } from "../useAdminOrg";
import type { LandingBlock } from "@/types/domain";

export default function PageBuilder() {
  const { org, orgId } = useAdminOrg();
  const db = useStore((d) => d);
  const published = useMemo(() => (org ? getLanding(db, org) : []), [db, org]);
  const [draft, setDraft] = useState<LandingBlock[]>(() => structuredClone(published));
  const [editing, setEditing] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mode, setMode] = useState<"light" | "dark">(org?.theme.defaultMode === "light" ? "light" : "dark");

  if (!org || !orgId) return null;

  const dirty = JSON.stringify(draft) !== JSON.stringify(published);
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= draft.length) return;
    const next = [...draft];
    [next[i], next[j]] = [next[j], next[i]];
    setDraft(next);
  };
  const remove = (id: string) => setDraft((d) => d.filter((b) => b.id !== id));
  const add = (type: string) => {
    setDraft((d) => [...d, newBlock(type)]);
    setPaletteOpen(false);
  };
  const updateContent = (id: string, content: Record<string, any>) =>
    setDraft((d) => d.map((b) => (b.id === id ? { ...b, content } : b)));

  const themeVars = resolveThemeVars(org.theme, mode) as CSSProperties;
  const ctx: BlockCtx = { org, db, orgSlug: org.slug, preview: true };
  const editingBlock = draft.find((b) => b.id === editing) ?? null;

  return (
    <div>
      <SectionHead
        eyebrow="White-label · página do membro"
        title="Construtor da página"
        desc="Monte a landing que o seu fã vê: arraste blocos, edite textos e imagens. Modelos curados para manter o nível."
        action={
          <Link to={`/m/${org.slug}`} target="_blank">
            <Button variant="ghost" size="sm"><ExternalLink size={15} /> Ver publicada</Button>
          </Link>
        }
      />

      <div className="grid lg:grid-cols-[380px_1fr] gap-6">
        {/* ── controls ── */}
        <div>
          <div className="flex gap-2 mb-4">
            <Button size="sm" disabled={!dirty} onClick={() => updateOrgLanding(orgId, draft)}>Publicar</Button>
            {dirty && <Button size="sm" variant="ghost" onClick={() => setDraft(structuredClone(published))}>Descartar</Button>}
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => { if (confirm("Resetar a página para o modelo padrão?")) { resetOrgLanding(orgId); setDraft(structuredClone(getLanding(db, org))); } }}>
              <RotateCcw size={13} /> Resetar
            </Button>
          </div>

          <Button variant="subtle" className="w-full mb-3" onClick={() => setPaletteOpen(true)}>
            <Plus size={15} /> Adicionar bloco
          </Button>

          <div className="space-y-1.5">
            {draft.map((b, i) => {
              const def = blockDef(b.type);
              return (
                <div key={b.id} className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 bg-surface ${editing === b.id ? "border-[var(--color-primary)]" : "border-line"}`}>
                  <GripVertical size={14} className="text-muted/50 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{def?.label ?? b.type}</div>
                    <div className="text-[0.65rem] text-muted truncate">{blockSummary(b)}</div>
                  </div>
                  <div className="flex items-center">
                    <button onClick={() => move(i, -1)} disabled={i === 0} className="p-1.5 rounded hover:bg-surface-2 disabled:opacity-25"><ChevronUp size={14} /></button>
                    <button onClick={() => move(i, 1)} disabled={i === draft.length - 1} className="p-1.5 rounded hover:bg-surface-2 disabled:opacity-25"><ChevronDown size={14} /></button>
                    <button onClick={() => setEditing(b.id)} className="p-1.5 rounded hover:bg-surface-2"><Pencil size={13} /></button>
                    <button onClick={() => remove(b.id)} className="p-1.5 rounded hover:bg-surface-2 text-muted hover:text-danger"><Trash2 size={13} /></button>
                  </div>
                </div>
              );
            })}
            {draft.length === 0 && <p className="text-muted text-sm text-center py-8">Página vazia. Adicione blocos acima.</p>}
          </div>
          <p className="text-xs text-muted mt-4">Para imagens, cole a URL no editor do bloco.</p>
        </div>

        {/* ── live preview ── */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <Label>Preview ao vivo</Label>
            <div className="flex gap-1 text-xs">
              <button onClick={() => setMode("light")} className={`px-2.5 py-1 rounded-lg ${mode === "light" ? "bg-surface-2 border border-line" : "text-muted"}`}>claro</button>
              <button onClick={() => setMode("dark")} className={`px-2.5 py-1 rounded-lg ${mode === "dark" ? "bg-surface-2 border border-line" : "text-muted"}`}>escuro</button>
            </div>
          </div>
          <div className="rounded-2xl border border-line overflow-hidden">
            <div className="flex items-center gap-2 px-4 h-9 border-b border-line bg-surface-2/40">
              <Eye size={13} className="text-muted" />
              <span className="font-mono text-[0.62rem] text-muted">/m/{org.slug}</span>
            </div>
            <div data-theme={mode} className="overflow-y-auto" style={{ ...themeVars, background: "var(--color-bg)", color: "var(--color-text)", height: "calc(100vh - 230px)" }}>
              {draft.map((block) => <BlockRenderer key={block.id} block={block} ctx={ctx} />)}
              {draft.length === 0 && <div className="p-16 text-center text-muted">Sem blocos.</div>}
            </div>
          </div>
        </div>
      </div>

      {paletteOpen && <Palette onAdd={add} onClose={() => setPaletteOpen(false)} />}
      {editingBlock && (
        <BlockEditor
          block={editingBlock}
          onChange={(content) => updateContent(editingBlock.id, content)}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function blockSummary(b: LandingBlock): string {
  const c = b.content as Record<string, any>;
  return c.title || c.heading || c.eyebrow || (c.items ? `${c.items.length} itens` : "") || blockDef(b.type)?.description || "";
}

const GROUPS = ["abertura", "conteúdo", "prova", "conversão"] as const;
function Palette({ onAdd, onClose }: { onAdd: (type: string) => void; onClose: () => void }) {
  return (
    <Dialog open onClose={onClose} eyebrow="Catálogo de blocos" title="Adicionar bloco" size="lg">
      {GROUPS.map((g) => (
        <div key={g} className="mb-5 last:mb-0">
          <div className="font-mono text-[0.6rem] uppercase tracking-[0.16em] text-muted mb-2">{g}</div>
          <div className="grid sm:grid-cols-2 gap-2">
            {BLOCK_DEFS.filter((b) => b.group === g).map((b) => (
              <button key={b.type} onClick={() => onAdd(b.type)} className="text-left rounded-xl border border-line hover:border-[var(--color-primary)] p-3 transition-colors">
                <div className="text-sm font-medium flex items-center gap-2">{b.label}{b.singleton && <Badge tone="neutral">único</Badge>}</div>
                <div className="text-xs text-muted">{b.description}</div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </Dialog>
  );
}

function BlockEditor({ block, onChange, onClose }: { block: LandingBlock; onChange: (content: Record<string, any>) => void; onClose: () => void }) {
  const def = blockDef(block.type)!;
  const c = block.content as Record<string, any>;
  const setField = (key: string, value: any) => onChange({ ...c, [key]: value });

  return (
    <Dialog open onClose={onClose} eyebrow={`Bloco · ${def.label}`} title="Editar bloco" footer={<Button onClick={onClose}>Concluir</Button>}>
      {def.fields.map((f) => (
        <FieldEditor key={f.key} field={f} value={c[f.key]} onChange={(v) => setField(f.key, v)} />
      ))}
    </Dialog>
  );
}

function FieldEditor({ field, value, onChange }: { field: FieldDef; value: any; onChange: (v: any) => void }) {
  if (field.type === "list") return <ListEditor field={field} value={value ?? []} onChange={onChange} />;
  if (field.type === "switch") {
    return (
      <div className="mb-4 flex items-center justify-between">
        <Label>{field.label}</Label>
        <Switch checked={!!value} onChange={onChange} />
      </div>
    );
  }
  if (field.type === "select") {
    return (
      <Field label={field.label}>
        <Select value={value ?? field.options?.[0]} onChange={(e) => onChange(e.target.value)}>
          {field.options?.map((o) => <option key={o} value={o}>{o}</option>)}
        </Select>
      </Field>
    );
  }
  if (field.type === "textarea") {
    return <Field label={field.label}><Textarea value={value ?? ""} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} /></Field>;
  }
  // text / url / image → text input (+ image preview)
  return (
    <Field label={field.label} hint={field.type === "image" ? "Cole a URL de uma imagem" : undefined}>
      <Input value={value ?? ""} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder ?? (field.type === "url" ? "https://…" : "")} />
      {field.type === "image" && value ? <img src={value} alt="" className="mt-2 rounded-lg max-h-28 border border-line" /> : null}
    </Field>
  );
}

function ListEditor({ field, value, onChange }: { field: FieldDef; value: any[]; onChange: (v: any[]) => void }) {
  const items = value ?? [];
  const update = (i: number, patch: Record<string, any>) => onChange(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const remove = (i: number) => onChange(items.filter((_, j) => j !== i));
  const addItem = () => {
    const blank: Record<string, any> = {};
    field.itemFields?.forEach((f) => (blank[f.key] = ""));
    onChange([...items, blank]);
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="mb-4">
      <Label>{field.label}</Label>
      <div className="space-y-2 mt-1">
        {items.map((it, i) => (
          <div key={i} className="rounded-xl border border-line p-3 bg-surface-2/40">
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono text-[0.6rem] uppercase tracking-wide text-muted">{field.itemLabel ?? "item"} {i + 1}</span>
              <div className="flex items-center">
                <button onClick={() => move(i, -1)} disabled={i === 0} className="p-1 rounded hover:bg-surface-2 disabled:opacity-25"><ChevronUp size={13} /></button>
                <button onClick={() => move(i, 1)} disabled={i === items.length - 1} className="p-1 rounded hover:bg-surface-2 disabled:opacity-25"><ChevronDown size={13} /></button>
                <button onClick={() => remove(i)} className="p-1 rounded hover:bg-surface-2 text-muted hover:text-danger"><Trash2 size={13} /></button>
              </div>
            </div>
            {field.itemFields?.map((f) => (
              <FieldEditor key={f.key} field={f} value={it[f.key]} onChange={(v) => update(i, { [f.key]: v })} />
            ))}
          </div>
        ))}
      </div>
      <Button size="sm" variant="ghost" className="mt-2" onClick={addItem}><Plus size={13} /> Adicionar {field.itemLabel ?? "item"}</Button>
    </div>
  );
}
