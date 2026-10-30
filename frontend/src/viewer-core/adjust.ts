/** Display adjustments of the viewer (brightness, contrast, ...): applied to what is drawn, never to the file or the annotations. */
export interface Adjust {
  /** percent, 100 = unchanged */
  brightness: number;
  contrast: number;
  saturation: number;
  /** 1 = unchanged; above 1 brightens the mid-tones */
  gamma: number;
  /** degrees */
  hue: number;
  grayscale: boolean;
  invert: boolean;
}

export const NEUTRAL: Adjust = { brightness: 100, contrast: 100, saturation: 100, gamma: 1, hue: 0, grayscale: false, invert: false };

export const GAMMA_FILTER_ID = "exact-gamma";

const KEY = "exact.adjust";

export function isNeutral(a: Adjust): boolean {
  return (Object.keys(NEUTRAL) as (keyof Adjust)[]).every((k) => a[k] === NEUTRAL[k]);
}

/** The CSS `filter` value for the drawn tiles ("" when nothing is changed). The gamma curve is an SVG filter (see `GammaFilter`). */
export function cssFilter(a: Adjust): string {
  const f: string[] = [];
  if (a.gamma !== 1) f.push(`url(#${GAMMA_FILTER_ID})`);
  if (a.brightness !== 100) f.push(`brightness(${a.brightness / 100})`);
  if (a.contrast !== 100) f.push(`contrast(${a.contrast / 100})`);
  if (a.saturation !== 100) f.push(`saturate(${a.saturation / 100})`);
  if (a.hue !== 0) f.push(`hue-rotate(${a.hue}deg)`);
  if (a.grayscale) f.push("grayscale(1)");
  if (a.invert) f.push("invert(1)");
  return f.join(" ");
}

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function parseAdjust(raw: string | null): Adjust {
  try {
    const o = JSON.parse(raw ?? "{}") as Partial<Adjust>;
    return {
      brightness: clamp(o.brightness, 0, 300, 100),
      contrast: clamp(o.contrast, 0, 300, 100),
      saturation: clamp(o.saturation, 0, 400, 100),
      gamma: clamp(o.gamma, 0.2, 5, 1),
      hue: clamp(o.hue, -180, 180, 0),
      grayscale: o.grayscale === true,
      invert: o.invert === true,
    };
  } catch {
    return { ...NEUTRAL };
  }
}

export function loadAdjust(): Adjust {
  try {
    return parseAdjust(localStorage.getItem(KEY));
  } catch {
    return { ...NEUTRAL };
  }
}

export function saveAdjust(a: Adjust): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    /* private mode */
  }
}
