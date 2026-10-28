import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { ago } from "../pages/JobsPage";
import type { ParamSpec } from "./ParamFields";

interface PluginRow {
  id: number;
  name: string;
  author: string;
  package: string;
  contact: string;
  abouturl: string;
  plugin_type: 1 | 2;
  parameters_schema: ParamSpec[] | null;
  default: boolean;
  jobs: { queued: number; running: number; done: number; failed: number };
  results: number;
  last_job_at: string | null;
  products: { id: number; name: string }[];
  workers: { name: string; seen_seconds_ago: number }[];
}
interface Overview {
  items: PluginRow[];
  workers: { name: string; kinds: string[]; plugins: number[]; seen_seconds_ago: number }[];
}

const TYPE = { 1: "Image analysis", 2: "Registration" } as const;

/** Everything registered in the processing app: image analysis and registration plugins, what they did and who serves them. */
export function PluginsTab() {
  const overview = useQuery({ queryKey: ["admin-plugins"], queryFn: () => api<Overview>("/api/v2/admin/plugins"), staleTime: 0, refetchInterval: 10_000 });
  const items = overview.data?.items ?? [];
  return (
    <div className="admin-main">
      <div className="toolbar">
        <h3>Plugins</h3>
        <span className="muted small">{items.length} registered</span>
      </div>
      <table className="admin-table" data-testid="plugins">
        <thead>
          <tr>
            <th>Plugin</th>
            <th>Type</th>
            <th>Jobs</th>
            <th>Last used</th>
            <th>Served by</th>
            <th>Products</th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.id} data-type={p.plugin_type}>
              <td>
                {p.abouturl ? (
                  <a href={p.abouturl} target="_blank" rel="noreferrer">
                    {p.name}
                  </a>
                ) : (
                  p.name
                )}
                {p.default && <span className="badge"> default</span>}
                <div className="muted small">
                  {[p.author, p.package].filter(Boolean).join(" · ")}
                  {p.parameters_schema && p.parameters_schema.length > 0 && (
                    <details>
                      <summary>{p.parameters_schema.length} parameters</summary>
                      <ul className="plain">
                        {p.parameters_schema.map((q) => (
                          <li key={q.name}>
                            <code>{q.name}</code> {q.type}
                            {q.default !== undefined && q.default !== null ? ` = ${String(q.default)}` : ""}
                            {q.help ? ` – ${q.help}` : ""}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </div>
              </td>
              <td>
                <span className="badge">{TYPE[p.plugin_type]}</span>
              </td>
              <td className="small">
                {p.jobs.queued > 0 && <span>{p.jobs.queued} waiting · </span>}
                {p.jobs.running > 0 && <span>{p.jobs.running} running · </span>}
                {p.jobs.done} done{p.jobs.failed > 0 && <span className="error"> · {p.jobs.failed} failed</span>}
                {p.plugin_type === 1 && p.results > 0 && <div className="muted">{p.results} results</div>}
              </td>
              <td className="muted small">{p.last_job_at ? ago(p.last_job_at) : "never"}</td>
              <td className="small" data-testid="served-by">
                {p.workers.length > 0 ? p.workers.map((w) => <span key={w.name} className="status status-running">{w.name}</span>) : <span className="muted">no worker connected</span>}
              </td>
              <td className="muted small">{p.products.map((x) => x.name).join(", ")}</td>
            </tr>
          ))}
          {overview.data && items.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No plugins registered. A queue worker registers its plugins when it starts.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {(overview.data?.workers.length ?? 0) > 0 && (
        <p className="muted small">
          Workers connected now: {overview.data?.workers.map((w) => `${w.name} (${w.kinds.join(", ")})`).join(" · ")}
        </p>
      )}
    </div>
  );
}
