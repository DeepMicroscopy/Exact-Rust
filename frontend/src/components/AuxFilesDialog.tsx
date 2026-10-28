import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { Modal } from "./Modal";

interface AuxFile {
  id: number;
  name: string;
  filesize: number;
  time: string;
  creator: string | null;
}

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} kB` : `${(n / 1048576).toFixed(1)} MB`);

/** The documents (reports, tables, ...) uploaded into an image set: download and, with permission, delete. */
export function AuxFilesDialog({ setId, onChanged, onClose }: { setId: number; onChanged(): void; onClose(): void }) {
  const qc = useQueryClient();
  const files = useQuery({ queryKey: ["aux-files", setId], queryFn: () => api<{ files: AuxFile[]; can_delete: boolean }>(`/api/v2/image-sets/${setId}/auxiliary-files`), staleTime: 0 });
  const [error, setError] = useState<string | null>(null);
  const remove = (f: AuxFile) => {
    if (!window.confirm(`Delete ${f.name}?`)) return;
    api(`/api/v2/auxiliary-files/${f.id}`, { method: "DELETE" }).then(
      () => {
        void qc.invalidateQueries({ queryKey: ["aux-files", setId] });
        onChanged();
      },
      (e) => setError(e instanceof ApiError || e instanceof Error ? e.message : String(e)),
    );
  };
  return (
    <Modal title="Files of this image set" onClose={onClose}>
      {files.isLoading && <p className="muted">Loading…</p>}
      {files.data && files.data.files.length === 0 && <p className="muted">There are no files.</p>}
      {error && <p className="error">{error}</p>}
      {files.data && files.data.files.length > 0 && (
        <table className="admin-table" data-testid="aux-files">
          <tbody>
            {files.data.files.map((f) => (
              <tr key={f.id}>
                <td>
                  <a href={`/api/v2/auxiliary-files/${f.id}/download`} download>
                    {f.name}
                  </a>
                </td>
                <td className="muted small">{size(f.filesize)}</td>
                <td className="muted small">
                  {new Date(f.time).toLocaleDateString()}
                  {f.creator ? ` · ${f.creator}` : ""}
                </td>
                <td className="row-actions">
                  {files.data.can_delete && (
                    <button className="btn ghost small danger" onClick={() => remove(f)}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="modal-actions">
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
