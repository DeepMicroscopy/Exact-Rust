import { useState, type FormEvent } from "react";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";
import { passkeysSupported } from "../auth/webauthn";
import { Logo } from "../components/Logo";

export function Login() {
  const { login, loginWithPasskey } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "Cannot reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function withPasskey() {
    setBusy(true);
    setError(null);
    try {
      await loginWithPasskey(username.trim() || undefined);
    } catch (err) {
      // the user closing the browser's dialog is no error worth showing
      if (!(err instanceof DOMException && err.name === "NotAllowedError")) setError(err instanceof ApiError ? err.detail : "Passkey sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="glass login" onSubmit={submit}>
        <h1>
          <Logo height={34} />
        </h1>
        <p className="muted">Sign in to continue</p>
        <label>
          Username
          <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="btn primary" disabled={busy || !username || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {passkeysSupported() && (
          <button type="button" className="btn ghost" disabled={busy} onClick={() => void withPasskey()} data-testid="passkey-login">
            Sign in with a passkey
          </button>
        )}
      </form>
    </div>
  );
}
