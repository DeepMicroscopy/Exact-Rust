export interface ZRange {
  start: number;
  end: number;
  unit: string;
  positions: number[];
}

/** Real position at a (fractional) frame position, interpolated between the positions of the two planes. */
export function positionAt(range: ZRange, v: number): number {
  const p = range.positions;
  if (p.length === 0) return range.start;
  const k = Math.min(Math.max(Math.floor(v), 0), p.length - 1);
  const next = Math.min(k + 1, p.length - 1);
  return p[k] + (p[next] - p[k]) * Math.min(Math.max(v - k, 0), 1);
}

/** `-6.0 µm`, `+1.5 µm`: signed, one decimal. */
export function formatZ(value: number, unit: string): string {
  const v = Math.abs(value) < 0.05 ? 0 : value;
  const s = v === 0 ? "0.0" : `${v > 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;
  return `${s} ${unit}`.trim();
}
