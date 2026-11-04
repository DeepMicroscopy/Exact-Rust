import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { Modal } from "./Modal";

interface Stats {
  annotations: number;
  images: number;
  verifications: number;
  teams: { id: number; name: string; annotations: number; images: number }[];
  per_day: { day: string; annotations: number }[];
}

/** What the signed-in user has done: totals, per team, and the annotations of the last 30 days. */
export function UserStatisticsDialog({ onClose }: { onClose(): void }) {
  const q = useQuery({ queryKey: ["my-statistics"], queryFn: () => api<Stats>("/api/v2/me/statistics"), staleTime: 0 });
  const d = q.data;
  const max = Math.max(1, ...(d?.per_day.map((x) => x.annotations) ?? []));
  const recent = d?.per_day.reduce((n, x) => n + x.annotations, 0) ?? 0;
  return (
    <Modal title="User statistics" onClose={onClose}>
      {q.isLoading && <p className="muted">Counting…</p>}
      {q.error && <p className="error">Could not load the statistics.</p>}
      {d && (
        <div data-testid="user-statistics">
          <p className="stat-summary">
            <b>{d.annotations}</b> annotations · <b>{d.images}</b> images uploaded · <b>{d.verifications}</b> verifications
          </p>
          <h4>Annotations in the last 30 days ({recent})</h4>
          <div className="day-bars" role="img" aria-label={`Annotations per day, ${recent} in the last 30 days`}>
            {d.per_day.map((x) => (
              <span key={x.day} title={`${x.day}: ${x.annotations}`} style={{ height: `${Math.max(2, (x.annotations / max) * 100)}%` }} className={x.annotations ? "" : "none"} />
            ))}
          </div>
          {d.teams.length > 0 && (
            <>
              <h4>Per team</h4>
              <table className="stat-table">
                <thead>
                  <tr>
                    <th>Team</th>
                    <th>Annotations</th>
                    <th>Images uploaded</th>
                  </tr>
                </thead>
                <tbody>
                  {d.teams.map((t) => (
                    <tr key={t.id}>
                      <td>{t.name}</td>
                      <td>{t.annotations}</td>
                      <td>{t.images}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
