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

const useCatalog = (enabled = true) => useQuery({ queryKey: ["admin-permission-catalog"], queryFn: () => api<Catalog>("/api/v2/admin/permissions"), staleTime: 300_000, enabled });

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

/**
 * Creates an account: a person (name, e-mail) or a worker (what it does), the teams it belongs to, and whether it may only look. The
 * password is shown once; for a person a link to choose one is offered instead. Everybody who sees the Users tab creates accounts;
 * the kinds of worker (permissions) are for superusers.
 */
export function NewUserDialog({ teams, superuser, onClose, onCreated }: { teams: { id: number; name: string }[]; superuser: boolean; onClose(): void; onCreated(): void }) {
  const catalog = useCatalog(superuser);
  const [kind, setKind] = useState<string>("person");
  const [username, setUsername] = useState("");
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [email, setEmail] = useState("");
  const [readOnly, setReadOnly] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<{ id: number; username: string; password: string; teams: number; read_only: boolean; person: boolean } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const shown = teams.filter((t) => t.name.toLowerCase().includes(filter.trim().toLowerCase())).sort((a, b) => a.name.localeCompare(b.name));
  const person = kind === "person";
  const chosen = catalog.data?.presets.find((p) => p.id === kind);
  const pickKind = (k: string) => {
    setKind(k);
    if (k !== "person" && !username.trim()) setUsername(k === "registration_worker" ? "registration-worker" : "analysis-worker");
  };
  const create = () => {
    setBusy(true);
    setError(null);
    const json: Record<string, unknown> = { username, first_name: first, last_name: last, email, read_only: readOnly, teams: [...picked] };
    if (!person) json.preset = kind;
    api<{ id: number; username: string; password: string; teams: number; read_only: boolean }>("/api/v2/admin/users", { method: "POST", json }).then(
      (r) => {
        setMade({ ...r, person });
        onCreated();
        setBusy(false);
      },
      (e) => {
        setError(msg(e));
        setBusy(false);
      },
    );
  };
  const makeLink = () =>
    api<{ path: string }>(`/api/v2/admin/users/${made!.id}/reset-link`, { method: "POST" }).then(
      (r) => setLink(`${window.location.origin}${r.path}`),
      (e) => setError(msg(e)),
    );
  if (made) {
    const env = `WORKER_USER=${made.username}\nWORKER_PASSWORD=${made.password}`;
    const text = made.person ? made.password : env;
    return (
      <Modal title="Account created" onClose={onClose} className="perm-modal">
        <p>
          The account <strong>{made.username}</strong> exists{made.read_only ? " and is read only (it can look at everything its teams give, and change nothing)" : ""}
          {made.teams ? `; it is a member of ${made.teams} team${made.teams === 1 ? "" : "s"}` : "; it is in no team yet, so it sees no image sets until it is"}.
        </p>
        {made.person ? (
          <input className="mono secret" readOnly value={made.password} onFocus={(e) => e.currentTarget.select()} aria-label="Password" data-testid="new-password" />
        ) : (
          <textarea className="mono secret" readOnly rows={2} value={env} onFocus={(e) => e.currentTarget.select()} aria-label="Account" data-testid="worker-env" />
        )}
        <p className="muted small">
          The password is shown only now and cannot be shown again.
          {made.person ? " Or give the person a link with which they choose their own password:" : " For the worker of the deployment put both lines into deploy/exact.env and restart it; other workers log in with this name and password."}
        </p>
        {made.person && !link && (
          <button className="btn" onClick={() => void makeLink()} data-testid="make-link">
            Create a link to choose a password instead
          </button>
        )}
        {link && <input className="mono secret" readOnly value={link} onFocus={(e) => e.currentTarget.select()} aria-label="Link" data-testid="new-link" />}
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button
            className="btn"
            onClick={() => {
              void navigator.clipboard?.writeText(link ?? text).then(() => setCopied(true));
            }}
          >
            {copied ? "Copied" : link ? "Copy link" : "Copy"}
          </button>
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="New user" onClose={onClose} className="perm-modal">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        {superuser && (
          <label className="field">
            <span>Account for</span>
            <select value={kind} onChange={(e) => pickKind(e.target.value)} aria-label="Kind of account">
              <option value="person">A person</option>
              {catalog.data?.presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {chosen && (
          <p className="muted small" data-testid="preset-info">
            {chosen.description} <br />
            Permissions: {chosen.permissions.join(", ")}.
          </p>
        )}
        <label className="field">
          <span>User name</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} aria-label="User name" maxLength={150} />
        </label>
        {person && (
          <>
            <div className="params">
              <label className="field">
                <span>First name</span>
                <input value={first} onChange={(e) => setFirst(e.target.value)} aria-label="First name" maxLength={150} />
              </label>
              <label className="field">
                <span>Last name</span>
                <input value={last} onChange={(e) => setLast(e.target.value)} aria-label="Last name" maxLength={150} />
              </label>
            </div>
            <label className="field">
              <span>Email (optional)</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" maxLength={254} />
            </label>
          </>
        )}
        <label className="perm-row" title="A read-only account sees what its teams give it and cannot create, change or delete anything, whichever way it signs in">
          <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} aria-label="Read only" />
          <span>
            <strong>Read only</strong>: may look at everything its teams give it, but change nothing (a reviewer, a guest)
          </span>
        </label>
        <div className="field">
          <span>
            Teams ({picked.size} chosen){!person ? ". A worker is offered jobs for images of its own teams only." : ". The account sees the image sets of its teams."}
          </span>
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
