import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

type Status = "ok" | "warning" | "critical" | "unknown";

interface Check {
  id: string;
  name: string;
  status: Status;
  value: string;
  detail: string;
}

interface Volume {
  name: string;
  path: string;
  total: number;
  free: number;
  used: number;
  status: Status;
}

interface Health {
  status: Status;
  checked_at: string;
  checks: Check[];
  storage: Volume[];
}

const size = (bytes: number) => (bytes >= 1024 ** 4 ? `${(bytes / 1024 ** 4).toFixed(1)} TiB` : bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(bytes / 1024 ** 2)} MiB`);

const SUMMARY: Record<Status, string> = {
  ok: "All checks passed",
  unknown: "All checks passed",
  warning: "Warning: look at the checks marked yellow",
  critical: "Critical: look at the checks marked red",
};

/**
 * The system health of the server, for site admins: an icon in the top bar that carries a dot only while a check is in alarm.
 * Hovering shows the storage (used, free, total), clicking lists every check and its status.
 */
export function SystemHealth() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const health = useQuery({ queryKey: ["system-health"], queryFn: () => api<Health>("/api/v2/health"), refetchInterval: 60_000, staleTime: 30_000, retry: false });
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  const h = health.data;
  if (!h) return null;
  const alarm = h.status === "warning" || h.status === "critical";
  const storage = h.storage.length
    ? h.storage.map((v) => `${v.name}: ${size(v.used)} used, ${size(v.free)} free of ${size(v.total)} (${Math.round((100 * v.used) / Math.max(v.total, 1))} % used)`).join("\n")
    : "Storage cannot be read";
  return (
    <div className="health" ref={box}>
      <button
        className={`btn ghost health-btn ${alarm ? h.status : ""}`}
        aria-label={alarm ? `System health: ${h.status}` : "System health"}
        aria-expanded={open}
        title={storage}
        data-testid="system-health"
        onClick={() => {
          setOpen((o) => !o);
          if (!open) void health.refetch();
        }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 12h4l3-8 4 16 3-8h4" />
        </svg>
        {alarm && <i className="health-dot" />}
      </button>
      {open && (
        <div className="health-pop glass" role="dialog" aria-label="System health" data-testid="system-health-popup">
          <div className={`health-head ${h.status}`}>
            <i className={`dot ${h.status}`} />
            <strong>{SUMMARY[h.status]}</strong>
          </div>
          <ul>
            {h.checks.map((c) => (
              <li key={c.id} data-status={c.status}>
                <i className={`dot ${c.status}`} title={c.status} />
                <span className="name">{c.name}</span>
                <span className="val">{c.value}</span>
                <span className="detail muted small">{c.detail}</span>
              </li>
            ))}
          </ul>
          <div className="muted small">Checked {new Date(h.checked_at).toLocaleTimeString()} · updates every minute</div>
        </div>
      )}
    </div>
  );
}
