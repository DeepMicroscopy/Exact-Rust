import { Link, Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Job } from "../pages/JobsPage";
import { useAuth } from "../auth/AuthContext";
import { Logo } from "./Logo";
import { useAdminMe } from "../pages/AdminPage";

export function Layout() {
  const { user, logout } = useAuth();
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
        <Link to="/jobs" className="btn ghost">
          Jobs{active > 0 ? ` (${active})` : ""}
        </Link>
        {canAdmin && (
          <Link to="/admin" className="btn ghost">
            Administration
          </Link>
        )}
        <span className="muted">{user?.username}</span>
        <button className="btn ghost" onClick={() => void logout()}>
          Sign out
        </button>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
