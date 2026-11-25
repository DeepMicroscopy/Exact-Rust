/**
 * A registration that is more than an affine map (VALIS, DeeperHistReg's deformable mode): the grid points `(xs[j], ys[i])` of the
 * other image go to `dst[i][j]` in the pixels of the current image. Between the points the map is bilinear.
 */
export interface Warp {
  xs: number[];
  ys: number[];
  dst: [number, number][][];
}

type P = [number, number];
/** `[a, b, c, d, e, f]` as of `CanvasRenderingContext2D.setTransform`: x' = a x + c y + e, y' = b x + d y + f. */
export type Matrix = [number, number, number, number, number, number];

/** The affine map that takes the triangle `s` to the triangle `d`; null for a degenerate one. */
export function triangleMap(s: [P, P, P], d: [P, P, P]): Matrix | null {
  const [[x0, y0], [x1, y1], [x2, y2]] = s;
  const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (!det || !Number.isFinite(det)) return null;
  // solve [x y 1] * [a b; c d; e f] = d for the three corners
  const solve = (u0: number, u1: number, u2: number) => {
    const a = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / det;
    const c = ((x1 - x0) * (u2 - u0) - (x2 - x0) * (u1 - u0)) / det;
    return [a, c, u0 - a * x0 - c * y0] as const;
  };
  const [a, c, e] = solve(d[0][0], d[1][0], d[2][0]);
  const [b, dd, f] = solve(d[0][1], d[1][1], d[2][1]);
  return [a, b, c, dd, e, f];
}

/** The triangle pushed outwards from its centre by `by` pixels: neighbouring triangles then overlap a little and leave no seam. */
export function grow(t: [P, P, P], by: number): [P, P, P] {
  const cx = (t[0][0] + t[1][0] + t[2][0]) / 3;
  const cy = (t[0][1] + t[1][1] + t[2][1]) / 3;
  return t.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return [x + (dx / len) * by, y + (dy / len) * by] as P;
  }) as [P, P, P];
}

/** The grid cells `(i, j)` whose mapped corners touch the screen rectangle `[0, w] x [0, h]`, and the box (other image pixels) around their sources. */
export function cellsInView(warp: Warp, toScreen: (p: P) => P, w: number, h: number): { cells: [number, number][]; box: { x1: number; y1: number; x2: number; y2: number } | null } {
  const rows = warp.ys.length;
  const cols = warp.xs.length;
  const screen = warp.dst.map((row) => row.map((p) => toScreen(p)));
  const cells: [number, number][] = [];
  let box: { x1: number; y1: number; x2: number; y2: number } | null = null;
  for (let i = 0; i + 1 < rows; i++)
    for (let j = 0; j + 1 < cols; j++) {
      const c = [screen[i][j], screen[i][j + 1], screen[i + 1][j], screen[i + 1][j + 1]];
      if (Math.max(...c.map((p) => p[0])) < 0 || Math.min(...c.map((p) => p[0])) > w || Math.max(...c.map((p) => p[1])) < 0 || Math.min(...c.map((p) => p[1])) > h) continue;
      cells.push([i, j]);
      const x1 = warp.xs[j];
      const x2 = warp.xs[j + 1];
      const y1 = warp.ys[i];
      const y2 = warp.ys[i + 1];
      box = box ? { x1: Math.min(box.x1, x1), y1: Math.min(box.y1, y1), x2: Math.max(box.x2, x2), y2: Math.max(box.y2, y2) } : { x1, y1, x2, y2 };
    }
  return { cells, box };
}

