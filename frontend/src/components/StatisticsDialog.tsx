import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { Modal } from "./Modal";

interface Stats {
  storage_gb: number;
  total_images: number;
  total_annotations: number;
  extensions: { ext: string; count: number; size_gb: number }[];
  image_types: { type: string; count: number }[];
  annotation_types: { name: string; color: string | null; count: number }[];
}

const gb = (v: number) => (v < 1 ? `${(v * 1024).toFixed(v * 1024 < 10 ? 1 : 0)} MB` : `${v.toFixed(2)} GB`);

function Bars({ rows, label }: { rows: { key: string; value: number; text: string; color?: string | null }[]; label: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <table className="stat-bars" aria-label={label}>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td className="stat-name">{r.key}</td>
            <td className="stat-bar">
              <span style={{ width: `${(r.value / max) * 100}%`, background: r.color ?? "var(--purple)" }} />
            </td>
            <td className="stat-value">{r.text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Storage, kinds of files and annotation types of a team. */
export function StatisticsDialog({ teamId, teamName, onClose }: { teamId: number; teamName: string; onClose(): void }) {
  const stats = useQuery({ queryKey: ["team-statistics", teamId], queryFn: () => api<Stats>(`/api/v2/teams/${teamId}/statistics`), staleTime: 60_000 });
  const d = stats.data;
  return (
    <Modal title={`Statistics: ${teamName}`} onClose={onClose}>
      {stats.isLoading && <p className="muted">Counting… (large teams take a moment)</p>}
      {stats.error && <p className="error">{stats.error instanceof ApiError || stats.error instanceof Error ? stats.error.message : String(stats.error)}</p>}
      {d && (
        <div data-testid="statistics">
          <p className="stat-summary">
            <b>{d.total_images}</b> images · <b>{d.total_annotations}</b> annotations · <b>{gb(d.storage_gb)}</b> on disk
          </p>
          {d.image_types.length > 0 && (
            <>
              <h4>Kinds of images</h4>
              <Bars label="Kinds of images" rows={d.image_types.map((t) => ({ key: t.type, value: t.count, text: String(t.count) }))} />
            </>
          )}
          {d.extensions.length > 0 && (
            <>
              <h4>File types</h4>
              <Bars label="File types" rows={d.extensions.map((e) => ({ key: e.ext, value: e.count, text: `${e.count} · ${gb(e.size_gb)}` }))} />
            </>
          )}
          {d.annotation_types.length > 0 && (
            <>
              <h4>Annotations by type</h4>
              <Bars label="Annotations by type" rows={d.annotation_types.map((a) => ({ key: a.name, value: a.count, text: String(a.count), color: a.color }))} />
            </>
          )}
        </div>
      )}
      <div className="modal-actions">
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
