import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FloatingPanel } from "./FloatingPanel";
import { copyTargets, formatVolume, sizeRange, type SizeUnit } from "../viewer-core/mpr3d";
import type { MaskState, Message, Op } from "../hooks/useSegment3D";

export type SegToolName = "brush" | "lasso" | "wand";

/** What the tools are set to; the plane panes read it when a stroke or a click happens. */
export interface SegTool {
  tool: SegToolName;
  /** the mode of the tools: add (+) or subtract (−); Alt turns it around while it is held */
  erase: boolean;
  /** brush: a sphere through the slices (true) or a disc in the plane (false) */
  ball: boolean;
  /** brush diameter, in pixels of the plane drawn in or in mm */
  size: number;
  unit: SizeUnit;
  /** wand: grow through the volume (true) or in the plane */
  wand3d: boolean;
  /** wand tolerance in percent of the grey range */
  tolerance: number;
  /** wand: stay within this radius (mm) of the click; 0 = no limit */
  maxRadiusMm: number;
  opacity: number;
}

export const DEFAULT_TOOL: SegTool = { tool: "brush", erase: false, ball: false, size: 12, unit: "px", wand3d: false, tolerance: 12, maxRadiusMm: 0, opacity: 0.55 };

interface Props {
  type: { name: string; color: string };
  state: MaskState | null;
  message: Message | null;
  busy: boolean;
  tool: SegTool;
  onTool(p: Partial<SegTool>): void;
  /** nothing but the readout and the opacity: a read-only account */
  readOnly: boolean;
  /** the axial slice of the crosshair and the number of axial slices (for "copy to the next slices") */
  z: number;
  slices: number;
  onOp(op: Op): void;
  onUndo(): void;
  onRedo(): void;
  onClose(): void;
  /** further buttons (the automatic segmentation) go below the others */
  extra?: ReactNode;
  /** the place in the top bar where the tools can be docked; null while there is none */
  dock: HTMLElement | null;
}

/** How much of the tools shows: a small palette, the whole window, or the palette in the top bar. */
export type PanelView = "compact" | "full" | "docked";
const VIEW_KEY = "exact.seg3d.view";

function storedView(): PanelView {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === "full" || v === "docked" ? v : "compact";
  } catch {
    return "compact";
  }
}

const KEYS: Record<SegToolName, string> = { brush: "B", lasso: "L", wand: "W" };
const NAMES: Record<SegToolName, string> = { brush: "Brush", lasso: "Lasso", wand: "Wand" };

/** The tool icons: a brush, a lasso (a loop with a rope end) and a magic wand with sparkles. */
function ToolIcon({ tool }: { tool: SegToolName }) {
  const common = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (tool === "brush")
    return (
      <svg {...common}>
        <path d="M18.5 3.5c1.4 1.4 1.4 3.2 0 4.6L11 15.6 8.4 13l7.5-7.5c1.4-1.4 1.6-1.4 2.6-2z" />
        <path d="M8.4 13C6 13 5 14.6 5 16.5c0 1.2-.6 2.2-1.6 3 3 .6 6.6.4 8-1.6.6-.9.6-2-.2-2.9z" />
      </svg>
    );
  if (tool === "lasso")
    return (
      <svg {...common} strokeDasharray="0">
        <ellipse cx="11" cy="9" rx="8" ry="5.5" strokeDasharray="2.6 2.4" />
        <path d="M5.5 13.2c-1 1.6-.4 3.6 1.4 3.8 1.5.2 2.2-1 1.6-2.2-.8-1.5-2.8-.8-2.4.8.5 1.8 2.4 3 4.6 3.6" />
      </svg>
    );
  return (
    <svg {...common}>
      <path d="M4 20 15 9" />
      <path d="m13.5 7.5 3 3" />
      <path d="M17 3v3M15.5 4.5h3M20.5 8v2.4M19.3 9.2h2.4M9 3.5v2M8 4.5h2" />
    </svg>
  );
}

function Slider({ label, value, min, max, step, show, onChange, testid }: { label: string; value: number; min: number; max: number; step: number; show: string; onChange(v: number): void; testid?: string }) {
  return (
    <label className="adjust-row">
      <span className="adjust-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} data-testid={testid} onChange={(e) => onChange(Number(e.target.value))} onPointerUp={(e) => (e.target as HTMLElement).blur()} />
      <output className="adjust-val">{show}</output>
    </label>
  );
}

/** Is Shift or Alt held: they turn + and − around for as long as they are. */
function useInverting(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const on = (e: KeyboardEvent) => setHeld(e.shiftKey || e.altKey);
    const off = () => setHeld(false);
    window.addEventListener("keydown", on);
    window.addEventListener("keyup", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", on);
      window.removeEventListener("keyup", on);
      window.removeEventListener("blur", off);
    };
  }, []);
  return held;
}

/** The movable window of the 3D mask tools. */
export function Segment3DPanel({ type, state, message, busy, tool, onTool, readOnly, z, slices, onOp, onUndo, onRedo, onClose, extra, dock }: Props) {
  const inverting = useInverting();
  const effectiveErase = tool.erase !== inverting;
  const [steps, setSteps] = useState(1);
  const [copyN, setCopyN] = useState(3);
  const [confirmClear, setConfirmClear] = useState(false);
  const count = state?.slices.length ?? 0;
  const [storedMode, setMode] = useState<PanelView>(storedView);
  const view: PanelView = storedMode === "docked" && !dock ? "compact" : storedMode;
  const show = (v: PanelView) => {
    setMode(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* private mode */
    }
  };
  // the size stays about the same when the unit changes (measured with the pixels of the axial plane)
  const switchUnit = (unit: SizeUnit) => {
    if (unit === tool.unit) return;
    const pxMm = state?.voxel_mm?.[0] ?? 1;
    const r = sizeRange(unit);
    const v = unit === "mm" ? tool.size * pxMm : tool.size / pxMm;
    onTool({ unit, size: Math.min(Math.max(Math.round(v / r.step) * r.step, r.min), r.max) });
  };
  const copy = (dir: 1 | -1) => {
    const t = copyTargets(z, slices, copyN, dir);
    if (t) onOp({ op: "copy", from: z, to: t.to, through: t.through, add: false });
  };
  const quick = (
    <QuickTools tool={tool} onTool={onTool} readOnly={readOnly} busy={busy} state={state} effectiveErase={effectiveErase} inverting={inverting} onUndo={onUndo} onRedo={onRedo} />
  );
  if (view === "docked" && dock)
    return createPortal(
      <div className="seg3d-dock" data-testid="seg3d-dock" role="group" aria-label="3D segmentation">
        <span className="swatch" style={{ background: type.color }} title={type.name} />
        {quick}
        <button className="btn ghost" onClick={() => show("compact")} title="Float the tools over the planes again" aria-label="Undock" data-testid="seg3d-undock">
          ⧉
        </button>
        <button className="btn ghost" onClick={() => show("full")} title="All options" aria-label="Show all options" data-testid="seg3d-expand">
          ⤢
        </button>
        <button className="btn ghost" onClick={onClose} aria-label="Close" title="Close the tools">
          ✕
        </button>
      </div>,
      dock,
    );
  if (view === "compact")
    return (
      <FloatingPanel
        title="3D segmentation"
        bare
        onClose={onClose}
        storageKey="exact.seg3d.pos"
        initial={{ right: 16, top: 64 }}
        className="seg3d-panel compact"
        actions={
          <>
            {dock && (
              <button className="btn ghost" onClick={() => show("docked")} title="Dock the tools in the top bar" aria-label="Dock in the top bar" data-testid="seg3d-dock-btn">
                ⇱
              </button>
            )}
            <button className="btn ghost" onClick={() => show("full")} title="All options" aria-label="Show all options" data-testid="seg3d-expand">
              ⤢
            </button>
          </>
        }
      >
        <div className="seg3d-head">
          <span className="swatch" style={{ background: type.color }} />
          <strong>{type.name}</strong>
          {busy && <span className="spinner seg3d-busy" role="status" aria-label="Working" />}
        </div>
        {quick}
        {message && message.kind === "error" && (
          <p className="error small" role="alert" data-testid="seg3d-message">
            {message.text}
          </p>
        )}
      </FloatingPanel>
    );
  return (
    <FloatingPanel
      title="3D segmentation"
      onClose={onClose}
      storageKey="exact.seg3d.pos"
      initial={{ right: 16, top: 64 }}
      className="seg3d-panel"
      actions={
        <>
          {dock && (
            <button className="btn ghost" onClick={() => show("docked")} title="Dock the tools in the top bar" aria-label="Dock in the top bar" data-testid="seg3d-dock-btn">
              ⇱
            </button>
          )}
          <button className="btn ghost" onClick={() => show("compact")} title="Collapse to the small palette" aria-label="Collapse" data-testid="seg3d-collapse">
            ⤡
          </button>
        </>
      }
    >
      <div className="seg3d-head">
        <span className="swatch" style={{ background: type.color }} />
        <strong>{type.name}</strong>
      </div>
      <p className="seg3d-readout" data-testid="seg3d-readout">
        {state ? (
          <>
            <span data-testid="seg3d-volume">{formatVolume(state.volume_mm3)}</span> · {count} slice{count === 1 ? "" : "s"} painted
          </>
        ) : (
          "Loading the mask…"
        )}
        {busy && <span className="spinner seg3d-busy" role="status" aria-label="Working" />}
      </p>
      {!readOnly && (
        <>
          <div className="seg3d-tools">
            <div className="seg icons" role="group" aria-label="Tool">
              {(["brush", "lasso", "wand"] as SegToolName[]).map((t) => (
                <button key={t} className={tool.tool === t ? "active" : ""} aria-pressed={tool.tool === t} aria-label={NAMES[t]} onClick={() => onTool({ tool: t })} title={`${NAMES[t]} (${KEYS[t]})`} data-testid={`seg3d-${t}`}>
                  <ToolIcon tool={t} />
                </button>
              ))}
            </div>
            <button
              className={`pt-round seg3d-mode ${effectiveErase ? "erase" : "add"} ${inverting ? "held" : ""}`}
              onClick={() => onTool({ erase: !tool.erase })}
              aria-pressed={tool.erase}
              aria-label={tool.erase ? "Subtracting (tap to add)" : "Adding (tap to subtract)"}
              title={tool.erase ? "Subtracting from the mask: click to add (E, or hold Shift)" : "Adding to the mask: click to subtract (E, or hold Shift)"}
              data-testid="seg3d-mode"
            >
              {effectiveErase ? "−" : "+"}
            </button>
          </div>
          {tool.tool === "lasso" ? (
            <p className="muted small">Draw around the area in a plane: when you lift the pointer the outline is closed and filled in that slice. Shift turns + and − around while held.</p>
          ) : tool.tool === "brush" ? (
            <>
              <div className="seg" role="group" aria-label="Brush shape">
                <button className={!tool.ball ? "active" : ""} aria-pressed={!tool.ball} onClick={() => onTool({ ball: false })} title="Paint a disc in the plane you draw in" data-testid="seg3d-disc">
                  2D disc
                </button>
                <button className={tool.ball ? "active" : ""} aria-pressed={tool.ball} onClick={() => onTool({ ball: true })} title="Paint a sphere that reaches through the slices" data-testid="seg3d-ball">
                  3D sphere
                </button>
              </div>
              <Slider label="Size" value={tool.size} min={sizeRange(tool.unit).min} max={sizeRange(tool.unit).max} step={sizeRange(tool.unit).step} show={`${tool.size} ${tool.unit === "px" ? "px" : "mm"}`} onChange={(v) => onTool({ size: v })} testid="seg3d-size" />
              <div className="seg" role="group" aria-label="Unit of the brush size">
                {(["px", "mm"] as const).map((u) => (
                  <button key={u} className={tool.unit === u ? "active" : ""} aria-pressed={tool.unit === u} onClick={() => switchUnit(u)} title={u === "px" ? "Size in pixels of the plane you draw in" : "Size in millimetres"} data-testid={`seg3d-unit-${u}`}>
                    {u === "px" ? "pixels" : "mm"}
                  </button>
                ))}
              </div>
              <p className="muted small">Shift turns + and − around while held; Alt + wheel or [ ] changes the size.</p>
            </>
          ) : (
            <>
              <div className="seg" role="group" aria-label="Wand reach">
                <button className={!tool.wand3d ? "active" : ""} aria-pressed={!tool.wand3d} onClick={() => onTool({ wand3d: false })} data-testid="seg3d-wand2d">
                  In the plane
                </button>
                <button className={tool.wand3d ? "active" : ""} aria-pressed={tool.wand3d} onClick={() => onTool({ wand3d: true })} data-testid="seg3d-wand3d">
                  In the volume
                </button>
              </div>
              <Slider label="Tolerance" value={tool.tolerance} min={0} max={100} step={1} show={`${tool.tolerance} %`} onChange={(v) => onTool({ tolerance: v })} testid="seg3d-tolerance" />
              <Slider label="Reach" value={tool.maxRadiusMm} min={0} max={100} step={1} show={tool.maxRadiusMm ? `${tool.maxRadiusMm} mm` : "no limit"} onChange={(v) => onTool({ maxRadiusMm: v })} testid="seg3d-reach" />
              <p className="muted small">Click to add (+) or remove (−) the connected region of similar grey values; Shift turns it around while held.</p>
            </>
          )}
        </>
      )}
      <Slider label="Opacity" value={tool.opacity} min={0.1} max={1} step={0.05} show={`${Math.round(tool.opacity * 100)} %`} onChange={(v) => onTool({ opacity: v })} testid="seg3d-opacity" />
      {!readOnly && (
        <>
          <div className="seg3d-group" role="group" aria-label="Slices">
            <button className="btn" disabled={busy} onClick={() => onOp({ op: "interpolate" })} title="Fill the empty axial slices between painted slices by blending their shapes" data-testid="seg3d-interpolate">
              Interpolate slices
            </button>
            <div className="seg3d-copy">
              <span className="muted small">Copy this axial slice to the</span>
              <button className="btn" disabled={busy || !copyTargets(z, slices, copyN, -1)} onClick={() => copy(-1)} data-testid="seg3d-copy-prev">
                previous
              </button>
              <button className="btn" disabled={busy || !copyTargets(z, slices, copyN, 1)} onClick={() => copy(1)} data-testid="seg3d-copy-next">
                next
              </button>
              <input type="number" min={1} max={50} value={copyN} aria-label="Number of slices to copy to" onChange={(e) => setCopyN(Math.min(50, Math.max(1, Number(e.target.value) || 1)))} />
              <span className="muted small">slices</span>
            </div>
          </div>
          <div className="seg3d-group" role="group" aria-label="Shape">
            <div className="seg3d-copy">
              <button className="btn" disabled={busy} onClick={() => onOp({ op: "grow", steps })} data-testid="seg3d-grow">
                Grow
              </button>
              <button className="btn" disabled={busy} onClick={() => onOp({ op: "shrink", steps })} data-testid="seg3d-shrink">
                Shrink
              </button>
              <input type="number" min={1} max={20} value={steps} aria-label="Voxels to grow or shrink by" onChange={(e) => setSteps(Math.min(20, Math.max(1, Number(e.target.value) || 1)))} />
              <span className="muted small">voxels</span>
            </div>
            <button className="btn" disabled={busy} onClick={() => onOp({ op: "fill_holes" })} title="Fill cavities that are closed on all sides" data-testid="seg3d-fill">
              Fill holes
            </button>
            <button className="btn" disabled={busy} onClick={() => onOp({ op: "keep_largest" })} title="Remove all but the largest connected part" data-testid="seg3d-largest">
              Largest part only
            </button>
          </div>
          <div className="seg3d-group seg3d-undo">
            <button className="btn" disabled={busy || !state?.can_undo} onClick={onUndo} title="Undo (Ctrl+Z)" data-testid="seg3d-undo">
              Undo
            </button>
            <button className="btn" disabled={busy || !state?.can_redo} onClick={onRedo} title="Redo (Shift+Ctrl+Z)" data-testid="seg3d-redo">
              Redo
            </button>
            <span className="spacer" />
            <button
              className={`btn ${confirmClear ? "danger" : ""}`}
              disabled={busy || !state?.count}
              onClick={() => {
                if (!confirmClear) {
                  setConfirmClear(true);
                  window.setTimeout(() => setConfirmClear(false), 4000);
                  return;
                }
                setConfirmClear(false);
                onOp({ op: "clear" });
              }}
              data-testid="seg3d-clear"
            >
              {confirmClear ? "Click again to clear" : "Clear mask"}
            </button>
          </div>
        </>
      )}
      {readOnly && <p className="muted small">Read only: you can look at the mask, not change it.</p>}
      {message && (
        <p className={message.kind === "error" ? "error small" : "muted small"} role={message.kind === "error" ? "alert" : "status"} data-testid="seg3d-message">
          {message.text}
        </p>
      )}
      <div className="seg3d-extra" data-testid="seg3d-extra">
        {extra}
      </div>
    </FloatingPanel>
  );
}

/** The few controls that are needed all the time: tool, + / −, undo / redo and the size of the tool. */
function QuickTools({ tool, onTool, readOnly, busy, state, effectiveErase, inverting, onUndo, onRedo }: { tool: SegTool; onTool(p: Partial<SegTool>): void; readOnly: boolean; busy: boolean; state: MaskState | null; effectiveErase: boolean; inverting: boolean; onUndo(): void; onRedo(): void }) {
  if (readOnly) return <Slider label="Opacity" value={tool.opacity} min={0.1} max={1} step={0.05} show={`${Math.round(tool.opacity * 100)} %`} onChange={(v) => onTool({ opacity: v })} />;
  const brush = tool.tool === "brush";
  const r = sizeRange(tool.unit);
  return (
    <div className="seg3d-quick">
      <div className="seg3d-tools">
        <div className="seg icons" role="group" aria-label="Tool">
          {(["brush", "lasso", "wand"] as SegToolName[]).map((t) => (
            <button key={t} className={tool.tool === t ? "active" : ""} aria-pressed={tool.tool === t} aria-label={NAMES[t]} onClick={() => onTool({ tool: t })} title={`${NAMES[t]} (${KEYS[t]})`} data-testid={`seg3d-${t}`}>
              <ToolIcon tool={t} />
            </button>
          ))}
        </div>
        <button
          className={`pt-round seg3d-mode ${effectiveErase ? "erase" : "add"} ${inverting ? "held" : ""}`}
          onClick={() => onTool({ erase: !tool.erase })}
          aria-pressed={tool.erase}
          aria-label={tool.erase ? "Subtracting (tap to add)" : "Adding (tap to subtract)"}
          title={tool.erase ? "Subtracting from the mask: click to add (E, or hold Shift)" : "Adding to the mask: click to subtract (E, or hold Shift)"}
          data-testid="seg3d-mode"
        >
          {effectiveErase ? "−" : "+"}
        </button>
        <button className="btn" disabled={busy || !state?.can_undo} onClick={onUndo} title="Undo (Ctrl+Z)" aria-label="Undo" data-testid="seg3d-undo">
          ↶
        </button>
        <button className="btn" disabled={busy || !state?.can_redo} onClick={onRedo} title="Redo (Shift+Ctrl+Z)" aria-label="Redo" data-testid="seg3d-redo">
          ↷
        </button>
      </div>
      {brush ? (
        <Slider label="Size" value={tool.size} min={r.min} max={r.max} step={r.step} show={`${tool.size} ${tool.unit === "px" ? "px" : "mm"}`} onChange={(v) => onTool({ size: v })} testid="seg3d-size" />
      ) : tool.tool === "wand" ? (
        <Slider label="Tolerance" value={tool.tolerance} min={0} max={100} step={1} show={`${tool.tolerance} %`} onChange={(v) => onTool({ tolerance: v })} testid="seg3d-tolerance" />
      ) : null}
    </div>
  );
}
