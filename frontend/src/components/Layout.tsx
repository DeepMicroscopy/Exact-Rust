import { useEffect, useRef, useState } from "react";
import { Link, Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Job } from "../pages/JobsPage";
import { useAuth } from "../auth/AuthContext";
import { Logo } from "./Logo";
import { useAdminMe } from "../pages/AdminPage";
import { SystemHealth } from "./SystemHealth";
import { OPEN_WELCOME } from "./WelcomeDialog";

export function Layout() {
  const { user, logout } = useAuth();
  const [menu, setMenu] = useState(false);
  const nav = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => {
      if (!nav.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.(".nav-toggle")) setMenu(false);
    };
    window.addEventListener("pointerdown", away, true);
    return () => window.removeEventListener("pointerdown", away, true);
  }, [menu]);
  const admin = useAdminMe();
  const jobs = useQuery({ queryKey: ["jobs-active"], queryFn: () => api<{ items: Job[] }>("/api/v2/jobs?status=queued&limit=50"), staleTime: 10_000, refetchInterval: 20_000 });
  const running = useQuery({ queryKey: ["jobs-running"], queryFn: () => api<{ items: Job[] }>("/api/v2/jobs?status=running&limit=50"), staleTime: 10_000, refetchInterval: 20_000 });
  const active = (jobs.data?.items.length ?? 0) + (running.data?.items.length ?? 0);
  const canAdmin = !!admin.data && (admin.data.is_site_admin || admin.data.admin_team_ids.length > 0 || Object.values(admin.data.perms ?? {}).some(Boolean));
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <Logo height={18} />
        </Link>
        <span className="spacer" />
        {admin.data?.is_site_admin && <SystemHealth />}
        <Link to="/jobs" className="btn ghost nowrap">
          Jobs{active > 0 ? ` (${active})` : ""}
        </Link>
        <button className="btn ghost nav-toggle" aria-expanded={menu} aria-label="Menu" onClick={() => setMenu((m) => !m)}>
          ☰
        </button>
        <div ref={nav} className={`topnav ${menu ? "open" : ""}`} onClick={() => setMenu(false)}>
          {canAdmin && (
            <Link to="/admin" className="btn ghost">
              Administration
            </Link>
          )}
          <button className="btn ghost" onClick={() => window.dispatchEvent(new Event(OPEN_WELCOME))} data-testid="whats-new">
            What's new
          </button>
          <span className="muted">{user?.username}</span>
          {user?.read_only && (
            <span className="badge" title="This account can look at everything its teams give it, but cannot change anything" data-testid="read-only-badge">
              read only
            </span>
          )}
          <button className="btn ghost" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
