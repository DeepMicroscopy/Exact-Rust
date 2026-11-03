import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_RENDER, PRESETS, rgbOf, VolumeRenderer, type RenderParams } from "../viewer-core/volumeRender";

interface Props {
  imageId: number;
  /** the mask to show with the volume (none: only the volume) */
  mask: { annotationId: number; color: string; version: number } | null;
  /** the linked segmentation file to show with the volume (none: no file), the segments switched off and the colour of every segment */
  linked?: { id: number; name: string; hide: number[]; colors: string[] } | null;
  onHide(): void;
}

interface Grid {
  data: Uint8Array;
  dims: [number, number, number];
  extent: [number, number, number];
}

const triple = (s: string | null): [number, number, number] | null => {
  const v = (s ?? "").split(",").map(Number);
  return v.length === 3 && v.every((x) => Number.isFinite(x) && x > 0) ? [v[0], v[1], v[2]] : null;
};

async function fetchGrid(url: string, signal: AbortSignal): Promise<Grid> {
  const r = await fetch(url, { credentials: "same-origin", signal });
  if (!r.ok) {
    const j = (await r.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(j?.detail ?? `HTTP ${r.status}`);
  }
  const dims = triple(r.headers.get("x-dims"));
  const extent = triple(r.headers.get("x-extent-mm"));
  if (!dims || !extent) throw new Error("The server's answer has no size.");
  const data = new Uint8Array(await r.arrayBuffer());
  if (data.length !== dims[0] * dims[1] * dims[2]) throw new Error("The server's answer is incomplete.");
  return { data, dims, extent };
}

/** The labels of a linked file: two bytes per cell (coverage, segment + 1) on the grid of the volume. */
async function fetchLabels(url: string, signal: AbortSignal): Promise<Uint8Array> {
  const r = await fetch(url, { credentials: "same-origin", signal });
  if (!r.ok) {
    const j = (await r.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(j?.detail ?? `HTTP ${r.status}`);
  }
  const dims = triple(r.headers.get("x-dims"));
  if (!dims || r.headers.get("x-channels") !== "2") throw new Error("The server's answer has no size.");
  const data = new Uint8Array(await r.arrayBuffer());
  if (data.length !== 2 * dims[0] * dims[1] * dims[2]) throw new Error("The server's answer is incomplete.");
  return data;
}

const SIZES = [
  { n: 128, label: "Fast (128)" },
  { n: 192, label: "Medium (192)" },
  { n: 256, label: "Fine (256)" },
  { n: 384, label: "Very fine (384)" },
];

/**
 * The 3D render in the fourth panel. It only loads and draws when it is switched on: the server averages the volume onto a coarse
 * grid first (the longest side gets the chosen number of cells), which takes a few seconds on a large volume.
 */
export function Render3D({ imageId, mask, linked = null, onHide }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const renderer = useRef<VolumeRenderer | null>(null);
  const [size, setSize] = useState(192);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [params, setParams] = useState<RenderParams>({ ...DEFAULT_RENDER });
  const [preset, setPreset] = useState("Bone");
  const [maskThere, setMaskThere] = useState(false);
  const [labelsThere, setLabelsThere] = useState(false);
  const [labelsError, setLabelsError] = useState<string | null>(null);
  const patch = useCallback((p: Partial<RenderParams>) => {
    setParams((q) => ({ ...q, ...p }));
    renderer.current?.setParams(p);
  }, []);

  // the renderer and the volume: again when the image or the grid size changes
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ac = new AbortController();
    setStatus("loading");
    let r: VolumeRenderer;
    try {
      r = new VolumeRenderer(el);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
      return;
    }
    renderer.current = r;
    r.setParams(params);
    fetchGrid(`/api/v2/images/${imageId}/render-volume?max=${size}`, ac.signal)
      .then((g) => {
        r.setVolume(g.data, g.dims, g.extent);
        setStatus("ready");
      })
      .catch((e: Error) => {
        if (ac.signal.aborted) return;
        setError(e.message);
        setStatus("error");
      });
    return () => {
      ac.abort();
      r.dispose();
      renderer.current = null;
    };
    // the parameters are handed over once; later changes go through patch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageId, size]);

  // the mask: loaded after the volume, and again a moment after each change of it
  const annotationId = mask?.annotationId;
  const version = mask?.version;
  useEffect(() => {
    if (status !== "ready") return;
    const r = renderer.current;
    if (!r) return;
    if (annotationId == null) {
      r.setMask(null);
      setMaskThere(false);
      return;
    }
    const ac = new AbortController();
    const t = window.setTimeout(() => {
      fetchGrid(`/api/v2/segmentation/${annotationId}/render-mask?max=${size}&v=${version}`, ac.signal)
        .then((g) => {
          r.setMask(g.data);
          setMaskThere(true);
        })
        .catch(() => undefined);
    }, 500);
    return () => {
      window.clearTimeout(t);
      ac.abort();
    };
  }, [status, annotationId, version, size]);

  // the linked segmentation: its labels on the grid of the volume, again when a segment is switched on or off
  const linkedId = linked?.id;
  const hideKey = linked?.hide.join(",") ?? "";
  const colorKey = linked?.colors.join(",") ?? "";
  useEffect(() => {
    if (status !== "ready") return;
    const r = renderer.current;
    if (!r) return;
    if (linkedId == null) {
      r.setLabels(null);
      setLabelsThere(false);
      setLabelsError(null);
      return;
    }
    const ac = new AbortController();
    const t = window.setTimeout(() => {
      fetchLabels(`/api/v2/linked-volumes/${linkedId}/render-mask?max=${size}&hide=${hideKey}`, ac.signal)
        .then((data) => {
          r.setLabels(
            data,
            colorKey.split(",").map((c) => {
              const v = parseInt(c.replace("#", ""), 16) || 0;
              return [(v >> 16) & 255, (v >> 8) & 255, v & 255] as [number, number, number];
            }),
          );
          setLabelsThere(true);
          setLabelsError(null);
        })
        .catch((e: Error) => {
          if (!ac.signal.aborted) setLabelsError(e.message);
        });
    }, 300);
    return () => {
      window.clearTimeout(t);
      ac.abort();
    };
  }, [status, linkedId, hideKey, colorKey, size]);

  useEffect(() => {
    if (mask) patch({ maskColor: rgbOf(mask.color) });
  }, [mask?.color, patch]); // eslint-disable-line react-hooks/exhaustive-deps

  // turning, zooming
  const drag = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      renderer.current?.zoom(Math.pow(1.0015, e.deltaY));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  return (
    <div className="render3d" data-testid="render3d">
      <div className="render3d-bar">
        <strong>3D render</strong>
        <select value={preset} onChange={(e) => { setPreset(e.target.value); patch(PRESETS[e.target.value]); }} aria-label="Look" data-testid="render3d-preset">
          {Object.keys(PRESETS).map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
        <select value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="Resolution" title="Cells along the longest side: finer is slower to load and to turn" data-testid="render3d-size">
          {SIZES.map((s) => (
            <option key={s.n} value={s.n}>
              {s.label}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button className="btn ghost" onClick={() => renderer.current?.resetView()} title="Back to the front view">
          Reset view
        </button>
        <button className="btn ghost" onClick={onHide} aria-label="Hide the 3D render" title="Hide the 3D render">
          ✕
        </button>
      </div>
      <div className="render3d-stage">
        <canvas
          ref={canvas}
          data-testid="render3d-canvas"
          onPointerDown={(e) => {
            drag.current = { x: e.clientX, y: e.clientY };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            renderer.current?.rotate(e.clientX - d.x, e.clientY - d.y);
            drag.current = { x: e.clientX, y: e.clientY };
          }}
          onPointerUp={() => (drag.current = null)}
          onPointerCancel={() => (drag.current = null)}
        />
        {status === "loading" && <div className="render3d-note">Preparing the volume… this takes a few seconds for a large image.</div>}
        {status === "error" && (
          <div className="render3d-note error" role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="render3d-controls">
        <label className="adjust-row">
          <span className="adjust-label">Threshold</span>
          <input type="range" min={0} max={0.95} step={0.01} value={params.low} onChange={(e) => { setPreset(""); patch({ low: Number(e.target.value), high: Math.max(params.high, Number(e.target.value) + 0.05) }); }} data-testid="render3d-low" />
          <output className="adjust-val">{Math.round(params.low * 100)}%</output>
        </label>
        <label className="adjust-row">
          <span className="adjust-label">Opacity</span>
          <input type="range" min={0.05} max={1} step={0.01} value={params.density} onChange={(e) => { setPreset(""); patch({ density: Number(e.target.value) }); }} />
          <output className="adjust-val">{Math.round(params.density * 100)}%</output>
        </label>
        <div className="render3d-checks">
          <label>
            <input type="checkbox" checked={params.showImage} onChange={(e) => patch({ showImage: e.target.checked })} /> Image
          </label>
          {linked && (
            <label title={labelsError ?? `The linked segmentation ${linked.name}, in the colours of its segments`}>
              <input type="checkbox" checked={params.showLabels && labelsThere} disabled={!labelsThere} onChange={(e) => patch({ showLabels: e.target.checked })} data-testid="render3d-seg" /> Segmentation
            </label>
          )}
          {(mask || !linked) && (
            <label title={mask ? "" : "Choose a segmentation type to see its mask here"}>
              <input type="checkbox" checked={params.showMask && !!mask && maskThere} disabled={!mask || !maskThere} onChange={(e) => patch({ showMask: e.target.checked })} data-testid="render3d-mask" /> Mask
            </label>
          )}
          <span className="muted small">Drag turns, scroll zooms.</span>
          {labelsError && (
            <span className="error small" role="alert">
              {labelsError}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
