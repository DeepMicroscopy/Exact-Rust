import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";

interface Entry {
  id: number;
  first: string;
  last: string;
  count: number;
  level: "WARN" | "ERROR";
  target: string;
  message: string;
}
interface Log {
  items: Entry[];
  total: number;
  capacity: number;
  since: string;
}

const when = (s: string) => new Date(s).toLocaleString();
const asText = (items: Entry[]) => items.map((e) => `${e.last}${e.count > 1 ? ` (x${e.count}, since ${e.first})` : ""} ${e.level} ${e.target}: ${e.message}`).join("\n");

/** The warnings and errors of the server (what is also on its console), for site admins: slides that cannot be read, failed jobs, ... */
export function LogTab() {
  const qc = useQueryClient();
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [q, setQ] = useState("");
  const [auto, setAuto] = useState(true);
  const [copied, setCopied] = useState(false);
  const log = useQuery({
    queryKey: ["admin-log", errorsOnly, q],
    queryFn: () => api<Log>(`/api/v2/admin/log?limit=1000${errorsOnly ? "&level=error" : ""}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`),
    refetchInterval: auto ? 10_000 : false,
    staleTime: 0,
  });
  const clear = useMutation({ mutationFn: () => api("/api/v2/admin/log", { method: "DELETE" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-log"] }) });
  const items = log.data?.items ?? [];
  const download = () => {
    const url = URL.createObjectURL(new Blob([asText(items) + "\n"], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `exact-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  };
  return (
    <div data-testid="admin-log">
      <p className="muted small">
        Warnings and errors of the server, newest first: slides that cannot be read (with the image and file), failed jobs, internal errors. The same message in a row is counted once.
        Kept in memory (the last {log.data?.capacity ?? 2000}); a restart of the server empties it{log.data ? `, this one started ${when(log.data.since)}` : ""}.
      </p>
      <div className="row log-controls">
        <input className="search" placeholder="Filter (image id, file name, text)…" aria-label="Filter the log" value={q} onChange={(e) => setQ(e.target.value)} data-testid="log-filter" />
        <label className="check">
          <input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} /> Errors only
        </label>
        <label className="check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Refresh every 10 s
        </label>
        <button className="btn" onClick={() => void log.refetch()} disabled={log.isFetching}>
          Refresh
        </button>
        <button
          className="btn"
          disabled={items.length === 0}
          onClick={() => void navigator.clipboard?.writeText(asText(items)).then(() => setCopied(true))}
          onBlur={() => setCopied(false)}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button className="btn" onClick={download} disabled={items.length === 0}>
          Download
        </button>
        <button className="btn danger" onClick={() => window.confirm("Empty the log?") && clear.mutate()} disabled={clear.isPending || (log.data?.total ?? 0) === 0}>
          Empty
        </button>
      </div>
      {log.error && <p className="error">Could not load the log.</p>}
      {log.data && <p className="muted small">{log.data.total === 0 ? "Nothing logged." : `${log.data.total} message${log.data.total === 1 ? "" : "s"}${log.data.total > items.length ? `, the newest ${items.length} shown` : ""}.`}</p>}
      <table className="admin-table log-table" data-testid="log-table">
        <tbody>
          {items.map((e) => (
            <tr key={e.id} className={e.level === "ERROR" ? "error-row" : ""}>
              <td className="nowrap small" title={`first ${when(e.first)}`}>
                {when(e.last)}
              </td>
              <td>
                <span className={`badge ${e.level === "ERROR" ? "failed" : ""}`}>{e.level}</span>
                {e.count > 1 && <span className="muted small"> ×{e.count}</span>}
              </td>
              <td className="log-message selectable">
                {e.message}
                <div className="muted small">{e.target}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
