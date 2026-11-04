import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type OpenSeadragon from "openseadragon";
import { api } from "../api/client";
import { coverage, createMode, DEFAULT_OVERLAP, keyMove, moved, overlapOf, tileAt, type Move, type ScreeningMode } from "../viewer-core/screening";
import { isTypingTarget } from "../viewer-core/shortcuts";
import { FloatingPanel } from "./FloatingPanel";

const MAX_WINDOWS = 40_000; // a mode is stored as one JSON document: this keeps it to a few MB
const MAP_W = 240;
const MIN_WINDOW = 16;

interface Props {
  viewerRef: MutableRefObject<OpenSeadragon.Viewer | null>;
  imageId: number;
  width: number;
  height: number;
  onClose(): void;
}

function remembered(): { overlap: number } {
  try {
    const o = JSON.parse(localStorage.getItem("exact.screening") ?? "{}") as { overlap?: number };
    return { overlap: typeof o.overlap === "number" && o.overlap >= 0 && o.overlap < 0.96 ? o.overlap : DEFAULT_OVERLAP };
  } catch {
    return { overlap: DEFAULT_OVERLAP };
  }
}

/** Screening mode: step through the slide window by window with overlap, with a small map of what has been seen. */
export function ScreeningPanel({ viewerRef, imageId, width, height, onClose }: Props) {
  const [mode, setMode] = useState<ScreeningMode | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState(false);
  const [viewW, setViewW] = useState(1000);
  const [viewH, setViewH] = useState(800);
  const [overlap, setOverlap] = useState(() => Math.round(remembered().overlap * 100));
  const [plain, setPlain] = useState(false); // step without counting the window as screened (the I J K L keys of the old EXACT)
  const [version, setVersion] = useState(0);
  const modeRef = useRef<ScreeningMode | null>(null);
  modeRef.current = mode;
  const dirty = useRef<number | null>(null);
  const map = useRef<HTMLCanvasElement>(null);
  const thumb = useRef<HTMLImageElement | null>(null);
  const [thumbReady, setThumbReady] = useState(0);

  // the stored mode of this user and image
  const url = `/api/v2/images/${imageId}/screening`;
  useEffect(() => {
    let gone = false;
    api<ScreeningMode | null>(url)
      .then((r) => {
        if (gone) return;
        setMode(r);
        setSetup(!r);
        setLoaded(true);
      })
      .catch(() => {
        if (!gone) {
          setError("The screening mode could not be loaded.");
          setLoaded(true);
        }
      });
    return () => {
      gone = true;
    };
  }, [url]);

  // the size of the window to start with: what is on the screen now
  useEffect(() => {
    const v = viewerRef.current;
    const item = v?.world.getItemCount() ? v.world.getItemAt(0) : null;
    if (!v || !item) return;
    const r = item.viewportToImageRectangle(v.viewport.getBounds(true));
    const round = (n: number) => Math.max(MIN_WINDOW, Math.min(Math.round(n / 50) * 50 || Math.round(n), 100_000));
    // zoomed in: the window is what is on the screen; the whole slide in view says nothing about the size wanted, so a usual screen of 2000 x 1200 px
    const zoomed = r.width < width * 0.6;
    setViewW(Math.min(zoomed ? round(r.width) : 2000, width));
    setViewH(Math.min(zoomed ? round(r.height) : 1200, height));
  }, [viewerRef, width, height]);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      thumb.current = img;
      setThumbReady((n) => n + 1);
    };
    img.src = `/api/v2/images/${imageId}/thumbnail`;
  }, [imageId]);

  const flush = useCallback(async () => {
    const m = modeRef.current;
    if (dirty.current != null) {
      window.clearTimeout(dirty.current);
      dirty.current = null;
    }
    if (!m?.id) return;
    try {
      await api(url, { method: "PUT", json: { screening_tiles: m.screening_tiles, current_index: m.current_index } });
    } catch {
      setError("The progress could not be saved.");
    }
  }, [url]);
  useEffect(() => () => void flush(), [flush]);
  const later = useCallback(() => {
    if (dirty.current != null) window.clearTimeout(dirty.current);
    dirty.current = window.setTimeout(() => void flush(), 3000);
  }, [flush]);

  const show = useCallback(
    (i: number) => {
      const v = viewerRef.current;
      const m = modeRef.current;
      const t = m?.screening_tiles[String(i)];
      const item = v?.world.getItemCount() ? v.world.getItemAt(0) : null;
      if (!v || !t || !item) return;
      v.viewport.fitBounds(item.imageToViewportRectangle(t.x_min, t.y_min, t.x_max - t.x_min, t.y_max - t.y_min));
    },
    [viewerRef],
  );

  /** Step in a direction; the window left counts as screened unless `mark` is false. */
  const step = useCallback(
    (dir: Move, mark: boolean) => {
      const m = modeRef.current;
      if (!m) return;
      const cur = m.screening_tiles[String(m.current_index)];
      if (mark && cur) cur.Screened = true;
      m.current_index = moved(m, m.current_index, dir);
      setVersion((n) => n + 1);
      show(m.current_index);
      if (m.id) {
        void api(url, { method: "PUT", json: { current_index: m.current_index } }).catch(() => undefined);
        if (mark) later();
      }
    },
    [show, later, url],
  );

  // the keys of the old EXACT: W A S D (counting) and I J K L (not counting)
  useEffect(() => {
    if (!mode) return;
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const k = keyMove(e);
      if (!k) return;
      e.preventDefault();
      e.stopPropagation(); // these letters are tools of the viewer otherwise
      if (!e.repeat) step(k.dir, k.mark);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [mode, step]);

  const windows = useMemo(() => {
    const cols = viewW >= width ? 1 : Math.ceil((width - viewW) / Math.max(1, Math.round(viewW * (1 - overlap / 100)))) + 1;
    const rows = viewH >= height ? 1 : Math.ceil((height - viewH) / Math.max(1, Math.round(viewH * (1 - overlap / 100)))) + 1;
    return cols * rows;
  }, [viewW, viewH, overlap, width, height]);

  const start = async () => {
    setError(null);
    const made = createMode(width, height, Math.min(viewW, width), Math.min(viewH, height), overlap / 100);
    try {
      localStorage.setItem("exact.screening", JSON.stringify({ overlap: overlap / 100 }));
    } catch {
      /* not remembered */
    }
    try {
      const saved = await api<ScreeningMode>(url, { method: "PUT", json: made });
      setMode({ ...made, id: saved.id });
      setSetup(false);
      setVersion((n) => n + 1);
      window.setTimeout(() => show(0), 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The screening mode could not be saved.");
    }
  };

  // the map: the slide, what has been screened, the window on the screen now
  const shown = mode ? coverage(mode, width, height, Math.max(32, Math.round(Math.max(width, height) / 400))) : 0;
  useEffect(() => {
    const c = map.current;
    if (!c || !mode) return;
    const scale = MAP_W / width;
    c.width = MAP_W;
    c.height = Math.max(1, Math.round(height * scale));
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#1b1b24";
    ctx.fillRect(0, 0, c.width, c.height);
    if (thumb.current) ctx.drawImage(thumb.current, 0, 0, c.width, c.height);
    const seen = document.createElement("canvas");
    seen.width = c.width;
    seen.height = c.height;
    const sc = seen.getContext("2d");
    if (sc) {
      sc.fillStyle = "#2ecc71";
      for (const t of Object.values(mode.screening_tiles)) if (t.Screened) sc.fillRect(t.x_min * scale, t.y_min * scale, (t.x_max - t.x_min) * scale, (t.y_max - t.y_min) * scale);
      ctx.globalAlpha = 0.5;
      ctx.drawImage(seen, 0, 0);
      ctx.globalAlpha = 1;
    }
    const cur = mode.screening_tiles[String(mode.current_index)];
    if (cur) {
      ctx.strokeStyle = "#ff2fd0";
      ctx.lineWidth = 2;
      ctx.strokeRect(cur.x_min * scale, cur.y_min * scale, (cur.x_max - cur.x_min) * scale, (cur.y_max - cur.y_min) * scale);
    }
  }, [mode, version, width, height, thumbReady]);

  const screened = mode ? Object.values(mode.screening_tiles).filter((t) => t.Screened).length : 0;
  const total = mode ? Object.keys(mode.screening_tiles).length : 0;
  const close = () => {
    void flush();
    onClose();
  };
  const pickOnMap = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!mode) return;
    const r = e.currentTarget.getBoundingClientRect();
    const i = tileAt(mode, ((e.clientX - r.left) / r.width) * width, ((e.clientY - r.top) / r.height) * height);
    if (i == null) return;
    mode.current_index = i;
    setVersion((n) => n + 1);
    show(i);
    if (mode.id) void api(url, { method: "PUT", json: { current_index: i } }).catch(() => undefined);
  };
  const tooMany = windows > MAX_WINDOWS;

  return (
    <FloatingPanel title="Screening" onClose={close} storageKey="exact.screening.pos" initial={{ right: 16, top: 70 }}>
      <div className="screening" data-testid="screening-panel">
        {!loaded && <p className="muted">Loading…</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {loaded && mode && !setup && (
          <>
            <canvas ref={map} className="screening-map" onPointerDown={pickOnMap} data-testid="screening-map" aria-label="Map of the screening: click a window to go there" />
            <p className="screening-progress" data-testid="screening-progress">
              <b>{Math.round(shown * 100)} %</b> of the slide screened · {screened} of {total} windows
            </p>
            <div className="screening-pad" role="group" aria-label="Step to the next window">
              <button className="btn" style={{ gridArea: "u" }} onClick={() => step("up", !plain)} aria-label="Up" title={plain ? "Up (I)" : "Up (W)"} data-testid="screening-up">▲</button>
              <button className="btn" style={{ gridArea: "l" }} onClick={() => step("left", !plain)} aria-label="Left" title={plain ? "Left (J)" : "Left (A)"} data-testid="screening-left">◀</button>
              <button className="btn" style={{ gridArea: "r" }} onClick={() => step("right", !plain)} aria-label="Right" title={plain ? "Right (L)" : "Right (D)"} data-testid="screening-right">▶</button>
              <button className="btn" style={{ gridArea: "d" }} onClick={() => step("down", !plain)} aria-label="Down" title={plain ? "Down (K)" : "Down (S)"} data-testid="screening-down">▼</button>
            </div>
            <label className="check small">
              <input type="checkbox" checked={plain} onChange={(e) => setPlain(e.target.checked)} /> Step without counting the window as screened (I J K L)
            </label>
            <p className="muted small">
              W A S D step and count the window you leave as screened; I J K L step without counting. Click the map to jump. Window {mode.x_resolution} × {mode.y_resolution} px, overlap {Math.round(overlapOf(mode) * 100)} %.
            </p>
            <div className="row">
              <button className="btn" onClick={() => show(mode.current_index)} data-testid="screening-goto">Back to the window</button>
              <button className="btn ghost" onClick={() => { setViewW(mode.x_resolution); setViewH(mode.y_resolution); setOverlap(Math.round(overlapOf(mode) * 100) || overlap); setSetup(true); }}>Settings…</button>
            </div>
          </>
        )}
        {loaded && setup && (
          <form
            className="col"
            onSubmit={(e) => {
              e.preventDefault();
              if (!tooMany) void start();
            }}
          >
            <p className="muted small">The slide is looked at in windows of this size; neighbouring windows overlap by the percentage below.</p>
            <div className="row">
              <label>Window (px)</label>
              <input type="number" min={MIN_WINDOW} value={viewW} onChange={(e) => setViewW(Math.max(MIN_WINDOW, Number(e.target.value) || MIN_WINDOW))} aria-label="Window width in pixels" data-testid="screening-w" />
              <span>×</span>
              <input type="number" min={MIN_WINDOW} value={viewH} onChange={(e) => setViewH(Math.max(MIN_WINDOW, Number(e.target.value) || MIN_WINDOW))} aria-label="Window height in pixels" data-testid="screening-h" />
            </div>
            <div className="row">
              <label htmlFor="screening-overlap">Overlap</label>
              <input id="screening-overlap" type="number" min={0} max={95} step={5} value={overlap} onChange={(e) => setOverlap(Math.min(95, Math.max(0, Number(e.target.value) || 0)))} data-testid="screening-overlap" />
              <span>%</span>
            </div>
            <p className={tooMany ? "error small" : "muted small"} data-testid="screening-count">
              {windows.toLocaleString("en-US")} windows{tooMany ? ` – too many (at most ${MAX_WINDOWS.toLocaleString("en-US")}): use a larger window or less overlap` : ""}
            </p>
            {mode && <p className="warn small">Starting again forgets what has been screened.</p>}
            <div className="row">
              <button className="btn primary" disabled={tooMany} data-testid="screening-start">
                {mode ? "Start again" : "Start screening"}
              </button>
              {mode && (
                <button type="button" className="btn ghost" onClick={() => setSetup(false)}>
                  Cancel
                </button>
              )}
            </div>
          </form>
        )}
      </div>
    </FloatingPanel>
  );
}
