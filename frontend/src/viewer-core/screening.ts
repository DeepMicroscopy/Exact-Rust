/**
 * Screening mode: the slide is stepped through window by window. The stored form is that of the old EXACT (`images_screeningmode`, also
 * served on `/api/v1/images/screening_modes/`): `screening_tiles` is `{index: {x_min, y_min, x_max, y_max, Screened}}`, `x_steps` columns,
 * `y_steps` rows, row after row. A tile here is the *window to look at*, and neighbouring windows overlap by the chosen fraction, so
 * stepping to the next tile shows the same strip again as often as the overlap says.
 */
export interface Tile {
  x_min: number;
  y_min: number;
  x_max: number;
  y_max: number;
  Screened: boolean;
}

export interface ScreeningMode {
  id?: number;
  x_resolution: number;
  y_resolution: number;
  x_steps: number;
  y_steps: number;
  current_index: number;
  screening_tiles: Record<string, Tile>;
}

export const DEFAULT_OVERLAP = 0.2;

/** The start positions along one axis: windows of `view` pixels, `view * (1 - overlap)` apart, the last one pushed back to end at the border. */
export function starts(length: number, view: number, overlap: number): number[] {
  if (view >= length) return [0];
  const step = Math.max(1, Math.round(view * (1 - Math.min(Math.max(overlap, 0), 0.95))));
  const out: number[] = [];
  for (let at = 0; at + view < length; at += step) out.push(at);
  out.push(length - view);
  return out;
}

export function createMode(width: number, height: number, viewW: number, viewH: number, overlap: number): Omit<ScreeningMode, "id"> {
  const xs = starts(width, viewW, overlap);
  const ys = starts(height, viewH, overlap);
  const tiles: Record<string, Tile> = {};
  ys.forEach((y, r) =>
    xs.forEach((x, c) => {
      tiles[String(r * xs.length + c)] = { x_min: x, y_min: y, x_max: x + viewW, y_max: y + viewH, Screened: false };
    }),
  );
  return { x_resolution: viewW, y_resolution: viewH, x_steps: xs.length, y_steps: ys.length, current_index: 0, screening_tiles: tiles };
}

/** The overlap a stored mode was made with (the distance of its first two windows); 0 for the old EXACT's cells and for a single column. */
export function overlapOf(m: ScreeningMode): number {
  const [a, b] = [m.screening_tiles["0"], m.screening_tiles["1"]];
  if (m.x_steps > 1 && a && b && m.x_resolution > 0) return Math.min(Math.max(1 - (b.x_min - a.x_min) / m.x_resolution, 0), 0.95);
  const c = m.screening_tiles[String(m.x_steps)];
  if (m.y_steps > 1 && a && c && m.y_resolution > 0) return Math.min(Math.max(1 - (c.y_min - a.y_min) / m.y_resolution, 0), 0.95);
  return 0;
}

export type Move = "left" | "right" | "up" | "down";

/** The index after a step; unchanged at the border. */
export function moved(m: ScreeningMode, from: number, dir: Move): number {
  const col = from % m.x_steps;
  const row = Math.floor(from / m.x_steps);
  const next = dir === "left" ? (col > 0 ? from - 1 : from) : dir === "right" ? (col < m.x_steps - 1 ? from + 1 : from) : dir === "up" ? (row > 0 ? from - m.x_steps : from) : row < m.y_steps - 1 ? from + m.x_steps : from;
  return next;
}

/** The old EXACT's keys: W A S D step and count the window left as screened, I J K L step without counting. */
export function keyMove(e: { key: string; code?: string }): { dir: Move; mark: boolean } | null {
  switch (e.key.toLowerCase()) {
    case "a":
      return { dir: "left", mark: true };
    case "d":
      return { dir: "right", mark: true };
    case "w":
      return { dir: "up", mark: true };
    case "s":
      return { dir: "down", mark: true };
    case "j":
      return { dir: "left", mark: false };
    case "l":
      return { dir: "right", mark: false };
    case "i":
      return { dir: "up", mark: false };
    case "k":
      return { dir: "down", mark: false };
  }
  return null;
}

/** The window that contains an image point (the one whose centre is nearest when several do). */
export function tileAt(m: ScreeningMode, x: number, y: number): number | null {
  let best: number | null = null;
  let bestD = Infinity;
  for (const [k, t] of Object.entries(m.screening_tiles)) {
    if (x < t.x_min || x >= t.x_max || y < t.y_min || y >= t.y_max) continue;
    const d = Math.hypot((t.x_min + t.x_max) / 2 - x, (t.y_min + t.y_max) / 2 - y);
    if (d < bestD) {
      bestD = d;
      best = Number(k);
    }
  }
  return best;
}

/** Share of the slide area that lies in a screened window (not the share of windows: they overlap). */
export function coverage(m: ScreeningMode, width: number, height: number, cell = 64): number {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const seen = new Uint8Array(cols * rows);
  for (const t of Object.values(m.screening_tiles)) {
    if (!t.Screened) continue;
    for (let r = Math.floor(t.y_min / cell); r < Math.min(rows, Math.ceil(t.y_max / cell)); r++) for (let c = Math.floor(t.x_min / cell); c < Math.min(cols, Math.ceil(t.x_max / cell)); c++) seen[r * cols + c] = 1;
  }
  let n = 0;
  for (const v of seen) n += v;
  return seen.length ? n / seen.length : 0;
}
