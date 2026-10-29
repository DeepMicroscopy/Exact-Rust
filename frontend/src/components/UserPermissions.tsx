import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { Modal } from "./Modal";

const msg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

interface Catalog {
  permissions: { key: string; app: string; model: string; codename: string; name: string }[];
  presets: { id: string; label: string; description: string; permissions: string[] }[];
}
interface PermState {
  id: number;
  username: string;
  is_superuser: boolean;
  direct: string[];
  groups: { name: string; permissions: string[] }[];
}

const useCatalog = () => useQuery({ queryKey: ["admin-permission-catalog"], queryFn: () => api<Catalog>("/api/v2/admin/permissions"), staleTime: 300_000 });

/** The permissions of a user, by model, with the presets for service accounts on top. Superusers only (the server checks). */
export function PermissionsDialog({ userId, username, onClose, onSaved }: { userId: number; username: string; onClose(): void; onSaved(): void }) {
  const catalog = useCatalog();
  const state = useQuery({ queryKey: ["admin-user-permissions", userId], queryFn: () => api<PermState>(`/api/v2/admin/users/${userId}/permissions`), staleTime: 0, gcTime: 0 }); // not kept: a reopened dialog must not show the state from before the last save
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const current = chosen ?? new Set(state.data?.direct ?? []);
  const viaGroups = new Set((state.data?.groups ?? []).flatMap((g) => g.permissions));
  const byModel = useMemo(() => {
    const m = new Map<string, Catalog["permissions"]>();
    for (const p of catalog.data?.permissions ?? []) m.set(`${p.app} / ${p.model}`, [...(m.get(`${p.app} / ${p.model}`) ?? []), p]);
    return [...m.entries()];
  }, [catalog.data]);
  const toggle = (key: string, on: boolean) => {
    const next = new Set(current);
    if (on) next.add(key);
    else next.delete(key);
    setChosen(next);
  };
  const save = () => {
    setBusy(true);
    api(`/api/v2/admin/users/${userId}/permissions`, { method: "PUT", json: { permissions: [...current] } }).then(
      () => {
        onSaved();
        onClose();
      },
      (e) => {
        setError(msg(e));
        setBusy(false);
      },
    );
  };
  return (
    <Modal title={`Permissions of ${username}`} onClose={onClose} className="perm-modal">
      {!catalog.data || !state.data ? (
        <p className="muted">{catalog.error || state.error ? msg(catalog.error ?? state.error) : "Loading…"}</p>
      ) : (
        <>
          <p className="muted small">What the account may change beyond what its teams give it. Reading images and annotations needs no permission here.</p>
          <div className="presets" data-testid="presets">
            {catalog.data.presets.map((p) => (
              <div key={p.id} className="preset">
                <div>
                  <strong>{p.label}</strong>
                  <div className="muted small">{p.description}</div>
                </div>
                <button className="btn" onClick={() => setChosen(new Set(p.permissions))}>
                  Use
                </button>
              </div>
            ))}
            <div className="preset">
              <div>
                <strong>No permissions</strong>
                <div className="muted small">An ordinary account.</div>
              </div>
              <button className="btn" onClick={() => setChosen(new Set())}>
                Use
              </button>
            </div>
          </div>
          {state.data.groups.length > 0 && (
            <p className="muted small" data-testid="groups">
              Also through groups (not changed here): {state.data.groups.map((g) => `${g.name} (${g.permissions.length})`).join(", ")}
            </p>
          )}
          <div className="perm-list" data-testid="permissions">
            {byModel.map(([model, items]) => (
              <details key={model} open={items.some((p) => current.has(p.key))}>
                <summary>
                  {model} <span className="muted small">{items.filter((p) => current.has(p.key)).length || ""}</span>
                </summary>
                {items.map((p) => (
                  <label key={p.key} className="perm-row" title={p.key}>
                    <input type="checkbox" checked={current.has(p.key)} onChange={(e) => toggle(p.key, e.target.checked)} data-key={p.key} />
                    {p.name}
                    {viaGroups.has(p.key) && <span className="muted small"> · also from a group</span>}
                  </label>
                ))}
              </details>
            ))}
          </div>
          {error && <p className="error">{error}</p>}
          <div className="modal-actions">
            <span className="muted small spacer-left">{current.size} selected</span>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" onClick={save} disabled={busy || chosen === null}>
              Save
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

/** Creates a service account (a worker): name, what it is for, the teams whose images it serves; the password is shown once. */
export function NewWorkerDialog({ teams, onClose, onCreated }: { teams: { id: number; name: string }[]; onClose(): void; onCreated(): void }) {
  const catalog = useCatalog();
  const [username, setUsername] = useState("registration-worker");
  const [preset, setPreset] = useState<string>("registration_worker");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ username: string; password: string; teams: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const shown = teams.filter((t) => t.name.toLowerCase().includes(filter.trim().toLowerCase())).sort((a, b) => a.name.localeCompare(b.name));
  const chosen = catalog.data?.presets.find((p) => p.id === preset);
  const create = () => {
    setBusy(true);
    setError(null);
    api<{ username: string; password: string; teams: number }>("/api/v2/admin/users", { method: "POST", json: { username, preset: preset || undefined, teams: [...picked] } }).then(
      (r) => {
        setMade(r);
        onCreated();
        setBusy(false);
      },
      (e) => {
        setError(msg(e));
        setBusy(false);
      },
    );
  };
  if (made) {
    const env = `WORKER_USER=${made.username}\nWORKER_PASSWORD=${made.password}`;
    return (
      <Modal title="Worker account created" onClose={onClose} className="perm-modal">
        <p>
          The account <strong>{made.username}</strong> exists{made.teams ? ` and is a member of ${made.teams} team${made.teams === 1 ? "" : "s"}` : ", but is in no team yet: it will not be offered any jobs until it is"}.
        </p>
        <textarea className="mono secret" readOnly rows={2} value={env} onFocus={(e) => e.currentTarget.select()} aria-label="Account" data-testid="worker-env" />
        <p className="muted small">
          The password is shown only now and cannot be shown again. For the worker of the deployment put both lines into <code>deploy/exact.env</code> and restart it (<code>docker compose … up -d worker</code>); other workers log in with this name and password.
        </p>
        <div className="modal-actions">
          <button
            className="btn"
            onClick={() => {
              void navigator.clipboard?.writeText(env).then(() => setCopied(true));
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="New worker account" onClose={onClose} className="perm-modal">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <label className="field">
          <span>User name</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} aria-label="User name" maxLength={150} />
        </label>
        <label className="field">
          <span>What the worker does</span>
          <select value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Kind of worker">
            {catalog.data?.presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value="">Nothing yet (set the permissions afterwards)</option>
          </select>
        </label>
        {chosen && (
          <p className="muted small" data-testid="preset-info">
            {chosen.description} <br />
            Permissions: {chosen.permissions.join(", ")}.
          </p>
        )}
        <div className="field">
          <span>Teams whose images it serves ({picked.size} chosen). A worker is offered jobs for images of its own teams only.</span>
          <div className="row-inline">
            <input placeholder="Filter teams…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter teams" />
            <button type="button" className="btn ghost small" onClick={() => setPicked(new Set([...picked, ...shown.map((t) => t.id)]))}>
              Choose all shown
            </button>
            <button type="button" className="btn ghost small" onClick={() => setPicked(new Set())}>
              None
            </button>
          </div>
          <div className="team-pick" data-testid="team-pick">
            {shown.map((t) => (
              <label key={t.id} className="perm-row">
                <input
                  type="checkbox"
                  checked={picked.has(t.id)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(t.id);
                    else next.delete(t.id);
                    setPicked(next);
                  }}
                />
                {t.name}
              </label>
            ))}
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !username.trim()}>
            Create account
          </button>
        </div>
      </form>
    </Modal>
  );
}
