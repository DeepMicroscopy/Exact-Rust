// The EXACT wordmark in a blocky, rectangle-built letter style (thick straight strokes, square counters).
// Letters are drawn on one grid: cap height 475, stroke 100, letter width 335, gap 51 (proportions of the
// reference lettering). Pure rectangles, so it stays crisp at any size and takes its colour from `currentColor`.

const H = 475;
const S = 100; // stroke
const W = 335; // letter width
const GAP = 51;

type Rect = [x: number, y: number, w: number, h: number];

const ROW = Math.round(H / 5); // height of one step of the X

const LETTERS: Record<string, Rect[]> = {
  E: [
    [0, 0, S, H], // stem
    [0, 0, W, S], // top
    [0, (H - S) / 2, W - 45, S], // middle arm, slightly shorter
    [0, H - S, W, S], // bottom
  ],
  // an orthogonal X: five stepped rows whose blocks overlap, so the arms are solid strokes of the common weight
  X: [
    [0, 0, S, ROW],
    [W - S, 0, S, ROW],
    [45, ROW, S, ROW],
    [W - 45 - S, ROW, S, ROW],
    [(W - 125) / 2, 2 * ROW, 125, ROW], // the arms meet
    [45, 3 * ROW, S, ROW],
    [W - 45 - S, 3 * ROW, S, ROW],
    [0, 4 * ROW, S, H - 4 * ROW],
    [W - S, 4 * ROW, S, H - 4 * ROW],
  ],
  A: [
    [0, 0, S, H], // left leg
    [W - S, 0, S, H], // right leg
    [0, 0, W, S], // top
    [0, 238, W, S], // crossbar
  ],
  C: [
    [0, 0, S, H], // back
    [0, 0, W, S], // top
    [0, H - S, W, S], // bottom
    [W - S, 0, S, 165], // top hook
    [W - S, H - 165, S, 165], // bottom hook
  ],
  T: [
    [0, 0, W, S], // bar
    [(W - 92) / 2, 0, 92, H], // stem
  ],
};

const WORD = "EXACT";
const WIDTH = WORD.length * W + (WORD.length - 1) * GAP;

export function Logo({ height = 18, className }: { height?: number; className?: string }) {
  return (
    <svg
      role="img"
      aria-label="EXACT"
      className={className}
      viewBox={`0 0 ${WIDTH} ${H}`}
      height={height}
      width={(height * WIDTH) / H}
      fill="currentColor"
      shapeRendering="crispEdges"
    >
      {[...WORD].flatMap((ch, i) =>
        LETTERS[ch].map(([x, y, w, h], j) => <rect key={`${i}-${j}`} x={i * (W + GAP) + x} y={y} width={w} height={h} />),
      )}
    </svg>
  );
}
