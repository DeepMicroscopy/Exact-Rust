import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { FloatingPanel } from "./FloatingPanel";
import { volumeText, type LinkedFile } from "./LinkSegmentationDialog";

interface Voxel {
  x: number;
  y: number;
  z: number;
}

/** What each linked file shows over the planes: the hidden segments (by index) and whether it is shown at all. */
export interface LinkedView {
  hidden: number[];
  off: boolean;
}

/** The segment of a file under the crosshair; asked for once the crosshair has rested for a moment. */
function Here({ file, voxel }: { file: LinkedFile; voxel: Voxel }) {
  const [at, setAt] = useState(voxel);
  useEffect(() => {
    const t = window.setTimeout(() => setAt(voxel), 120);
    return () => window.clearTimeout(t);
  }, [voxel]);
  const q = useQuery({
    queryKey: ["linked-at", file.id, at.x, at.y, at.z],
    queryFn: () => api<{ segment: { index: number; name: string; color: string } | null }>(`/api/v2/linked-volumes/${file.id}/at?x=${at.x}&y=${at.y}&z=${at.z}`),
    staleTime: Infinity,
    placeholderData: (p) => p,
  });
  const g = q.data?.segment;
  return (
    <p className="linked-here small" data-testid="linked-here">
      <span className="muted">At the crosshair: </span>
      {g ? (
        <>
          <span className="seg-swatch" style={{ background: g.color }} aria-hidden="true" /> {g.name}
        </>
      ) : (
        <span className="muted">no segment</span>
      )}
    </p>
  );
}

/**
 * The segmentation files linked to the volume, read-only: switch a file or single segments on and off, the opacity of the
 * overlay, the segment under the crosshair. The overlay itself is drawn by the planes.
 */
export function LinkedPanel({ files, view, onView, opacity, onOpacity, voxel, onImport, onClose }: { files: LinkedFile[]; view: Record<number, LinkedView>; onView(id: number, v: LinkedView): void; opacity: number; onOpacity(o: number): void; voxel: Voxel | null; /** turn the segments into annotations (absent: not allowed here) */ onImport?(file: LinkedFile): void; onClose(): void }) {
  return (
    <FloatingPanel title="Segmentation" onClose={onClose} storageKey="exact.linkedpanel" initial={{ right: Math.max(12, window.innerWidth - 300), top: 70 }} className="linked-panel">
      {files.map((f) => {
        const v = view[f.id] ?? { hidden: [], off: false };
        const set = (p: Partial<LinkedView>) => onView(f.id, { ...v, ...p });
        return (
          <section key={f.id} className="linked-file" data-testid="linked-file">
            <label className="linked-title" title={f.filename}>
              <input type="checkbox" checked={!v.off} onChange={(e) => set({ off: !e.target.checked })} aria-label={`Show ${f.name}`} />
              <span className="linked-name">{f.name}</span>
            </label>
            {f.geometry && !f.geometry.fits && (
              <p className="error small" role="alert">
                Only {Math.round(f.geometry.kept * 100)} % of the labelled volume lies inside this volume.
              </p>
            )}
            <ul className="seg-list" aria-label="Segments">
              {f.segments.map((g) => {
                const shown = !v.hidden.includes(g.index);
                return (
                  <li key={g.index} className={v.off ? "dim" : ""}>
                    <label>
                      <input type="checkbox" checked={shown} disabled={v.off} onChange={() => set({ hidden: shown ? [...v.hidden, g.index] : v.hidden.filter((i) => i !== g.index) })} aria-label={g.name} />
                      <span className="seg-swatch" style={{ background: g.color }} aria-hidden="true" />
                      <span className="seg-name">{g.name}</span>
                    </label>
                    <span className="muted small">{volumeText(g.volume_mm3)}</span>
                  </li>
                );
              })}
            </ul>
            {f.segments.length > 1 && (
              <p className="linked-all">
                <button className="btn ghost small" onClick={() => set({ hidden: [] })}>
                  Show all
                </button>
                <button className="btn ghost small" onClick={() => set({ hidden: f.segments.map((g) => g.index) })}>
                  Hide all
                </button>
              </p>
            )}
            {voxel && !v.off && <Here file={f} voxel={voxel} />}
            {onImport && (
              <p className="linked-all">
                <button className="btn small" onClick={() => onImport(f)} data-testid="import-open" title="Make annotations (masks) of the segments: they can then be edited">
                  Import as annotations…
                </button>
              </p>
            )}
          </section>
        );
      })}
      <label className="linked-opacity small">
        <span className="muted">Opacity</span>
        <input type="range" min={0.1} max={1} step={0.05} value={opacity} onChange={(e) => onOpacity(Number(e.target.value))} aria-label="Opacity of the segmentation" />
      </label>
      <p className="muted small">The file itself is read-only. Importing makes annotations (masks) of its segments; the file stays linked.</p>
    </FloatingPanel>
  );
}
