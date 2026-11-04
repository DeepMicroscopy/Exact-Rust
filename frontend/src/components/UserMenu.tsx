import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { UserStatisticsDialog } from "./UserStatisticsDialog";

/** The user name in the top bar, with a short drop-down: preferences, own statistics, sign out. */
export function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className="user-menu" ref={box}>
      <button className="btn ghost nowrap" aria-haspopup="menu" aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }} data-testid="user-menu">
        {user?.username}
        <span className="caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="user-pop glass" role="menu">
          <Link to="/preferences" role="menuitem" className="dd-item" onClick={() => setOpen(false)} data-testid="menu-preferences">
            Preferences
          </Link>
          <button role="menuitem" className="dd-item" onClick={() => { setOpen(false); setStats(true); }} data-testid="menu-user-statistics">
            User statistics
          </button>
          <button role="menuitem" className="dd-item" onClick={() => void logout()} data-testid="menu-sign-out">
            Sign out
          </button>
        </div>
      )}
      {stats && <UserStatisticsDialog onClose={() => setStats(false)} />}
    </div>
  );
}
