import { NavLink, Route, Routes, useNavigate } from "react-router-dom";
import {
  LayoutDashboard, Users, Layers, Receipt, CalendarDays, FileLock2, MessagesSquare,
  Send, Trophy, Sparkles, Plug, ScanLine, Code2, Settings, ChevronDown, ExternalLink, RotateCcw,
} from "lucide-react";
import { useState } from "react";
import { useAdminOrg } from "./useAdminOrg";
import { resetDemo } from "@/lib/store";
import Dashboard from "./pages/Dashboard";
import Members from "./pages/Members";
import MemberDetail from "./pages/MemberDetail";
import Tiers from "./pages/Tiers";
import Revenue from "./pages/Revenue";
import Events from "./pages/Events";
import Validation from "./pages/Validation";
import SettingsPage from "./pages/Settings";
import Placeholder from "./pages/Placeholder";

const NAV = [
  { to: "/admin", icon: LayoutDashboard, label: "Dashboard", end: true },
  { to: "/admin/members", icon: Users, label: "Membros / CRM" },
  { to: "/admin/tiers", icon: Layers, label: "Tiers & Perks" },
  { to: "/admin/revenue", icon: Receipt, label: "Receita & Pagamentos" },
  { to: "/admin/events", icon: CalendarDays, label: "Eventos & Ingressos" },
  { to: "/admin/validation", icon: ScanLine, label: "Validação & Portaria" },
  { to: "/admin/content", icon: FileLock2, label: "Conteúdo", soon: true },
  { to: "/admin/community", icon: MessagesSquare, label: "Comunidade & Canais", soon: true },
  { to: "/admin/communication", icon: Send, label: "Comunicação", soon: true },
  { to: "/admin/hall", icon: Trophy, label: "Hall of Fame", soon: true },
  { to: "/admin/ai", icon: Sparkles, label: "IA", soon: true },
  { to: "/admin/integrations", icon: Plug, label: "Integrações", soon: true },
  { to: "/admin/developers", icon: Code2, label: "Desenvolvedores", soon: true },
  { to: "/admin/settings", icon: Settings, label: "Configurações" },
];

function OrgSelector() {
  const { org, orgs, setOrg } = useAdminOrg();
  const [open, setOpen] = useState(false);
  if (!org) return null;
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2.5 px-3 py-2 rounded-xl border border-line hover:border-content/30 transition-colors"
      >
        <span
          className="w-7 h-7 rounded-lg flex items-center justify-center font-display text-sm"
          style={{ background: org.theme.primary ?? "#16150f", color: "#fffefb" }}
        >
          {org.name[0]}
        </span>
        <span className="text-left">
          <span className="block text-sm font-medium leading-tight">{org.name}</span>
          <span className="block font-mono text-[0.6rem] text-muted uppercase tracking-wide">{org.vertical}</span>
        </span>
        <ChevronDown size={15} className="text-muted" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-1.5 w-64 bg-surface border border-line rounded-xl shadow-card z-20 p-1.5">
            <div className="font-mono text-[0.6rem] uppercase tracking-wide text-muted px-3 py-2">
              Suas bases (orgs)
            </div>
            {orgs.map((o) => (
              <button
                key={o.id}
                onClick={() => {
                  setOrg(o.id);
                  setOpen(false);
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-surface-2 text-left text-sm"
              >
                <span
                  className="w-6 h-6 rounded-md flex items-center justify-center font-display text-xs"
                  style={{ background: o.theme.primary ?? "#16150f", color: "#fffefb" }}
                >
                  {o.name[0]}
                </span>
                {o.name}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Sidebar() {
  return (
    <aside className="w-[248px] shrink-0 border-r border-line bg-surface/60 h-screen sticky top-0 flex flex-col">
      <div className="px-5 h-[68px] flex items-center border-b border-line">
        <NavLink to="/" className="brand-logo text-[1.4rem]">
          stan<b>base</b>
        </NavLink>
        <span className="ml-2 font-mono text-[0.55rem] uppercase tracking-[0.18em] text-muted border border-line rounded px-1.5 py-0.5">
          admin
        </span>
      </div>
      <nav className="flex-1 overflow-y-auto py-3 px-2.5">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-lg text-[0.9rem] mb-0.5 transition-colors ${
                isActive ? "bg-surface-2 text-content font-medium" : "text-muted hover:text-content hover:bg-surface-2/60"
              }`
            }
          >
            <n.icon size={17} className="shrink-0" />
            <span className="flex-1">{n.label}</span>
            {n.soon && (
              <span className="font-mono text-[0.5rem] uppercase tracking-wide text-gold-deep/70 border border-gold/30 rounded px-1">
                v1
              </span>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="p-3 border-t border-line">
        <button
          onClick={() => {
            if (confirm("Resetar a demo para os dados de fábrica?")) resetDemo();
          }}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[0.82rem] text-muted hover:text-content hover:bg-surface-2 transition-colors"
        >
          <RotateCcw size={14} /> Resetar demo
        </button>
      </div>
    </aside>
  );
}

function Header() {
  const { org } = useAdminOrg();
  const navigate = useNavigate();
  return (
    <header className="h-[68px] border-b border-line flex items-center justify-between px-7 sticky top-0 bg-bg/85 backdrop-blur z-30">
      <OrgSelector />
      <div className="flex items-center gap-3">
        {org && (
          <button
            onClick={() => navigate(`/m/${org.slug}`)}
            className="flex items-center gap-1.5 text-sm text-muted hover:text-content transition-colors"
          >
            <ExternalLink size={14} /> Ver área de membro
          </button>
        )}
        <div className="w-px h-6 bg-line" />
        <div className="flex items-center gap-2.5">
          <span className="w-8 h-8 rounded-full bg-surface-2 border border-line flex items-center justify-center font-mono text-xs text-muted">
            RJ
          </span>
          <div className="leading-tight">
            <div className="text-sm font-medium">Ricardo Júnior</div>
            <div className="font-mono text-[0.58rem] uppercase tracking-wide text-muted">owner</div>
          </div>
        </div>
      </div>
    </header>
  );
}

export default function AdminApp() {
  const { org } = useAdminOrg();
  if (!org) return <div className="p-10">Nenhuma org. Vá ao superadmin.</div>;
  return (
    <div className="min-h-screen bg-bg text-content flex" data-theme="light">
      <Sidebar />
      <div className="flex-1 min-w-0 flex flex-col">
        <Header />
        <main className="flex-1 px-7 py-7 max-w-[1280px] w-full mx-auto">
          <Routes>
            <Route index element={<Dashboard />} />
            <Route path="members" element={<Members />} />
            <Route path="members/:id" element={<MemberDetail />} />
            <Route path="tiers" element={<Tiers />} />
            <Route path="revenue" element={<Revenue />} />
            <Route path="events" element={<Events />} />
            <Route path="validation" element={<Validation />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="content" element={<Placeholder module="Conteúdo exclusivo" />} />
            <Route path="community" element={<Placeholder module="Comunidade & Canais" />} />
            <Route path="communication" element={<Placeholder module="Comunicação & Campanhas" />} />
            <Route path="hall" element={<Placeholder module="Hall of Fame" />} />
            <Route path="ai" element={<Placeholder module="Camada de IA" />} />
            <Route path="integrations" element={<Placeholder module="Integrações" />} />
            <Route path="developers" element={<Placeholder module="Desenvolvedores (API/Webhooks/MCP)" />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
