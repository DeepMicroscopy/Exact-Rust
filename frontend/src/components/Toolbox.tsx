import type { PaletteEntry } from "../viewer-core/palette";
import { canConvert, hintFor, oneClickCapable } from "../viewer-core/palette";
import type { Shape } from "../viewer-core/types";
import { VectorType } from "../viewer-core/types";

export interface ToolboxProps {
  palette: PaletteEntry[];
  globals: { entry: PaletteEntry; set: boolean }[];
  drawing: boolean;
  oneClick: boolean;
  currentTypeId: number | null;
  selected: Shape | null;
  selectedType: PaletteEntry | null;
  /** the signed-in user verified the selected annotation */
  verified: boolean;
  selectedVertex: number | null;
  draftPoints: number;
  canUndo: boolean;
  canRedo: boolean;
  annotationsShown: boolean;
  imageMpp: number;
  on: {
    select(): void;
    draw(typeId: number): void;
    oneClick(on: boolean): void;
    finish(): void;
    cancel(): void;
    remove(): void;
    removeVertex(): void;
    verify(v: boolean): void;
    changeType(typeId: number): void;
    toggleGlobal(typeId: number): void;
    undo(): void;
    redo(): void;
    toggleAnnotations(): void;
  };
}

const size = (s: Shape, mpp: number) => {
  const w = Math.round(s.bbox[2] - s.bbox[0]);
  const h = Math.round(s.bbox[3] - s.bbox[1]);
  const um = mpp > 0 ? ` (${((w * mpp) / 1000).toFixed(2)} × ${((h * mpp) / 1000).toFixed(2)} mm)` : "";
  return s.vectorType === VectorType.Point ? "point" : `${w} × ${h} px${um}`;
};

/**
 * The tools follow the context: with an annotation selected they edit it (type, verification, delete, vertices), while
 * drawing they show how to draw the chosen type, otherwise they offer the types to start drawing with one tap.
 * Large touch targets: on narrow screens the bar wraps into rows instead of shrinking the buttons.
 */
export function Toolbox(p: ToolboxProps) {
  const sel = p.selected;
  const draw = p.drawing ? p.palette.find((e) => e.id === p.currentTypeId) : undefined;
  return (
    <div className="toolbox glass" role="toolbar" aria-label="Annotation tools">
      <div className="seg" role="group">
        <button className={!p.drawing ? "active" : ""} onClick={p.on.select} title="Select and edit annotations (C)">
          Select
        </button>
        <button className={p.drawing ? "active" : ""} onClick={() => p.currentTypeId != null && p.on.draw(p.currentTypeId)} disabled={p.palette.length === 0} title="Draw annotations (C)">
          Draw
        </button>
      </div>

      <div className="tool-group types" role="group" aria-label="Annotation types">
        {p.palette.map((e) => (
          <button key={e.id} className={`chip ${p.drawing && p.currentTypeId === e.id ? "active" : ""}`} style={{ borderColor: e.color }} onClick={() => p.on.draw(e.id)} title={`${e.name}${e.key ? ` (${e.key})` : ""}`}>
            <span className="swatch" style={{ background: e.color }} />
            {e.key != null && <kbd>{e.key}</kbd>}
            <span className="chip-name">{e.name}</span>
          </button>
        ))}
        {p.palette.length === 0 && <span className="muted small">This image set has no annotation types (assign a product to it).</span>}
      </div>

      {draw && (
        <div className="tool-group context">
          <span className="hint">{hintFor(draw, p.oneClick)}</span>
          {oneClickCapable(draw.vectorType) && (
            <label className="toggle" title="Every click places an annotation of the type's size (A)">
              <input type="checkbox" checked={p.oneClick} onChange={(e) => p.on.oneClick(e.target.checked)} />
              One-click
            </label>
          )}
          {p.draftPoints > 0 && (
            <>
              <button className="btn" onClick={p.on.finish} title="Finish (Enter, V)">
                Finish
              </button>
              <button className="btn ghost" onClick={p.on.cancel} title="Cancel (Esc)">
                Cancel
              </button>
            </>
          )}
        </div>
      )}

      {!p.drawing && sel && (
        <div className="tool-group context selection">
          <span className="swatch" style={{ background: p.selectedType?.color }} />
          <select
            aria-label="Type of the selected annotation"
            value={sel.typeId}
            onChange={(e) => p.on.changeType(Number(e.target.value))}
            title="Change the type (digit keys)"
          >
            {p.palette
              .filter((e) => canConvert(sel.vectorType, e.vectorType) || e.id === sel.typeId)
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            {!p.palette.some((e) => e.id === sel.typeId) && <option value={sel.typeId}>{p.selectedType?.name ?? `type ${sel.typeId}`}</option>}
          </select>
          <span className="muted small">{size(sel, p.imageMpp)}</span>
          <button className={`btn ${p.verified ? "primary" : ""}`} onClick={() => p.on.verify(!p.verified)} title={p.verified ? "You verified this annotation: click to take it back" : "Verify this annotation"}>
            {p.verified ? "Verified ✓" : "Verify"}
          </button>
          {p.selectedVertex != null && (
            <button className="btn" onClick={p.on.removeVertex} title="Remove the vertex (Delete)">
              Remove vertex
            </button>
          )}
          <button className="btn danger" onClick={p.on.remove} title="Delete (Delete, Backspace, X)">
            Delete
          </button>
          {(sel.vectorType === VectorType.Polygon || sel.vectorType === VectorType.MultiLine) && <span className="hint">Drag a vertex, drag a dot between two to add one</span>}
          {sel.vectorType === VectorType.BoundingBox && <span className="hint">Drag to move · drag a handle to resize</span>}
          {(sel.vectorType === VectorType.FixedSizeBoundingBox || sel.vectorType === VectorType.Point) && <span className="hint">Drag to move</span>}
        </div>
      )}

      {!p.drawing && !sel && p.palette.length > 0 && <span className="hint idle">Click an annotation to edit it, or pick a type to draw</span>}

      {p.globals.length > 0 && (
        <div className="tool-group" role="group" aria-label="Image labels">
          {p.globals.map(({ entry, set }) => (
            <button key={entry.id} className={`chip ${set ? "active" : ""}`} style={{ borderColor: entry.color }} onClick={() => p.on.toggleGlobal(entry.id)} title={`${entry.name} (label of the whole image)`}>
              <span className="swatch" style={{ background: entry.color }} />
              <span className="chip-name">{entry.name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="tool-group right">
        <button className="btn ghost" onClick={p.on.undo} disabled={!p.canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">
          ↶
        </button>
        <button className="btn ghost" onClick={p.on.redo} disabled={!p.canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
          ↷
        </button>
        <button className={`btn ghost ${p.annotationsShown ? "" : "off"}`} onClick={p.on.toggleAnnotations} title="Show or hide annotations (Y)">
          {p.annotationsShown ? "Hide" : "Show"}
        </button>
      </div>
    </div>
  );
}
