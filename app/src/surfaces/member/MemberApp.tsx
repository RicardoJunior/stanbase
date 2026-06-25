import { useState, type CSSProperties } from "react";
import { NavLink, Route, Routes, useParams } from "react-router-dom";
import { Moon, Sun, LogOut, CreditCard } from "lucide-react";
import { resolveThemeVars } from "@/lib/theme";
import { memberSession } from "@/lib/session";
import { getProfile } from "@/lib/api";
import { useMemberOrg } from "./useMemberOrg";
import Home from "./pages/Home";
import Checkout from "./pages/Checkout";
import Login from "./pages/Login";
import MemberArea from "./pages/MemberArea";
import Passport from "./pages/Passport";
import Profile from "./pages/Profile";

function Header({ mode, setMode }: { mode: "light" | "dark"; setMode: (m: "light" | "dark") => void }) {
  const { orgSlug } = useParams();
  const { org, member, db } = useMemberOrg();
  if (!org) return null;
  const profile = member ? getProfile(db, member.id) : undefined;

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-bg/85 backdrop-blur">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        <NavLink to={`/m/${orgSlug}`} className="font-display text-xl lowercase" style={{ color: "var(--color-text)" }}>
          <b style={{ color: "var(--color-accent)", fontWeight: 400 }}>{org.logoText}</b>
        </NavLink>
        <nav className="hidden sm:flex items-center gap-7 text-sm">
          <NavLink to={`/m/${orgSlug}`} end className="text-muted hover:text-content transition-colors">Planos</NavLink>
          {member && <NavLink to={`/m/${orgSlug}/app`} className="text-muted hover:text-content transition-colors">Minha área</NavLink>}
          {member && <NavLink to={`/m/${orgSlug}/passport`} className="text-muted hover:text-content transition-colors">Passport</NavLink>}
          {member && <NavLink to={`/m/${orgSlug}/profile`} className="text-muted hover:text-content transition-colors">Perfil</NavLink>}
        </nav>
        <div className="flex items-center gap-3">
          {(org.theme.darkEnabled ?? true) && (
            <button onClick={() => setMode(mode === "dark" ? "light" : "dark")} className="text-muted hover:text-content p-2" aria-label="Alternar tema">
              {mode === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          )}
          {member ? (
            <div className="flex items-center gap-2">
              <NavLink to={`/m/${orgSlug}/app`} className="flex items-center gap-2 text-sm">
                <span className="w-8 h-8 rounded-full flex items-center justify-center font-mono text-xs" style={{ background: "var(--color-surface-2, #2a2820)", border: "1px solid var(--color-border)" }}>
                  {profile?.name?.[0] ?? "?"}
                </span>
                <span className="hidden sm:inline">{profile?.name?.split(" ")[0]}</span>
              </NavLink>
              <button onClick={() => memberSession.set(null)} className="text-muted hover:text-content p-1.5" aria-label="Sair">
                <LogOut size={16} />
              </button>
            </div>
          ) : (
            <NavLink
              to={`/m/${orgSlug}/login`}
              className="rounded-full px-4 py-2 text-sm font-medium"
              style={{ background: "var(--color-primary)", color: "var(--color-primary-contrast)" }}
            >
              Entrar
            </NavLink>
          )}
        </div>
      </div>
    </header>
  );
}

export default function MemberApp() {
  const { org } = useMemberOrg();
  const [override, setOverride] = useState<"light" | "dark" | null>(null);

  if (!org) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg text-content" data-theme="light">
        <div className="text-center">
          <h1 className="font-display text-2xl mb-2">Comunidade não encontrada</h1>
          <p className="text-muted">Confira o endereço da org.</p>
        </div>
      </div>
    );
  }

  const baseMode: "light" | "dark" =
    org.theme.defaultMode === "dark" ? "dark" : org.theme.defaultMode === "light" ? "light" : "dark";
  const mode = override ?? baseMode;
  const themeVars = resolveThemeVars(org.theme, mode) as CSSProperties;

  return (
    <div data-theme={mode} className="min-h-screen bg-bg text-content" style={themeVars}>
      <Header mode={mode} setMode={setOverride} />
      <Routes>
        <Route index element={<Home />} />
        <Route path="checkout/:tierId" element={<Checkout />} />
        <Route path="login" element={<Login />} />
        <Route path="app" element={<MemberArea />} />
        <Route path="passport" element={<Passport />} />
        <Route path="profile" element={<Profile />} />
      </Routes>
      <footer className="border-t border-line mt-20">
        <div className="max-w-6xl mx-auto px-6 py-8 flex flex-wrap items-center justify-between gap-4 text-sm text-muted">
          <span className="flex items-center gap-2">
            <CreditCard size={15} /> {org.name} · membership por <b className="font-display">stanbase</b>
          </span>
          <span className="font-mono text-xs">white-label · tema da org · v0</span>
        </div>
      </footer>
    </div>
  );
}
