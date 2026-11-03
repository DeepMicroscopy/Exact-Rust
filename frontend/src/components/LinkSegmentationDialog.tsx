import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { Modal } from "./Modal";

export interface LinkedSegment {
  index: number;
  name: string;
  color: string;
  label: number;
  voxels: number;
  volume_mm3: number;
}

export interface Geometry {
  coverage: number;
  kept: number;
  fits: boolean;
}

export interface LinkedFile {
  id: number;
  name: string;
  filename: string;
  set: number;
  image: number | null;
  size: number;
  segments: LinkedSegment[];
  geometry: Geometry | null;
  /** when it was added (ISO) */
  time: string;
}

interface Detail extends LinkedFile {
  volumes: { id: number; name: string; score: number }[];
}

/** A pick is made for the user when the file's name says which volume it belongs to. */
const CONFIDENT = 0.6;

export const volumeText = (mm3: number) => (mm3 >= 1000 ? `${(mm3 / 1000).toFixed(mm3 >= 100000 ? 0 : 1)} ml` : `${mm3.toFixed(0)} mm³`);

/**
 * Links a segmentation file to a NIfTI volume of its image set: the segments it contains, the volumes in the set with the
 * best name match first, and what the fit looks like once linked. Nothing is imported as annotations here.
 */
export function LinkSegmentationDialog({ id, onClose, onChanged, onLinked }: { id: number; onClose(): void; onChanged(): void; onLinked?(image: number): void }) {
  const qc = useQueryClient();
  const file = useQuery({ queryKey: ["linked", id], queryFn: () => api<Detail>(`/api/v2/linked-volumes/${id}`), staleTime: 0 });
  const [choice, setChoice] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fit, setFit] = useState<Geometry | null>(null);
  const d = file.data;
  useEffect(() => {
    if (d && choice == null) setChoice(d.image ?? (d.volumes[0] && d.volumes[0].score >= CONFIDENT ? d.volumes[0].id : null));
  }, [d, choice]);

  const done = () => {
    void qc.invalidateQueries({ queryKey: ["linked", id] });
    void qc.invalidateQueries({ queryKey: ["linked-set"] });
    void qc.invalidateQueries({ queryKey: ["linked-image"] });
    void qc.invalidateQueries({ queryKey: ["related"] });
    onChanged();
  };
  const link = async () => {
    if (choice == null) return;
    setBusy(true);
    setError(null);
    try {
      const f = await api<LinkedFile>(`/api/v2/linked-volumes/${id}`, { method: "PUT", json: { image: choice } });
      done();
      if (f.geometry && !f.geometry.fits) setFit(f.geometry);
      else {
        onClose();
        onLinked?.(choice);
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Segmentation file" onClose={onClose}>
      {file.isLoading && <p className="muted">Loading…</p>}
      {file.isError && <p className="error">The file was not found.</p>}
      {d && (
        <div className="link-seg" data-testid="link-seg">
          <p>
            <strong>{d.filename}</strong>
            <span className="muted small"> · {d.segments.length} segment{d.segments.length === 1 ? "" : "s"}</span>
          </p>
          <ul className="seg-list">
            {d.segments.map((g) => (
              <li key={g.index}>
                <span className="seg-id">
                  <span className="seg-swatch" style={{ background: g.color }} aria-hidden="true" />
                  <span className="seg-name">{g.name}</span>
                </span>
                <span className="muted small">{volumeText(g.volume_mm3)}</span>
              </li>
            ))}
          </ul>
          {fit ? (
            <>
              <p className="error" role="alert">
                Linked, but only {Math.round(fit.kept * 100)} % of the labelled volume lies inside this volume. Is it the segmentation of this scan?
              </p>
              <div className="modal-actions">
                <button className="btn" onClick={() => setFit(null)}>
                  Choose another volume
                </button>
                <button
                  className="btn primary"
                  onClick={() => {
                    onClose();
                    if (choice != null) onLinked?.(choice);
                  }}
                >
                  Keep it
                </button>
              </div>
            </>
          ) : (
            <>
              <label className="field">
                <span>Volume it belongs to</span>
                <select value={choice ?? ""} onChange={(e) => setChoice(e.target.value ? Number(e.target.value) : null)} data-testid="link-volume">
                  <option value="">{d.volumes.length ? "Choose a volume…" : "There is no NIfTI volume in this image set"}</option>
                  {d.volumes.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                      {v.score >= CONFIDENT ? "  ← matches the file name" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted small">The segmentation is shown read-only over the volume in the three-plane view. Importing it as annotations is a separate step.</p>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <div className="modal-actions">
                <button className="btn" onClick={onClose}>
                  {d.image ? "Close" : "Later"}
                </button>
                <button className="btn primary" onClick={() => void link()} disabled={choice == null || busy || choice === d.image} data-testid="link-go">
                  {d.image ? "Link to this volume instead" : "Link"}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
