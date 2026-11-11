import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, listAll } from "../api/client";
import { Modal } from "./Modal";
import { SecretDialog } from "./SecretDialog";

export interface AccessToken {
  id: number;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  read_only: boolean;
  teams: number[];
  scopes: string[] | null;
  active: boolean;
  username?: string;
}

const day = (s: string | null, never = "never") => (s ? new Date(s).toLocaleDateString() : never);
const why = (e: unknown) => {
  if (e instanceof ApiError) return e.detail;
  return e instanceof Error ? e.message : String(e);
};

const ABILITIES: { id: string; label: string; hint: string }[] = [
  { id: "jobs", label: "queue jobs", hint: "start, restart and cancel analyses, registrations and segmentations" },
  { id: "annotate", label: "annotate", hint: "create, change, verify and delete annotations" },
  { id: "images", label: "manage images", hint: "upload, rename, move and delete images, change image sets" },
];
/** What a token may do, in words. */
function mayDo(t: AccessToken): string {
  if (t.read_only) return "only looks";
  if (!t.scopes) return "full access";
  return "looks, " + t.scopes.map((s) => ABILITIES.find((a) => a.id === s)?.label ?? s).join(", ");
}

/** The status of a token in words: active, expired or revoked. */
function status(t: AccessToken): string {
  if (t.revoked_at) return `revoked ${day(t.revoked_at)}`;
  if (!t.active) return `expired ${day(t.expires_at)}`;
  return t.expires_at ? `expires ${day(t.expires_at)}` : "no expiry";
}

/** The rows of a token list. `revoke` revokes an active token and removes an inactive one. */
function Rows({ tokens, teamNames, onRevoke, testid }: { tokens: AccessToken[]; teamNames: Map<number, string>; onRevoke(t: AccessToken): void; testid: string }) {
  return (
    <ul className="passkey-list" data-testid={testid}>
      {tokens.map((t) => (
        <li key={t.id} className={t.active ? "" : "inactive"} data-testid="token-row" data-active={t.active}>
          <span className="grow">
            <b>{t.name}</b>
            {t.username && <span className="muted small"> · {t.username}</span>}{" "}
            <span className="muted small">
              (<span className="mono">pat_{t.prefix}…</span>) · {mayDo(t)} ·{" "}
              {t.teams.length ? `teams: ${t.teams.map((id) => teamNames.get(id) ?? `#${id}`).join(", ")}` : "all teams"} · created {day(t.created_at)} · last used {day(t.last_used_at)} · {status(t)}
            </span>
          </span>
          <button
            className="btn ghost"
            data-testid="token-revoke"
            onClick={() => (!t.active || window.confirm(`Revoke the token “${t.name}”? Whatever uses it stops working at once.`)) && onRevoke(t)}
          >
            {t.active ? "Revoke" : "Remove"}
          </button>
        </li>
      ))}
      {tokens.length === 0 && <li className="muted">No tokens.</li>}
    </ul>
  );
}

/** Preferences: make, list and revoke the personal access tokens of the signed-in account. */
export function AccessTokens() {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ["tokens"], queryFn: () => api<AccessToken[]>("/api/v2/me/tokens"), staleTime: 0 });
  const teams = useQuery({ queryKey: ["token-teams"], queryFn: () => listAll<{ id: number; name: string }>("/api/v2/teams", { fields: "id,name" }), staleTime: 30_000 });
  const teamNames = new Map((teams.data ?? []).map((t) => [t.id, t.name]));
  const [name, setName] = useState("");
  const [days, setDays] = useState("90");
  const [access, setAccess] = useState<"full" | "look" | "some">("full");
  const [abilities, setAbilities] = useState<Set<string>>(new Set(["jobs"]));
  const [only, setOnly] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["tokens"] });
  const create = useMutation({
    mutationFn: () => api<AccessToken & { token: string }>("/api/v2/me/tokens", { method: "POST", json: { name: name.trim(), expires_in_days: days === "never" ? null : Number(days), read_only: access === "look", ...(access === "some" ? { scopes: [...abilities] } : {}), teams: [...only] } }),
    onSuccess: (t) => {
      setMade(t.token);
      setName("");
      setOnly(new Set());
      setError(null);
      void refresh();
    },
    onError: (e) => setError(why(e)),
  });
  const revoke = useMutation({ mutationFn: (t: AccessToken) => api(`/api/v2/me/tokens/${t.id}`, { method: "DELETE" }), onSuccess: refresh, onError: (e) => setError(why(e)) });
  return (
    <div>
      <p className="muted small">
        A token lets a script or a program such as exact-sync use the API as you, without your password (<span className="mono">Authorization: Bearer pat_…</span>). Give each use its own token, so that you can revoke one without breaking the others.
        A token cannot make tokens. A token can be limited to looking, or to looking and queueing jobs, annotating or managing images (so that a script that only starts analyses cannot touch your annotations); a token restricted to teams sees only their data.
      </p>
      <Rows tokens={tokens.data ?? []} teamNames={teamNames} onRevoke={(t) => revoke.mutate(t)} testid="token-list" />
      <div className="row">
        <input placeholder="Name (e.g. “analysis script”)" aria-label="Name of the new token" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} data-testid="token-name" />
        <select value={days} onChange={(e) => setDays(e.target.value)} aria-label="Expires" data-testid="token-expiry">
          <option value="30">expires in 30 days</option>
          <option value="90">expires in 90 days</option>
          <option value="365">expires in a year</option>
          <option value="never">never expires</option>
        </select>
        <select value={access} onChange={(e) => setAccess(e.target.value as "full" | "look" | "some")} aria-label="What the token may do" data-testid="token-access">
          <option value="full">may do everything I may</option>
          <option value="look">may only look (read only)</option>
          <option value="some">may look and…</option>
        </select>
      </div>
      {access === "some" && (
        <div className="row" data-testid="token-abilities">
          {ABILITIES.map((a) => (
            <label className="check" key={a.id} title={a.hint} style={{ whiteSpace: "nowrap", width: "auto" }}>
              <input
                type="checkbox"
                checked={abilities.has(a.id)}
                data-testid={`token-ability-${a.id}`}
                onChange={(e) => setAbilities((o) => (e.target.checked ? new Set(o).add(a.id) : new Set([...o].filter((x) => x !== a.id))))}
              />{" "}
              {a.label}
            </label>
          ))}
        </div>
      )}
      {(teams.data?.length ?? 0) > 1 && (
        <div className="row" data-testid="token-teams">
          <span className="muted small">Only these teams (none ticked: all):</span>
          {teams.data?.map((t) => (
            <label className="check" key={t.id}>
              <input
                type="checkbox"
                checked={only.has(t.id)}
                onChange={(e) => setOnly((o) => (e.target.checked ? new Set(o).add(t.id) : new Set([...o].filter((x) => x !== t.id))))}
              />{" "}
              {t.name}
            </label>
          ))}
        </div>
      )}
      <div className="row">
        <button className="btn" disabled={!name.trim() || create.isPending || (access === "some" && abilities.size === 0)} onClick={() => create.mutate()} data-testid="token-create">
          Create token
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {made && <SecretDialog title="Your new token" intro="Copy it now and keep it safe: it is shown only this once, and anybody who has it can act as you within its limits." value={made} onClose={() => setMade(null)} />}
    </div>
  );
}

/** Administration: the tokens of one account, to be revoked (a site administrator never sees the secrets). */
export function UserTokensDialog({ user, onClose }: { user: { id: number; username: string }; onClose(): void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const tokens = useQuery({ queryKey: ["admin-tokens", user.id], queryFn: () => api<AccessToken[]>(`/api/v2/admin/tokens?user=${user.id}`), staleTime: 0 });
  const teams = useQuery({ queryKey: ["admin-teams"], queryFn: () => listAll<{ id: number; name: string }>("/api/v2/teams", { fields: "id,name" }), staleTime: 30_000 });
  const revoke = useMutation({
    mutationFn: (t: AccessToken) => api(`/api/v2/admin/tokens/${t.id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-tokens", user.id] }),
    onError: (e) => setError(why(e)),
  });
  return (
    <Modal title={`Access tokens of ${user.username}`} onClose={onClose} wide>
      <Rows tokens={(tokens.data ?? []).map((t) => ({ ...t, username: undefined }))} teamNames={new Map((teams.data ?? []).map((t) => [t.id, t.name]))} onRevoke={(t) => revoke.mutate(t)} testid="user-token-list" />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button className="btn primary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
