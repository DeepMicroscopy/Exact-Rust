import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";

interface RepairStatus {
  status: "none" | "running" | "done" | "failed" | "restored";
  progress?: number;
  message?: string;
  backup_file?: string | null;
}

/**
 * Offers a one-time repair of a damaged image file (rebuilt zoom pyramid). The original stays on disk as a backup;
 * progress is polled while the job runs and the viewer reloads when it is done.
 */
export function RepairBanner({ imageId, damaged }: { imageId: number; damaged: boolean }) {
  const qc = useQueryClient();
  const key = ["repair", imageId];
  const status = useQuery({
    queryKey: key,
    queryFn: () => api<RepairStatus>(`/api/v2/images/${imageId}/repair`),
    refetchInterval: (q) => (q.state.data?.status === "running" ? 1000 : false),
    staleTime: 0,
  });
  const start = useMutation({
    mutationFn: () => api<RepairStatus>(`/api/v2/images/${imageId}/repair`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  const undo = useMutation({
    mutationFn: () => api(`/api/v2/images/${imageId}/repair/restore`, { method: "POST" }),
    onSuccess: () => window.location.reload(),
  });

  // a running repair that finishes changes the file: reload so that tiles and metadata are fetched again
  const wasRunning = useRef(false);
  const current = status.data?.status;
  useEffect(() => {
    if (current === "running") wasRunning.current = true;
    else if (wasRunning.current && current === "done") window.location.reload();
  }, [current]);

  const s = status.data;
  const error = start.error instanceof ApiError ? start.error.detail : undo.error instanceof ApiError ? undo.error.detail : null;

  if (s?.status === "running") {
    const pct = Math.round((s.progress ?? 0) * 100);
    return (
      <div className="repair glass" role="status">
        <div className="repair-head">
          <span className="spinner" aria-hidden="true" />
          <span>Repairing the image file… {pct}%</span>
        </div>
        <div className="bar">
          <div style={{ width: `${Math.max(pct, 3)}%` }} />
        </div>
        <div className="muted small">The original file is kept. You can leave this page; the repair continues.</div>
      </div>
    );
  }
  if (damaged) {
    return (
      <div className="repair glass">
        <div>
          <strong>This image file is damaged.</strong> Its zoomed-out levels are not copies of the full image, so views at low zoom can be wrong.
          It can be repaired once; the full-resolution pixels are not changed and the original file is kept as a backup.
        </div>
        {s?.status === "failed" && <div className="error small">Last attempt failed: {s.message}</div>}
        {error && <div className="error small">{error}</div>}
        <button className="btn primary" disabled={start.isPending} onClick={() => start.mutate()}>
          Repair file
        </button>
      </div>
    );
  }
  if (s?.status === "done" && s.backup_file) {
    return (
      <div className="repair glass ok small">
        File repaired. Original kept as <code>{s.backup_file}</code>.{" "}
        <button className="link" disabled={undo.isPending} onClick={() => undo.mutate()}>
          Undo
        </button>
        {error && <span className="error"> {error}</span>}
      </div>
    );
  }
  return null;
}
