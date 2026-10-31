import { useState, type ReactNode } from "react";
import { FloatingPanel } from "./FloatingPanel";
import { copyTargets, formatVolume } from "../viewer-core/mpr3d";
import type { MaskState, Message, Op } from "../hooks/useSegment3D";

export type SegToolName = "brush" | "eraser" | "wand";

/** What the tools are set to; the plane panes read it when a stroke or a click happens. */
export interface SegTool {
  tool: SegToolName;
  /** brush: a sphere through the slices (true) or a disc in the plane (false) */
  ball: boolean;
  /** brush diameter in mm */
  sizeMm: number;
  /** wand: grow through the volume (true) or in the plane */
  wand3d: boolean;
  /** wand tolerance in percent of the grey range */
  tolerance: number;
  /** wand: stay within this radius (mm) of the click; 0 = no limit */
  maxRadiusMm: number;
  opacity: number;
}

export const DEFAULT_TOOL: SegTool = { tool: "brush", ball: false, sizeMm: 8, wand3d: true, tolerance: 12, maxRadiusMm: 0, opacity: 0.55 };

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
}

const KEYS: Record<SegToolName, string> = { brush: "B", eraser: "E", wand: "W" };

function Slider({ label, value, min, max, step, show, onChange, testid }: { label: string; value: number; min: number; max: number; step: number; show: string; onChange(v: number): void; testid?: string }) {
  return (
    <label className="adjust-row">
      <span className="adjust-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} data-testid={testid} onChange={(e) => onChange(Number(e.target.value))} onPointerUp={(e) => (e.target as HTMLElement).blur()} />
      <output className="adjust-val">{show}</output>
    </label>
  );
}

/** The movable window of the 3D mask tools. */
export function Segment3DPanel({ type, state, message, busy, tool, onTool, readOnly, z, slices, onOp, onUndo, onRedo, onClose, extra }: Props) {
  const [steps, setSteps] = useState(1);
  const [copyN, setCopyN] = useState(3);
  const [confirmClear, setConfirmClear] = useState(false);
  const count = state?.slices.length ?? 0;
  const copy = (dir: 1 | -1) => {
    const t = copyTargets(z, slices, copyN, dir);
    if (t) onOp({ op: "copy", from: z, to: t.to, through: t.through, add: false });
  };
  return (
    <FloatingPanel title="3D segmentation" onClose={onClose} storageKey="exact.seg3d.pos" initial={{ right: 16, top: 64 }} className="seg3d-panel">
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
          <div className="seg" role="group" aria-label="Tool">
            {(["brush", "eraser", "wand"] as SegToolName[]).map((t) => (
              <button key={t} className={tool.tool === t ? "active" : ""} aria-pressed={tool.tool === t} onClick={() => onTool({ tool: t })} title={`${t[0].toUpperCase()}${t.slice(1)} (${KEYS[t]})`} data-testid={`seg3d-${t}`}>
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
          {tool.tool !== "wand" ? (
            <>
              <div className="seg" role="group" aria-label="Brush shape">
                <button className={!tool.ball ? "active" : ""} aria-pressed={!tool.ball} onClick={() => onTool({ ball: false })} title="Paint a disc in the plane you draw in" data-testid="seg3d-disc">
                  2D disc
                </button>
                <button className={tool.ball ? "active" : ""} aria-pressed={tool.ball} onClick={() => onTool({ ball: true })} title="Paint a sphere that reaches through the slices" data-testid="seg3d-ball">
                  3D sphere
                </button>
              </div>
              <Slider label="Size" value={tool.sizeMm} min={0.5} max={60} step={0.5} show={`${tool.sizeMm} mm`} onChange={(v) => onTool({ sizeMm: v })} testid="seg3d-size" />
              <p className="muted small">Alt turns the brush into the eraser, Alt + wheel or [ ] changes the size.</p>
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
              <p className="muted small">Click to add the connected region of similar grey values, Alt + click to remove it.</p>
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
