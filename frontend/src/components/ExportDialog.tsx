import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { ExportFormatEditor } from "./ExportFormatEditor";
import { Modal } from "./Modal";

interface Format {
  id: number;
  name: string;
  image_aggregation: boolean;
}
interface ExportRow {
  id: number;
  time: string;
  annotation_count: number;
  filename: string;
  user: string | null;
  format: string | null;
  deprecated: boolean;
}

/** Exports of the annotations of an image set in one of the export formats; earlier exports can be downloaded again. */
export function ExportDialog({ setId, canCreate, canDelete, onClose }: { setId: number; canCreate: boolean; canDelete: boolean; onClose(): void }) {
  const qc = useQueryClient();
  const formats = useQuery({ queryKey: ["export-formats", setId], queryFn: () => api<{ items: Format[] }>(`/api/v2/image-sets/${setId}/export-formats`), staleTime: 0 });
  const exports = useQuery({ queryKey: ["exports", setId], queryFn: () => api<{ items: ExportRow[] }>(`/api/v2/image-sets/${setId}/exports`), staleTime: 0 });
  const [format, setFormat] = useState<number | null>(null);
  const chosen = format ?? formats.data?.items[0]?.id ?? null;
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ id: number | null } | null>(null);
  const removeFormat = useMutation({
    mutationFn: (id: number) => api(`/api/v2/export-formats/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setFormat(null);
      void qc.invalidateQueries({ queryKey: ["export-formats", setId] });
    },
    onError: (e) => setError(e instanceof ApiError || e instanceof Error ? e.message : String(e)),
  });
  const create = useMutation({
    mutationFn: () => api<{ id: number }>(`/api/v2/image-sets/${setId}/exports`, { json: { format: chosen } }),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ["exports", setId] });
    },
    onError: (e) => setError(e instanceof ApiError || e instanceof Error ? e.message : String(e)),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api(`/api/v2/exports/${id}`, { method: "DELETE" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["exports", setId] }),
  });
  return (
    <Modal title="Export annotations" onClose={onClose} wide>
      {canCreate && (
        <div className="export-new">
          {formats.data && formats.data.items.length === 0 && <p className="muted">There is no export format yet. A member of a team creates one (it defines which annotation types and how they are written).</p>}
          {formats.data && formats.data.items.length > 0 && (
            <label className="field">
              <span>Format</span>
              <select aria-label="Export format" value={chosen ?? ""} onChange={(e) => setFormat(Number(e.target.value))}>
                {formats.data.items.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                    {f.image_aggregation ? " (per image)" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button className="btn primary" disabled={chosen == null || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Exporting…" : "Create export"}
          </button>
          <button className="btn" onClick={() => setEditor({ id: null })}>
            New format…
          </button>
          {chosen != null && (
            <>
              <button className="btn ghost" onClick={() => setEditor({ id: chosen })}>
                Edit format…
              </button>
              <button className="btn ghost" onClick={() => window.confirm("Delete this export format? Earlier exports stay.") && removeFormat.mutate(chosen)}>
                Delete format
              </button>
            </>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <h3>Earlier exports</h3>
      {exports.data && exports.data.items.length === 0 && <p className="muted">None yet.</p>}
      <table className="exports" data-testid="exports">
        <tbody>
          {(exports.data?.items ?? []).map((x) => (
            <tr key={x.id}>
              <td>
                <a href={`/api/v2/exports/${x.id}/download`} download>
                  {x.filename}
                </a>
              </td>
              <td className="muted small">
                {x.annotation_count} annotations · {x.format ?? "format deleted"} · {x.user ?? "?"} · {new Date(x.time).toLocaleString()}
                {x.deprecated ? " · the format changed since" : ""}
              </td>
              <td>
                {canDelete && (
                  <button className="btn ghost small" onClick={() => remove.mutate(x.id)} aria-label={`Delete ${x.filename}`}>
                    Delete
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editor && (
        <ExportFormatEditor
          formatId={editor.id}
          onClose={() => setEditor(null)}
          onSaved={(id) => {
            setFormat(id);
            void qc.invalidateQueries({ queryKey: ["export-formats", setId] });
          }}
        />
      )}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
