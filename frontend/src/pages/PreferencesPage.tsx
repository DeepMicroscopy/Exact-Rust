import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { passkeysSupported, registerPasskey } from "../auth/webauthn";
import { NavigationDemo } from "../components/NavigationDemo";
import { usePreferences } from "../hooks/usePreferences";

interface Account {
  username: string;
  email: string;
  date_joined: string;
  last_login: string | null;
}
interface Passkey {
  id: number;
  name: string;
  platform: string;
  enabled: boolean;
  added_on: string;
  last_used: string | null;
}

/** The message of a failed call: field errors of the server (`{field: [..]}`) or its detail. */
function why(e: unknown): string {
  if (e instanceof ApiError) {
    const msgs = e.body && Object.values(e.body).flatMap((v) => (Array.isArray(v) ? v.map(String) : []));
    return msgs && msgs.length ? msgs.join(" ") : e.detail;
  }
  return e instanceof Error ? e.message : String(e);
}
const day = (s: string | null) => (s ? new Date(s).toLocaleDateString() : "never");

function EmailForm({ account }: { account: Account }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState(account.email);
  const save = useMutation({
    mutationFn: () => api("/api/v2/me/email", { method: "PUT", json: { email } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["account"] }),
  });
  return (
    <form
      className="row"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <label htmlFor="pref-email">Email address</label>
      <input id="pref-email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="pref-email" />
      <button className="btn" disabled={save.isPending || email.trim() === account.email}>
        Save
      </button>
      {save.isSuccess && email.trim() === account.email && <span className="ok" role="status">Saved.</span>}
      {save.error && <span className="error" role="alert">{why(save.error)}</span>}
    </form>
  );
}

function PasswordForm() {
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const save = useMutation({
    mutationFn: () => api("/api/v2/me/password", { json: { current_password: cur, new_password: next } }),
    onSuccess: () => {
      setCur("");
      setNext("");
      setAgain("");
    },
  });
  const mismatch = again !== "" && again !== next;
  return (
    <form
      className="col"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!mismatch) save.mutate();
      }}
    >
      <h3>Password</h3>
      <input type="password" autoComplete="current-password" placeholder="Current password" aria-label="Current password" value={cur} onChange={(e) => setCur(e.target.value)} data-testid="pref-pw-current" />
      <input type="password" autoComplete="new-password" placeholder="New password" aria-label="New password" value={next} onChange={(e) => setNext(e.target.value)} data-testid="pref-pw-new" />
      <input type="password" autoComplete="new-password" placeholder="New password again" aria-label="New password again" value={again} onChange={(e) => setAgain(e.target.value)} data-testid="pref-pw-again" />
      {mismatch && <span className="error">The two new passwords differ.</span>}
      <div className="row">
        <button className="btn" disabled={save.isPending || !cur || !next || next !== again} data-testid="pref-pw-save">
          Change password
        </button>
        {save.isSuccess && <span className="ok" role="status">Password changed. Other devices were signed out.</span>}
      </div>
      {save.error && <span className="error" role="alert">{why(save.error)}</span>}
    </form>
  );
}

function Passkeys() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["passkeys"], queryFn: () => api<Passkey[]>("/api/v2/auth/passkeys"), staleTime: 0 });
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["passkeys"] });
  const add = useMutation({
    mutationFn: () => registerPasskey(name),
    onSuccess: () => {
      setName("");
      setError(null);
      void refresh();
    },
    // closing the browser's own dialog is not an error
    onError: (e) => setError(e instanceof DOMException && e.name === "NotAllowedError" ? null : why(e)),
  });
  const remove = useMutation({ mutationFn: (id: number) => api(`/api/v2/auth/passkeys/${id}`, { method: "DELETE" }), onSuccess: refresh });
  const rename = useMutation({ mutationFn: (p: { id: number; name: string }) => api(`/api/v2/auth/passkeys/${p.id}`, { method: "PATCH", json: { name: p.name } }), onSuccess: refresh });
  return (
    <div>
      <p className="muted small">A passkey signs you in with your fingerprint, face or device PIN instead of the password.</p>
      <ul className="passkey-list" data-testid="passkey-list">
        {keys.data?.map((k) => (
          <li key={k.id}>
            <span className="grow">
              <b>{k.name}</b> <span className="muted small">({k.platform}) · added {day(k.added_on)} · last used {day(k.last_used)}</span>
            </span>
            <button
              className="btn ghost"
              onClick={() => {
                const n = window.prompt("Name of the passkey", k.name);
                if (n && n.trim()) rename.mutate({ id: k.id, name: n.trim() });
              }}
            >
              Rename
            </button>
            <button className="btn ghost" onClick={() => window.confirm(`Remove the passkey “${k.name}”?`) && remove.mutate(k.id)}>
              Remove
            </button>
          </li>
        ))}
        {keys.data?.length === 0 && <li className="muted">No passkeys yet.</li>}
      </ul>
      {passkeysSupported() ? (
        <div className="row">
          <input placeholder="Name (e.g. “Work laptop”)" aria-label="Name of the new passkey" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          <button className="btn" disabled={add.isPending} onClick={() => add.mutate()} data-testid="passkey-add">
            {add.isPending ? "Waiting for the device…" : "Add a passkey"}
          </button>
        </div>
      ) : (
        <p className="muted">This browser cannot create passkeys (a secure https connection is required).</p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}

function AutoOverlay() {
  const { prefs, set } = usePreferences();
  return (
    <label className="check" title="Disabled by default">
      <input type="checkbox" checked={prefs.auto_overlay} onChange={(e) => void set({ auto_overlay: e.target.checked })} data-testid="pref-auto-overlay" />
      Auto-enable first overlay
      <span className="muted small"> – when an image has exactly one registered image to overlay, show it as soon as the image opens (O switches it off and on)</span>
    </label>
  );
}

function OverlayOpacity() {
  const { prefs, set } = usePreferences();
  return (
    <label className="check" title="50 % by default">
      Default overlay opacity
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={prefs.overlay_opacity}
        onChange={(e) => void set({ overlay_opacity: Number(e.target.value) })}
        aria-label="Default overlay opacity"
        data-testid="pref-overlay-opacity"
      />
      <span>{prefs.overlay_opacity} %</span>
      <span className="muted small"> – how strongly an overlay image covers the slide when you first show it (the slider in the viewer still changes it for the image you are looking at)</span>
    </label>
  );
}

function Navigation() {
  const { prefs, set } = usePreferences();
  const choices = [
    {
      id: "mouse",
      legacy: true,
      title: "Mouse-optimized",
      sub: "traditional, as in the old EXACT",
      lines: ["Click on the slide: zoom in (Shift + click: zoom out)", "Drag: move the slide", "Mouse wheel: zoom", "Ctrl / Cmd + drag: frame annotations"],
    },
    {
      id: "touch",
      legacy: false,
      title: "Trackpad / tablet-optimized",
      sub: "current",
      lines: ["Pinch: zoom, two fingers: move the slide", "Drag on the background: select annotations with a frame", "Tap: select; pen and finger never zoom by accident", "Track-pad swipe moves, mouse wheel zooms"],
    },
  ] as const;
  return (
    <div className="nav-choice" role="radiogroup" aria-label="Slide navigation">
      {choices.map((c) => (
        <button key={c.id} role="radio" aria-checked={prefs.legacy_navigation === c.legacy} className="nav-card" onClick={() => void set({ legacy_navigation: c.legacy })} data-testid={`nav-${c.id}`}>
          <h3>
            <span>{c.title}</span>
            {prefs.legacy_navigation === c.legacy && <span className="badge">selected</span>}
          </h3>
          <NavigationDemo kind={c.id} />
          <span className="muted small">{c.sub}</span>
          <ul>
            {c.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </button>
      ))}
    </div>
  );
}

export function PreferencesPage() {
  const account = useQuery({ queryKey: ["account"], queryFn: () => api<Account>("/api/v2/me/account"), staleTime: 0 });
  return (
    <div className="prefs" data-testid="preferences">
      <h1>Preferences</h1>
      <section className="glass">
        <h2>Account</h2>
        {account.data && (
          <p className="muted small">
            {account.data.username} · member since {day(account.data.date_joined)} · last sign-in {day(account.data.last_login)}
          </p>
        )}
        {account.data && <EmailForm key={account.data.email} account={account.data} />}
        <PasswordForm />
      </section>
      <section className="glass">
        <h2>Passkeys</h2>
        <Passkeys />
      </section>
      <section className="glass">
        <h2>Viewer</h2>
        <AutoOverlay />
        <OverlayOpacity />
      </section>
      <section className="glass">
        <h2>Slide navigation</h2>
        <p className="muted small">How you move around in a slide. A setting of your account; it applies on every device you sign in with.</p>
        <Navigation />
      </section>
    </div>
  );
}
