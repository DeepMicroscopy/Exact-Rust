import { Dropdown, type DropdownItem } from "./Dropdown";
import type { BrushMode, PolyOp } from "../viewer-core/editor";
import { formatArea, formatLength, measureShape } from "../viewer-core/measure";
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
  /** the selected annotation as it is now (while it is being dragged: the preview) */
  selected: Shape | null;
  selectedType: PaletteEntry | null;
  selectedVertex: number | null;
  draftPoints: number;
  /** scissors / glue / knife in progress */
  polyOp: PolyOp | null;
  brushMode: BrushMode;
  brushRadius: number;
  /** the selected annotation is a polygon whose shape may be changed by brush and operations */
  reshapable: boolean;
  canUndo: boolean;
  canRedo: boolean;
  annotationsShown: boolean;
  imageMpp: number;
  on: {
    select(): void;
    polyOp(op: PolyOp): void;
    brush(mode: BrushMode): void;
    brushRadius(r: number): void;
    draw(typeId: number): void;
    oneClick(on: boolean): void;
    finish(): void;
    cancel(): void;
    remove(): void;
    removeVertex(): void;
    changeType(typeId: number): void;
    toggleGlobal(typeId: number): void;
    undo(): void;
    redo(): void;
    toggleAnnotations(): void;
  };
}

/** What the selection measures: area (boxes, polygons) or length (lines), with the pixel numbers as a tooltip. */
function Measure({ shape, mpp }: { shape: Shape; mpp: number }) {
  if (shape.vectorType === VectorType.Point) return null;
  const m = measureShape(shape);
  const px = `${Math.round(m.width)} × ${Math.round(m.height)} px`;
  if (m.areaPx2 != null)
    return (
      <span className="measure" title={`Area ${Math.round(m.areaPx2).toLocaleString("en-US")} px² (${px})${mpp > 0 ? "" : " – the image has no resolution"}`}>
        {formatArea(m.areaPx2, mpp)}
      </span>
    );
  if (m.lengthPx != null) return <span className="measure" title={px}>{formatLength(m.lengthPx, mpp)}</span>;
  return null;
}

const swatch = (c?: string) => <span className="swatch" style={{ background: c }} />;

/**
 * The tools follow the context. One row: Select / Draw, the type list (a drop-down: image sets have many types), and what
 * fits the situation: how to draw the chosen type, or, for a selected annotation, its type, area, reshaping
 * and delete. Large touch targets; on narrow screens the row wraps.
 */
export function Toolbox(p: ToolboxProps) {
  const sel = p.selected;
  const current = p.palette.find((e) => e.id === p.currentTypeId);
  const draw = p.drawing ? current : undefined;
  const typeItems: DropdownItem[] = p.palette.map((e) => ({ id: e.id, label: e.name, color: e.color, key: e.key, checked: p.drawing && e.id === p.currentTypeId }));
  const convertible: DropdownItem[] = sel
    ? p.palette.filter((e) => canConvert(sel.vectorType, e.vectorType) || e.id === sel.typeId).map((e) => ({ id: e.id, label: e.name, color: e.color, key: e.key, checked: e.id === sel.typeId }))
    : [];
  const reshape: DropdownItem[] = [
    { id: "add", label: "Add area (Shift + drag)", checked: p.brushMode === "add" },
    { id: "erase", label: "Erase area (Alt + drag)", checked: p.brushMode === "erase" },
    { id: "scissors", label: "Cut away an area (S)", checked: p.polyOp === "scissors" },
    { id: "glue", label: "Merge an area (G)", checked: p.polyOp === "glue" },
    { id: "knife", label: "Split along a line (D)", checked: p.polyOp === "knife" },
  ];
  const pickReshape = (id: string | number) => {
    if (id === "add" || id === "erase") p.on.brush(p.brushMode === id ? "off" : id);
    else p.on.polyOp(id as PolyOp);
  };

  return (
    <div className="toolbox glass" role="toolbar" aria-label="Annotation tools">
      <div className="seg" role="group">
        <button className={!p.drawing ? "active" : ""} onClick={p.on.select} aria-label="Select" title="Select and edit annotations (C)">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path d="M5 3l14 8-6.2 1.6L9.6 19z" fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      <span className="v-sep" role="separator" aria-orientation="vertical" />
      <div className="add-group">
        <div className="seg" role="group">
          <button className={p.drawing ? "active" : ""} onClick={() => p.currentTypeId != null && p.on.draw(p.currentTypeId)} disabled={p.palette.length === 0} aria-label="Add annotation" title="Add annotations of the type on the right (C)">
            ＋ Add annotation
          </button>
        </div>
      {(p.drawing || !sel) && (
      <Dropdown className="type-dd" name="types" items={typeItems} onPick={(id) => p.on.draw(Number(id))} disabled={p.palette.length === 0} title="Annotation type to draw (digit keys 1-9)">
        {current ? (
          <>
            {swatch(current.color)}
            {current.key != null && <kbd>{current.key}</kbd>}
            <span className="dd-label">{current.name}</span>
          </>
        ) : (
          <span className="muted">No types</span>
        )}
      </Dropdown>
      )}
      </div>
      {p.palette.length === 0 && <span className="muted small">This image set has no annotation types (assign a product to it).</span>}

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
          <Dropdown className="sel-type-dd" name="selected-type" items={convertible} onPick={(id) => p.on.changeType(Number(id))} title="Type of the selected annotation (digit keys change it)">
            {swatch(p.selectedType?.color)}
            <span className="dd-label">{p.selectedType?.name ?? `type ${sel.typeId}`}</span>
          </Dropdown>
          <Measure shape={sel} mpp={p.imageMpp} />
          {p.reshapable && (
            <Dropdown className="reshape-dd" name="reshape" items={reshape} onPick={pickReshape} title="Reshape the polygon: paint area on or off, cut, merge, split">
              Reshape
            </Dropdown>
          )}
          {p.brushMode !== "off" && (
            <label className="toggle brush-size" title="Brush size (mouse wheel)">
              {p.brushMode === "add" ? "Add" : "Erase"}
              <input type="range" min={4} max={120} value={Math.round(p.brushRadius)} onChange={(e) => p.on.brushRadius(Number(e.target.value))} />
            </label>
          )}
          {p.polyOp && (
            <>
              <span className="hint">
                {p.polyOp === "scissors" ? "Click the corners of the area to cut away" : p.polyOp === "glue" ? "Click the corners of the area to add" : "Click along the line that splits the polygon"} · Enter applies · Esc
              </span>
              {p.draftPoints > 0 && (
                <button className="btn" onClick={p.on.finish}>
                  Apply
                </button>
              )}
            </>
          )}
          {p.selectedVertex != null && (
            <button className="btn" onClick={p.on.removeVertex} title="Remove the vertex (Delete)">
              Remove vertex
            </button>
          )}
          <button className="btn danger" onClick={p.on.remove} title="Delete (Delete, Backspace, X)">
            Delete
          </button>
        </div>
      )}

      {p.globals.length > 0 && (
        <Dropdown
          className="labels-dd"
          name="labels"
          items={p.globals.map(({ entry, set }) => ({ id: entry.id, label: entry.name, color: entry.color, checked: set }))}
          onPick={(id) => p.on.toggleGlobal(Number(id))}
          title="Labels of the whole image"
        >
          Labels{p.globals.some((g) => g.set) ? ` (${p.globals.filter((g) => g.set).length})` : ""}
        </Dropdown>
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
