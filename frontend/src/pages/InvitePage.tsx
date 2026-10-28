import { useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { Logo } from "../components/Logo";

interface Inspect {
  purpose: "invite" | "reset";
  email: string;
  username: string | null;
  expires_at: string;
  teams: { id: number; name: string }[];
}

/** The page behind an invitation or password reset link: no login needed. */
export function InvitePage() {
  const { token } = useParams();
  const info = useQuery({ queryKey: ["invite", token], retry: false, queryFn: () => api<Inspect>(`/api/v2/invitations/token/${token}`) });
  const [form, setForm] = useState({ username: "", password: "", again: "", email: "", first_name: "", last_name: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.password !== form.again) {
      setError("The passwords differ.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v2/invitations/token/${token}/accept`, { json: info.data?.purpose === "reset" ? { password: form.password } : { username: form.username, password: form.password, email: form.email || info.data?.email, first_name: form.first_name, last_name: form.last_name } });
      window.location.assign("/"); // signed in by the answer: load the app anew
    } catch (err) {
      const b = err instanceof ApiError ? (err.body as Record<string, unknown> | null) : null;
      const first = b && Object.entries(b).find(([, v]) => Array.isArray(v));
      setError(first ? `${first[0]}: ${(first[1] as string[]).join(" ")}` : err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <div className="login-wrap">
      <form className="login glass" onSubmit={(e) => void submit(e)}>
        <Logo height={22} />
        {info.isLoading && <p className="muted">Checking the link…</p>}
        {info.isError && <p className="error">This link is invalid, expired or already used. Ask for a new one.</p>}
        {info.data && (
          <>
            <h2>{info.data.purpose === "reset" ? `New password for ${info.data.username ?? "your account"}` : "Create your account"}</h2>
            {info.data.purpose === "invite" && info.data.teams.length > 0 && <p className="muted small">You will join: {info.data.teams.map((t) => t.name).join(", ")}</p>}
            {info.data.purpose === "invite" && (
              <>
                <label className="field">
                  <span>Username</span>
                  <input value={form.username} onChange={(e) => set("username", e.target.value)} autoComplete="username" aria-label="Username" required />
                </label>
                <label className="field">
                  <span>Email</span>
                  <input type="email" value={form.email || info.data.email} onChange={(e) => set("email", e.target.value)} autoComplete="email" aria-label="Email" />
                </label>
                <div className="row2">
                  <label className="field">
                    <span>First name</span>
                    <input value={form.first_name} onChange={(e) => set("first_name", e.target.value)} aria-label="First name" />
                  </label>
                  <label className="field">
                    <span>Last name</span>
                    <input value={form.last_name} onChange={(e) => set("last_name", e.target.value)} aria-label="Last name" />
                  </label>
                </div>
              </>
            )}
            <label className="field">
              <span>Password</span>
              <input type="password" value={form.password} onChange={(e) => set("password", e.target.value)} autoComplete="new-password" aria-label="Password" required />
            </label>
            <label className="field">
              <span>Repeat the password</span>
              <input type="password" value={form.again} onChange={(e) => set("again", e.target.value)} autoComplete="new-password" aria-label="Repeat the password" required />
            </label>
            {error && <p className="error">{error}</p>}
            <button className="btn primary" disabled={busy}>
              {info.data.purpose === "reset" ? "Set the password" : "Create the account"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
