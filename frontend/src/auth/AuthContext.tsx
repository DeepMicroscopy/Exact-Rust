import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, setCsrfToken } from "../api/client";
import type { User } from "../api/types";
import { passkeyAssertion } from "./webauthn";

interface Auth {
  user: User | null;
  loading: boolean;
  login(username: string, password: string): Promise<void>;
  /** sign in with a passkey (of the named account, or any that the device offers) */
  loginWithPasskey(username?: string): Promise<void>;
  logout(): Promise<void>;
}

const Ctx = createContext<Auth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<User & { csrf_token: string }>("/api/v2/auth/me")
      .then((me) => {
        setCsrfToken(me.csrf_token);
        setUser(me);
      })
      .catch((e) => {
        if (!(e instanceof ApiError) || (e.status !== 401 && e.status !== 403)) console.error(e);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const r = await api<{ user: User; csrf_token: string }>("/api/v2/auth/login", { json: { username, password } });
    setCsrfToken(r.csrf_token);
    setUser(r.user);
  }, []);

  const loginWithPasskey = useCallback(async (username?: string) => {
    const r = await passkeyAssertion<{ user: User; csrf_token: string }>(username);
    setCsrfToken(r.csrf_token);
    setUser(r.user);
  }, []);

  const logout = useCallback(async () => {
    await api("/api/v2/auth/logout", { method: "POST" }).catch(() => undefined);
    setCsrfToken(null);
    setUser(null);
  }, []);

  return <Ctx.Provider value={{ user, loading, login, loginWithPasskey, logout }}>{children}</Ctx.Provider>;
}

export function useAuth(): Auth {
  const v = useContext(Ctx);
  if (!v) throw new Error("AuthProvider missing");
  return v;
}
