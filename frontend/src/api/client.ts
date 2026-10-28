// Thin typed fetch wrapper for the v2 API: session cookie + CSRF header for unsafe methods.

let csrfToken: string | null = null;

export function setCsrfToken(t: string | null): void {
  csrfToken = t;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public detail: string,
  ) {
    super(detail);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const method = (init.method ?? (init.json !== undefined ? "POST" : "GET")).toUpperCase();
  if (init.json !== undefined) headers.set("content-type", "application/json");
  if (!["GET", "HEAD", "OPTIONS"].includes(method) && csrfToken) headers.set("x-csrf-token", csrfToken);
  const res = await fetch(path, {
    ...init,
    method,
    headers,
    credentials: "same-origin",
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const b = await res.json();
      detail = typeof b.detail === "string" ? b.detail : JSON.stringify(b);
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  count?: number;
}

/** Walks a cursor-paginated list endpoint to the end (bounded by `maxItems`). */
export async function listAll<T>(path: string, params: Record<string, string | number | boolean | (string | number)[]> = {}, maxItems = 100_000): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  do {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ limit: 1000, ...params })) {
      if (Array.isArray(v)) v.forEach((x) => q.append(k, String(x))); // repeated parameter: any of
      else q.set(k, String(v));
    }
    if (cursor) q.set("cursor", cursor);
    const page: Page<T> = await api<Page<T>>(`${path}?${q}`);
    out.push(...page.items);
    cursor = page.next_cursor;
  } while (cursor && out.length < maxItems);
  return out;
}
