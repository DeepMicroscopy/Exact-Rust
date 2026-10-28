import { Link, Outlet } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { Logo } from "./Logo";
import { useAdminMe } from "../pages/AdminPage";

export function Layout() {
  const { user, logout } = useAuth();
  const admin = useAdminMe();
  const canAdmin = !!admin.data && (admin.data.is_site_admin || admin.data.admin_team_ids.length > 0);
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <Logo height={18} />
        </Link>
        <span className="spacer" />
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
