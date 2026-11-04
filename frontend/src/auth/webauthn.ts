import { api } from "../api/client";

const toBuf = (s: string): ArrayBuffer => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer;
};
const toB64u = (b: ArrayBuffer | null): string | undefined => {
  if (!b) return undefined;
  let s = "";
  new Uint8Array(b).forEach((c) => (s += String.fromCharCode(c)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const idOf = (d: { id: string }) => ({ ...d, id: toBuf(d.id) });

export const passkeysSupported = (): boolean => typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;

/** Creates a passkey on this device for the signed-in account (the server verifies and stores it). */
export async function registerPasskey(name: string): Promise<void> {
  const b = await api<{ state: string; publicKey: Record<string, unknown> & { user: { id: string }; challenge: string; excludeCredentials: { id: string }[] } }>("/api/v2/auth/passkeys/register/begin", { method: "POST" });
  const publicKey = { ...b.publicKey, challenge: toBuf(b.publicKey.challenge), user: idOf(b.publicKey.user), excludeCredentials: b.publicKey.excludeCredentials.map(idOf) } as unknown as PublicKeyCredentialCreationOptions;
  const cred = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was created.");
  const r = cred.response as AuthenticatorAttestationResponse;
  await api("/api/v2/auth/passkeys/register/finish", {
    json: { state: b.state, name: name.trim() || undefined, credential: { id: cred.id, response: { clientDataJSON: toB64u(r.clientDataJSON), attestationObject: toB64u(r.attestationObject) } } },
  });
}

/** Asks for a passkey (of the named account, or any that this device offers) and returns the login answer of the server. */
export async function passkeyAssertion<T>(username?: string): Promise<T> {
  const b = await api<{ state: string; publicKey: { challenge: string; allowCredentials: { id: string }[] } & Record<string, unknown> }>("/api/v2/auth/passkey/begin", { json: { username: username || undefined } });
  const publicKey = { ...b.publicKey, challenge: toBuf(b.publicKey.challenge), allowCredentials: b.publicKey.allowCredentials.map(idOf) } as unknown as PublicKeyCredentialRequestOptions;
  const cred = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was given.");
  const r = cred.response as AuthenticatorAssertionResponse;
  return api<T>("/api/v2/auth/passkey/finish", {
    json: {
      state: b.state,
      credential: { id: cred.id, response: { clientDataJSON: toB64u(r.clientDataJSON), authenticatorData: toB64u(r.authenticatorData), signature: toB64u(r.signature) } },
    },
  });
}
