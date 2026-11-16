import type { PaletteEntry } from "../viewer-core/palette";

export interface LabelState {
  entry: PaletteEntry;
  /** the label is set (on this frame) */
  set: boolean;
}

/**
 * The labels of the whole image (global annotation types), shown on the image: a set one is a filled chip in the colour of its type,
 * one that is not set is an outline. A click sets or unsets it (the same as Shift + digit and the Labels menu in the toolbox).
 * On an image with frames the labels are those of the frame shown. Someone who may not annotate sees the set ones only.
 */
export function GlobalLabels({ labels, frame, canEdit, onToggle }: { labels: LabelState[]; frame: number | null; canEdit: boolean; onToggle(typeId: number): void }) {
  const shown = canEdit ? labels : labels.filter((l) => l.set);
  if (shown.length === 0) return null;
  return (
    <div className="global-labels" role="group" aria-label="Labels of the whole image" data-testid="global-labels">
      <div className="global-labels-bar glass">
        {frame != null && <span className="gl-frame muted small" title="The labels set on this frame">Frame {frame}</span>}
        {shown.map(({ entry, set }) => (
          <button
            key={entry.id}
            type="button"
            className={`label-chip ${set ? "set" : ""}`}
            style={{ "--c": entry.color } as React.CSSProperties}
            aria-pressed={set}
            disabled={!canEdit}
            data-testid="label-chip"
            data-set={set ? "1" : "0"}
            title={canEdit ? (set ? `${entry.name}: set. Click to remove it.` : `${entry.name}: not set. Click to set it.`) : `${entry.name}`}
            onClick={() => onToggle(entry.id)}
          >
            <span className="dot" aria-hidden />
            <span className="name">{entry.name}</span>
            <span className="state" aria-hidden>
              {set ? "✓" : "+"}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
