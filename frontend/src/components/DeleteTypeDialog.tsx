import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiError } from "../api/client";
import { Modal } from "./Modal";

interface Place {
  image: number;
  name: string;
  image_set: number;
  image_set_name: string;
  annotations: number;
  deleted: number;
  versions: number;
  results: number;
}
interface Usage {
  name: string;
  annotations: number;
  deleted: number;
  versions: number;
  results: number;
  places: Place[];
}

/**
 * Deleting an annotation type: says what is still tied to it, image by image. Live annotations and plugin results have to be removed
 * where they are; annotations that were deleted (and could be restored) can go for good together with the type, after a warning.
 */
export function DeleteTypeDialog({ type, onClose, onDone }: { type: { id: number; name: string }; onClose(): void; onDone(): void }) {
  const usage = useQuery({ queryKey: ["type-usage", type.id], queryFn: () => api<Usage>(`/api/v2/annotation-types/${type.id}/usage`), gcTime: 0 });
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const u = usage.data;
  const free = !!u && u.annotations + u.deleted + u.versions + u.results === 0;
  // versions that hang on deleted annotations go with them; the others (and live annotations, plugin results) stop the deletion
  const blocked = !!u && (u.annotations > 0 || u.results > 0);
  const purge = !!u && !free && !blocked;
  const go = () =>
    api(`/api/v2/annotation-types/${type.id}${purge ? "?purge_deleted=true" : ""}`, { method: "DELETE" }).then(onDone, (e) => setError(e instanceof ApiError ? e.message : String(e)));
  const label = (p: Place) =>
    [p.annotations && `${p.annotations} annotation${p.annotations === 1 ? "" : "s"}`, p.deleted && `${p.deleted} deleted`, p.versions && `${p.versions} in versions of the set`, p.results && `${p.results} plugin result${p.results === 1 ? "" : "s"}`].filter(Boolean).join(", ");
  return (
    <Modal title={`Delete the annotation type ${type.name}`} onClose={onClose} wide>
      <div data-testid="delete-type">
        {usage.isLoading && <p className="muted">Looking for what uses the type…</p>}
        {usage.isError && <p className="error" role="alert">{String((usage.error as Error).message)}</p>}
        {free && <p>Nothing uses this type. (Deactivate it instead of deleting it if you only want it out of the way.)</p>}
        {u && !free && (
          <>
            <p>
              {blocked ? "This type cannot be deleted yet: " : "This type is still tied to: "}
              {u.annotations > 0 && <b>{u.annotations} annotation{u.annotations === 1 ? "" : "s"}</b>}
              {u.annotations > 0 && (u.deleted || u.versions || u.results) ? ", " : ""}
              {u.deleted > 0 && <b>{u.deleted} deleted annotation{u.deleted === 1 ? "" : "s"}</b>}
              {u.deleted > 0 && (u.versions || u.results) ? ", " : ""}
              {u.versions > 0 && <b>{u.versions} in versions of image sets</b>}
              {u.versions > 0 && u.results ? ", " : ""}
              {u.results > 0 && <b>{u.results} plugin result{u.results === 1 ? "" : "s"}</b>}.
            </p>
            <table className="small" data-testid="delete-type-places">
              <thead>
                <tr><th>Image set</th><th>Image</th><th>What</th></tr>
              </thead>
              <tbody>
                {u.places.map((p) => (
                  <tr key={p.image}>
                    <td>{p.image_set_name}</td>
                    <td><a href={`/images/${p.image}`} target="_blank" rel="noreferrer">{p.name}</a></td>
                    <td>{label(p)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {blocked && <p className="muted small">Remove the annotations (and the plugin results) of this type where they are listed, or change them to another type, then delete the type.</p>}
            {purge && (
              <div className="notice warn" role="alert" data-testid="delete-type-warning">
                <p>
                  <b>This cannot be undone.</b> The {u.deleted} deleted annotation{u.deleted === 1 ? "" : "s"} listed above can still be restored today. Deleting the type removes them <b>for good</b>, with
                  everything that hangs on them{u.versions > 0 ? `, including ${u.versions} entr${u.versions === 1 ? "y" : "ies"} in versions of image sets (the saved states of those sets then lack these annotations)` : ""}. Exports and the API will not show them any more.
                </p>
                <label className="check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} data-testid="delete-type-ack" /> I understand, remove them for good</label>
              </div>
            )}
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions" style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button className="btn" onClick={onClose}>{blocked ? "Close" : "Cancel"}</button>
          {(free || purge) && (
            <button className="btn danger" disabled={purge && !ack} onClick={() => void go()} data-testid="delete-type-go">
              {purge ? `Delete the type and ${u!.deleted} deleted annotation${u!.deleted === 1 ? "" : "s"} for good` : "Delete the type"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
