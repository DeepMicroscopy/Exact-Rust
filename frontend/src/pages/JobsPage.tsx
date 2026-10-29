import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, listAll } from "../api/client";
import { useAuth } from "../auth/AuthContext";

export interface Job {
  kind: "registration" | "plugin";
  id: number;
  status: "queued" | "running" | "done" | "failed";
  image: number;
  images: number[];
  plugin: number | null;
  plugin_name: string | null;
  progress: number | null;
  worker: string | null;
  error: string | null;
  creator: number | null;
  created_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  result: number | null;
}
export interface JobWorker {
  name: string;
  kinds: string[];
  seen_seconds_ago: number;
}
interface Jobs {
  items: Job[];
  workers: JobWorker[];
}

const KIND_LABEL: Record<Job["kind"], string> = { registration: "Registration", plugin: "Image analysis" };
const STATUS_LABEL: Record<Job["status"], string> = { queued: "waiting for a worker", running: "running", done: "done", failed: "failed" };
const msg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

export const isActive = (j: Job) => j.status === "queued" || j.status === "running";

/** How long ago, in words a person reads ("3 min ago"). */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** Whether a job that waits has nobody to do it: no worker that does its kind asked for work lately. */
export function unattended(jobs: Job[], workers: JobWorker[], now = Date.now()): Job["kind"][] {
  const kinds = new Set<Job["kind"]>();
  for (const j of jobs) {
    if (j.status !== "queued" || !j.created_at || now - new Date(j.created_at).getTime() < 15_000) continue;
    if (!workers.some((w) => w.kinds.includes(j.kind))) kinds.add(j.kind);
  }
  return [...kinds];
}

/** All jobs of the teams: registrations and image analyses, with their status, and what can be done with them. */
export function JobsPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [kind, setKind] = useState<"" | Job["kind"]>("");
  const [status, setStatus] = useState<"" | "active" | Job["status"]>("");
  const [error, setError] = useState<string | null>(null);
  const jobs = useQuery({
    queryKey: ["jobs"],
    queryFn: () => api<Jobs>("/api/v2/jobs?limit=300"),
    staleTime: 0,
    refetchInterval: (q) => ((q.state.data?.items ?? []).some(isActive) ? 3000 : 15000),
  });
  const ids = useMemo(() => [...new Set((jobs.data?.items ?? []).flatMap((j) => j.images).filter(Boolean))], [jobs.data]);
  const names = useQuery({
    queryKey: ["job-images", ids.join(",")],
    enabled: ids.length > 0,
    queryFn: async () => new Map((await listAll<{ id: number; name: string }>("/api/v2/images", { id__in: ids.join(","), fields: "id,name" })).map((i) => [i.id, i.name])),
  });
  const name = (id: number | null) => (id == null ? "" : (names.data?.get(id) ?? `image ${id}`));
  const Images = ({ ids, sep }: { ids: number[]; sep: string }) => (
    <>
      {ids.map((id, i) => (
        <span key={`${id}-${i}`}>
          {i > 0 && sep}
          <Link to={`/images/${id}`}>{name(id)}</Link>
        </span>
      ))}
    </>
  );
  const all = jobs.data?.items ?? [];
  const shown = all.filter((j) => (!kind || j.kind === kind) && (!status || (status === "active" ? isActive(j) : j.status === status)));
  const missing = unattended(all, jobs.data?.workers ?? []);
  const act = (j: Job, what: "restart" | "remove") =>
    api(what === "restart" ? `/api/v2/jobs/${j.kind}/${j.id}/restart` : `/api/v2/jobs/${j.kind}/${j.id}`, { method: what === "restart" ? "POST" : "DELETE" }).then(
      () => {
        setError(null);
        void qc.invalidateQueries({ queryKey: ["jobs"] });
      },
      (e) => setError(msg(e)),
    );
  const mine = (j: Job) => j.creator === user?.id || !!user?.is_staff;
  return (
    <section className="main jobs">
      <div className="toolbar">
        <h2>Jobs</h2>
        <span className="spacer" />
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Kind of job">
          <option value="">All kinds</option>
          <option value="registration">Registration</option>
          <option value="plugin">Image analysis</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status of job">
          <option value="">Any status</option>
          <option value="active">Waiting or running</option>
          <option value="done">Done</option>
          <option value="failed">Failed</option>
        </select>
      </div>
      {missing.length > 0 && (
        <p className="notice warn" role="status" data-testid="no-worker">
          No worker for {missing.map((k) => KIND_LABEL[k].toLowerCase()).join(" and ")} is connected. The waiting jobs start as soon as one is running; ask your administrator.
        </p>
      )}
      {error && <p className="error">{error}</p>}
      <table className="admin-table stack" data-testid="jobs">
        <thead>
          <tr>
            <th>Job</th>
            <th>Status</th>
            <th>Worker</th>
            <th>Started</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.map((j) => (
            <tr key={`${j.kind}-${j.id}`} data-kind={j.kind} data-status={j.status}>
              <td>
                <span className="badge">{KIND_LABEL[j.kind]}</span>{" "}
                {j.kind === "registration" ? (
                  <>
                    <Images ids={j.images} sep=" → " />
                    {j.plugin_name && <span className="muted small"> · {j.plugin_name}</span>}
                  </>
                ) : (
                  <>
                    {j.plugin_name} on <Images ids={j.images} sep=", " />
                  </>
                )}
                {j.error && (
                  <details className="job-error">
                    <summary className="error small">{j.error.split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 120) ?? "failed"}</summary>
                    <pre>{j.error}</pre>
                  </details>
                )}
              </td>
              <td>
                <span className={`status status-${j.status}`}>{STATUS_LABEL[j.status]}</span>
                {j.status === "running" && j.progress != null && j.progress > 0 && (
                  <span className="bar" aria-label={`${Math.round(j.progress * 100)} percent`}>
                    <span style={{ width: `${Math.round(j.progress * 100)}%` }} />
                  </span>
                )}
              </td>
              <td className="muted small" data-label="Worker">{j.worker ?? ""}</td>
              <td className="muted small" data-label="Started" title={j.created_at ?? ""}>
                {ago(j.started_at ?? j.created_at)}
              </td>
              <td className="row-actions">
                {j.status === "failed" && mine(j) && (
                  <button className="btn ghost small" onClick={() => void act(j, "restart")}>
                    Restart
                  </button>
                )}
                {mine(j) && (
                  <button className="btn ghost small danger" onClick={() => void act(j, "remove")}>
                    {isActive(j) ? "Cancel" : "Remove"}
                  </button>
                )}
              </td>
            </tr>
          ))}
          {jobs.data && shown.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No jobs.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {(jobs.data?.workers.length ?? 0) > 0 && (
        <p className="muted small" data-testid="workers">
          Connected: {jobs.data?.workers.map((w) => `${w.name} (${w.kinds.map((k) => KIND_LABEL[k as Job["kind"]].toLowerCase()).join(", ")})`).join(" · ")}
        </p>
      )}
    </section>
  );
}
