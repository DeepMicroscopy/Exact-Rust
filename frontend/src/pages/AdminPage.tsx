import { useMemo, useState } from "react";
import { SearchInput } from "../components/SearchInput";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, listAll } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { LogTab } from "../components/LogAdmin";
import { PluginsTab } from "../components/PluginsAdmin";
import { ProductsTab, type ProductPerms } from "../components/ProductsAdmin";
import { Modal } from "../components/Modal";
import { SecretDialog } from "../components/SecretDialog";
import { NewUserDialog, PermissionsDialog } from "../components/UserPermissions";

export interface AdminMe {
  is_site_admin: boolean;
  is_staff: boolean;
  is_superuser: boolean;
  admin_team_ids: number[];
  perms?: ProductPerms;
}
interface TeamRow {
  id: number;
  name: string;
}
interface Member {
  id: number;
  username: string;
  is_active: boolean;
}
interface Membership {
  id: number;
  user: number;
  team: number;
  is_admin: boolean;
}
interface UserRow {
  id: number;
  username: string;
  is_active: boolean;
  is_staff: boolean;
  is_superuser: boolean;
  last_login: string | null;
  team_set: number[];
}
interface Invitation {
  id: number;
  purpose: string;
  status: string;
  email: string;
  team_ids: number[];
  note: string;
  created_at: string;
  expires_at: string;
}

const msg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

export function useAdminMe() {
  return useQuery({ queryKey: ["admin-me"], queryFn: () => api<AdminMe>("/api/v2/admin/me"), staleTime: 60_000 });
}

/** Administration: the teams one administers (members, invitations) and, for site admins, all users. */
export function AdminPage() {
  const me = useAdminMe();
  const [tab, setTab] = useState<"teams" | "users" | "products" | "plugins" | "log">("teams");
  if (me.isLoading) return <p className="muted">Loading…</p>;
  const site = !!me.data?.is_site_admin;
  const mine = me.data?.admin_team_ids ?? [];
  const perms = me.data?.perms ?? {};
  const products = Object.values(perms).some(Boolean);
  if (!me.data || (!site && mine.length === 0 && !products)) return <p className="muted">You do not administer a team.</p>;
  return (
    <section className="main admin">
      <div className="toolbar">
        <h2>Administration</h2>
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "teams"} className={tab === "teams" ? "active" : ""} onClick={() => setTab("teams")}>
          Teams
        </button>
        {products && (
          <button role="tab" aria-selected={tab === "products"} className={tab === "products" ? "active" : ""} onClick={() => setTab("products")}>
            Products
          </button>
        )}
        {site && (
          <button role="tab" aria-selected={tab === "plugins"} className={tab === "plugins" ? "active" : ""} onClick={() => setTab("plugins")}>
            Plugins
          </button>
        )}
        {site && (
          <button role="tab" aria-selected={tab === "log"} className={tab === "log" ? "active" : ""} onClick={() => setTab("log")} data-testid="tab-log">
            Log
          </button>
        )}
        {site && (
          <button role="tab" aria-selected={tab === "users"} className={tab === "users" ? "active" : ""} onClick={() => setTab("users")}>
            Users
          </button>
        )}
      </div>
      {tab === "teams" ? <TeamsTab me={me.data} /> : tab === "products" ? <ProductsTab perms={perms} /> : tab === "plugins" ? <PluginsTab /> : tab === "log" ? <LogTab /> : <UsersTab me={me.data} />}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ teams

function TeamsTab({ me }: { me: AdminMe }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const teams = useQuery({ queryKey: ["admin-teams"], queryFn: () => listAll<TeamRow>("/api/v2/teams", { fields: "id,name" }), staleTime: 0 });
  const [picked, setPicked] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const current = picked ?? teams.data?.[0]?.id ?? null;
  const can = (id: number) => me.is_site_admin || me.admin_team_ids.includes(id);
  return (
    <div className="two-col">
      <aside className="sidebar">
        <div className="sidebar-title">Teams</div>
        {(teams.data ?? []).map((t) => (
          <button key={t.id} className={`side-item ${current === t.id ? "active" : ""}`} onClick={() => setPicked(t.id)}>
            {t.name}
          </button>
        ))}
        <button className="btn small" onClick={() => setCreating(true)} style={{ marginTop: 8 }}>
          New team…
        </button>
      </aside>
      <div className="admin-main">
        {current != null && teams.data?.some((t) => t.id === current) ? (
          <TeamPanel key={current} teamId={current} name={teams.data.find((t) => t.id === current)?.name ?? ""} manage={can(current)} me={me} selfId={user?.id ?? 0} onGone={() => setPicked(null)} />
        ) : (
          <p className="muted">No team.</p>
        )}
      </div>
      {creating && (
        <NameDialog
          title="New team"
          label="Team name"
          onClose={() => setCreating(false)}
          onSave={async (name) => {
            const t = await api<{ id: number }>("/api/v2/teams", { json: { name } });
            await qc.invalidateQueries({ queryKey: ["admin-teams"] });
            await qc.invalidateQueries({ queryKey: ["admin-me"] });
            setPicked(t.id);
          }}
        />
      )}
    </div>
  );
}

function NameDialog({ title, label, initial = "", onSave, onClose }: { title: string; label: string; initial?: string; onSave(name: string): Promise<void>; onClose(): void }) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          onSave(name.trim()).then(onClose, (err) => {
            setError(msg(err));
            setBusy(false);
          });
        }}
      >
        <label className="field">
          <span>{label}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label={label} autoFocus />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TeamPanel({ teamId, name, manage, me, selfId, onGone }: { teamId: number; name: string; manage: boolean; me: AdminMe; selfId: number; onGone(): void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [secret, setSecret] = useState<{ title: string; intro: string; value: string } | null>(null);
  const members = useQuery({
    queryKey: ["admin-team", teamId],
    staleTime: 0,
    queryFn: async () => {
      const t = await api<{ members: Member[] }>(`/api/v2/teams/${teamId}?fields=id,members&expand=members`);
      const ms = await listAll<Membership>("/api/v2/team-memberships", { team: teamId });
      const admin = new Map(ms.map((m) => [m.user, m.is_admin]));
      return t.members.map((m) => ({ ...m, is_admin: admin.get(m.id) ?? false })).sort((a, b) => a.username.localeCompare(b.username));
    },
  });
  const invitations = useQuery({ queryKey: ["admin-invitations"], queryFn: () => api<Invitation[]>("/api/v2/invitations"), staleTime: 0, enabled: manage });
  const allUsers = useQuery({ queryKey: ["admin-users"], queryFn: () => listAll<UserRow>("/api/v2/users", { fields: "id,username,is_active,is_staff,is_superuser,last_login,team_set" }), enabled: manage && me.is_site_admin, staleTime: 0 });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["admin-team", teamId] });
    void qc.invalidateQueries({ queryKey: ["admin-invitations"] });
    void qc.invalidateQueries({ queryKey: ["admin-users"] });
  };
  const run = (fn: () => Promise<unknown>) =>
    void fn().then(
      () => {
        setError(null);
        refresh();
      },
      (e) => setError(msg(e)),
    );
  const memberIds = new Set((members.data ?? []).map((m) => m.id));
  const addable = (allUsers.data ?? []).filter((u) => u.is_active && !memberIds.has(u.id));
  const [adding, setAdding] = useState("");
  const pending = (invitations.data ?? []).filter((i) => i.status === "pending" && i.team_ids.includes(teamId));
  return (
    <div className="team-panel">
      <div className="toolbar">
        <h3>{name}</h3>
        <span className="spacer" />
        {manage && (
          <>
            <button className="btn" onClick={() => setRenaming(true)}>
              Rename
            </button>
            <button
              className="btn danger"
              onClick={() => {
                if (!window.confirm(`Delete the team “${name}”? Its image sets are released (public and locked).`)) return;
                run(async () => {
                  await api(`/api/v2/teams/${teamId}`, { method: "DELETE" });
                  await qc.invalidateQueries({ queryKey: ["admin-teams"] });
                  await qc.invalidateQueries({ queryKey: ["admin-me"] });
                  onGone();
                });
              }}
            >
              Delete team
            </button>
          </>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      <h4>Members</h4>
      <table className="admin-table" data-testid="members">
        <tbody>
          {(members.data ?? []).map((m) => (
            <tr key={m.id}>
              <td>
                {m.username}
                {!m.is_active && <span className="badge"> inactive</span>}
              </td>
              <td>
                <label className="check">
                  <input type="checkbox" checked={m.is_admin} disabled={!manage} onChange={(e) => run(() => api(`/api/v2/teams/${teamId}/members/${m.id}`, { method: "PUT", json: { is_admin: e.target.checked } }))} aria-label={`${m.username} is team admin`} /> team admin
                </label>
              </td>
              <td>
                {(manage || m.id === selfId) && (
                  <button
                    className="btn ghost small"
                    onClick={() => window.confirm(m.id === selfId ? "Leave this team?" : `Remove ${m.username} from the team?`) && run(() => api(`/api/v2/teams/${teamId}/members/${m.id}`, { method: "DELETE" }))}
                  >
                    {m.id === selfId ? "Leave" : "Remove"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {manage && me.is_site_admin && addable.length > 0 && (
        <div className="row-inline">
          <select value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Add a user">
            <option value="">Add an existing user…</option>
            {addable.map((u) => (
              <option key={u.id} value={u.id}>
                {u.username}
              </option>
            ))}
          </select>
          <button className="btn" disabled={!adding} onClick={() => run(async () => { await api(`/api/v2/teams/${teamId}/members/${adding}`, { method: "PUT", json: { is_admin: false } }); setAdding(""); })}>
            Add
          </button>
        </div>
      )}
      {manage && (
        <>
          <h4>Invitations</h4>
          <button className="btn" onClick={() => setInviting(true)}>
            Invite someone…
          </button>
          {pending.length === 0 && <p className="muted small">No open invitations.</p>}
          <table className="admin-table">
            <tbody>
              {pending.map((i) => (
                <tr key={i.id}>
                  <td>{i.email || <span className="muted">no email</span>}</td>
                  <td className="muted small">{i.note}</td>
                  <td className="muted small">until {new Date(i.expires_at).toLocaleDateString()}</td>
                  <td>
                    <button className="btn ghost small" onClick={() => run(() => api(`/api/v2/invitations/${i.id}`, { method: "DELETE" }))}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {renaming && (
        <NameDialog
          title="Rename the team"
          label="Team name"
          initial={name}
          onClose={() => setRenaming(false)}
          onSave={async (n) => {
            await api(`/api/v2/teams/${teamId}`, { method: "PATCH", json: { name: n } });
            await qc.invalidateQueries({ queryKey: ["admin-teams"] });
          }}
        />
      )}
      {inviting && (
        <InviteDialog
          teamId={teamId}
          onClose={() => setInviting(false)}
          onCreated={(link) => {
            refresh();
            setSecret({ title: "Invitation link", intro: "Send this link to the person. It creates their account and adds them to the team.", value: link });
          }}
        />
      )}
      {secret && <SecretDialog {...secret} onClose={() => setSecret(null)} />}
    </div>
  );
}

function InviteDialog({ teamId, onClose, onCreated }: { teamId: number; onClose(): void; onCreated(link: string): void }) {
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [days, setDays] = useState(7);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api<{ path: string }>("/api/v2/invitations", { json: { email: email.trim(), note: note.trim(), team_ids: [teamId], expires_in_days: days } });
      onCreated(`${window.location.origin}${r.path}`);
      onClose();
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };
  return (
    <Modal title="Invite someone" onClose={onClose}>
      <label className="field">
        <span>Email (optional; filled in for them)</span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Invitee email" />
      </label>
      <label className="field">
        <span>Note (only you see it)</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} aria-label="Invitation note" />
      </label>
      <label className="field">
        <span>Valid for (days)</span>
        <input type="number" min={1} max={60} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Valid days" />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy} onClick={() => void go()}>
          Create link
        </button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------------ users

/** Name, email and username of a user. */
function EditUserDialog({ userId, onSaved, onClose }: { userId: number; onSaved(): void; onClose(): void }) {
  const profile = useQuery({ queryKey: ["admin-user-profile", userId], queryFn: () => api<{ username: string; first_name: string; last_name: string; email: string }>(`/api/v2/admin/users/${userId}/profile`), staleTime: 0 });
  const [form, setForm] = useState<{ username: string; first_name: string; last_name: string; email: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const v = form ?? profile.data;
  const set = (k: string, value: string) => v && setForm({ ...v, [k]: value });
  const save = () => {
    if (!v) return;
    setBusy(true);
    api(`/api/v2/users/${userId}`, { method: "PATCH", json: v }).then(
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
    <Modal title="Edit user" onClose={onClose}>
      {!v ? (
        <p className="muted">{profile.error ? msg(profile.error) : "Loading…"}</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label className="field">
            <span>Username</span>
            <input value={v.username} onChange={(e) => set("username", e.target.value)} aria-label="Username" />
          </label>
          <label className="field">
            <span>First name</span>
            <input value={v.first_name} onChange={(e) => set("first_name", e.target.value)} aria-label="First name" />
          </label>
          <label className="field">
            <span>Last name</span>
            <input value={v.last_name} onChange={(e) => set("last_name", e.target.value)} aria-label="Last name" />
          </label>
          <label className="field">
            <span>Email</span>
            <input type="email" value={v.email} onChange={(e) => set("email", e.target.value)} aria-label="Email" />
          </label>
          {error && <p className="error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={busy}>
              Save
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function UsersTab({ me }: { me: AdminMe }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ title: string; intro: string; value: string } | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [permsOf, setPermsOf] = useState<{ id: number; username: string } | null>(null);
  const [newUser, setNewUser] = useState(false);
  const users = useQuery({ queryKey: ["admin-users"], queryFn: () => listAll<UserRow>("/api/v2/users", { fields: "id,username,is_active,is_staff,is_superuser,last_login,team_set" }), staleTime: 0 });
  const teams = useQuery({ queryKey: ["admin-teams"], queryFn: () => listAll<TeamRow>("/api/v2/teams", { fields: "id,name" }), staleTime: 0 });
  const roles = useQuery({ queryKey: ["admin-roles"], queryFn: () => api<{ site_admin_ids: number[]; read_only_ids: number[] }>("/api/v2/admin/roles"), staleTime: 0 });
  const administrators = useMemo(() => new Set(roles.data?.site_admin_ids ?? []), [roles.data]);
  const readOnlyIds = useMemo(() => new Set(roles.data?.read_only_ids ?? []), [roles.data]);
  const names = useMemo(() => new Map((teams.data ?? []).map((t) => [t.id, t.name])), [teams.data]);
  const shown = (users.data ?? []).filter((u) => u.username.toLowerCase().includes(q.trim().toLowerCase())).sort((a, b) => a.username.localeCompare(b.username));
  const run = (fn: () => Promise<unknown>) =>
    void fn().then(
      () => {
        setError(null);
        void qc.invalidateQueries({ queryKey: ["admin-users"] });
        void qc.invalidateQueries({ queryKey: ["admin-roles"] });
      },
      (e) => setError(msg(e)),
    );
  const patch = (id: number, body: Record<string, unknown>) => run(() => api(`/api/v2/users/${id}`, { method: "PATCH", json: body }));
  return (
    <div className="admin-main">
      <div className="toolbar">
        <SearchInput history="users" className="search" placeholder="Filter users…" value={q} onChange={setQ} aria-label="Filter users" />
        <span className="muted small">{shown.length} of {users.data?.length ?? 0}</span>
        <span className="spacer" />
        <button className="btn primary" onClick={() => setNewUser(true)} title="An account for a person or a worker: names, teams, read only or not, and a password in one go">
          New user…
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <p className="muted small roles-legend" data-testid="roles-legend">
        <strong>Administrator</strong> manages users: activate and deactivate, reset passwords, delete, invite into any team, see the Users tab. <strong>Edits profiles</strong> (Django: staff) may change other
        users' names and email. <strong>Read only</strong> may look at everything its teams give but change nothing, however it signs in. <strong>Full rights</strong> (superuser) holds every permission and is the only role that can hand out roles and permissions. What a user sees is decided by their teams, not by these roles.
      </p>
      <table className="admin-table" data-testid="users">
        <thead>
          <tr>
            <th>User</th>
            <th>Teams</th>
            <th>Active</th>
            <th title="Manages users: activate, deactivate, reset passwords, delete, invite into any team">Administrator</th>
            <th title="May change other users' names and email (Django: staff)">Edits profiles</th>
            <th title="May look at everything its teams give but change nothing, however it signs in">Read only</th>
            <th>Last login</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.map((u) => {
            const self = u.id === user?.id;
            return (
              <tr key={u.id}>
                <td>
                  {u.username}
                  {u.is_superuser && (
                    <span className="badge" title="Superuser: holds every permission and may hand out roles and permissions"> full rights</span>
                  )}
                </td>
                <td className="muted small">{u.team_set.map((t) => names.get(t) ?? t).join(", ")}</td>
                <td>
                  <input type="checkbox" checked={u.is_active} disabled={self} onChange={(e) => patch(u.id, { is_active: e.target.checked })} aria-label={`${u.username} is active`} />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={administrators.has(u.id)}
                    disabled={self || !me.is_superuser}
                    onChange={(e) => patch(u.id, { is_site_admin: e.target.checked })}
                    aria-label={`${u.username} is administrator`}
                    title={me.is_superuser ? "Manages users: activate, deactivate, reset passwords, delete, invite into any team" : "Only superusers change this"}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={u.is_staff}
                    disabled={self || !me.is_superuser}
                    onChange={(e) => patch(u.id, { is_staff: e.target.checked })}
                    aria-label={`${u.username} edits profiles`}
                    title={me.is_superuser ? "May change other users' names and email (Django: staff)" : "Only superusers change this"}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={readOnlyIds.has(u.id)}
                    disabled={self}
                    onChange={(e) => patch(u.id, { read_only: e.target.checked })}
                    aria-label={`${u.username} is read only`}
                    title="May look at everything its teams give but change nothing, however it signs in"
                  />
                </td>
                <td className="muted small">{u.last_login ? new Date(u.last_login).toLocaleDateString() : "never"}</td>
                <td className="row-actions">
                  <button className="btn ghost small" onClick={() => setEditing(u.id)}>
                    Edit
                  </button>
                  {me.is_superuser && !self && !u.is_superuser && (
                    <button className="btn ghost small" onClick={() => setPermsOf({ id: u.id, username: u.username })}>
                      Permissions
                    </button>
                  )}
                  {!self && (
                    <>
                      <button
                        className="btn ghost small"
                        onClick={() =>
                          run(async () => {
                            const r = await api<{ path: string }>(`/api/v2/admin/users/${u.id}/reset-link`, { method: "POST" });
                            setSecret({ title: `Password reset for ${u.username}`, intro: "Send this link to the user. It is valid for one day.", value: `${window.location.origin}${r.path}` });
                          })
                        }
                      >
                        Reset link
                      </button>
                      <button
                        className="btn ghost small"
                        onClick={() =>
                          window.confirm(`Set a new random password for ${u.username}?`) &&
                          run(async () => {
                            const r = await api<{ password: string }>(`/api/v2/users/${u.id}/random-password`, { method: "POST" });
                            setSecret({ title: `New password for ${u.username}`, intro: "The old password no longer works.", value: r.password });
                          })
                        }
                      >
                        Random password
                      </button>
                      <button className="btn ghost small danger" onClick={() => window.confirm(`Delete the user ${u.username}? Their annotations stay.`) && run(() => api(`/api/v2/users/${u.id}`, { method: "DELETE" }))}>
                        Delete
                      </button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {secret && <SecretDialog {...secret} onClose={() => setSecret(null)} />}
      {permsOf && <PermissionsDialog userId={permsOf.id} username={permsOf.username} onSaved={() => void qc.invalidateQueries({ queryKey: ["admin-users"] })} onClose={() => setPermsOf(null)} />}
      {newUser && <NewUserDialog teams={teams.data ?? []} superuser={me.is_superuser} onCreated={() => {
          void qc.invalidateQueries({ queryKey: ["admin-users"] });
          void qc.invalidateQueries({ queryKey: ["admin-roles"] });
        }} onClose={() => setNewUser(false)} />}
      {editing !== null && <EditUserDialog userId={editing} onSaved={() => void qc.invalidateQueries({ queryKey: ["admin-users"] })} onClose={() => setEditing(null)} />}
    </div>
  );
}

