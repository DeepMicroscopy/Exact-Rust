import type { PaletteEntry } from "../viewer-core/palette";

export interface LabelState {
  entry: PaletteEntry;
  /** the label is set (on this frame) */
  set: boolean;
}

/**
 * The labels of the whole image (global annotation types), listed under the annotation types in the side panel: a ticked row is set.
 * A click sets or unsets it (the same as Shift + digit and the Labels menu in the toolbox). On an image with frames the labels are
 * those of the frame shown. Someone who may not annotate sees the set ones only.
 */
export function GlobalLabels({ labels, frame, canEdit, onToggle }: { labels: LabelState[]; frame: number | null; canEdit: boolean; onToggle(typeId: number): void }) {
  const shown = canEdit ? labels : labels.filter((l) => l.set);
  if (shown.length === 0) return null;
  return (
    <div className="side-labels" role="group" aria-label="Labels of the whole image" data-testid="global-labels">
      <div className="side-labels-title">
        Labels
        {frame != null && (
          <span className="gl-frame muted" title="The labels set on this frame">
            Frame {frame}
          </span>
        )}
      </div>
      {shown.map(({ entry, set }) => (
        <label
          key={entry.id}
          className={`type-row label-row ${set ? "set" : ""}`}
          style={{ "--c": entry.color } as React.CSSProperties}
          data-testid="label-chip"
          data-set={set ? "1" : "0"}
          title={canEdit ? (set ? `${entry.name}: set for the whole image. Click to remove it.` : `${entry.name}: not set. Click to set it for the whole image.`) : entry.name}
        >
          <input type="checkbox" checked={set} disabled={!canEdit} onChange={() => onToggle(entry.id)} aria-label={entry.name} />
          <span className="swatch" style={{ background: entry.color }} />
          <span className="type-name">{entry.name}</span>
        </label>
      ))}
    </div>
  );
}
