/** The same colour, darker (for the second stripe). */
export function darker(hex: string, factor = 0.5): string {
  const v = parseInt(hex.replace("#", ""), 16) || 0;
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) => Math.round(x * factor));
  return `#${c.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
