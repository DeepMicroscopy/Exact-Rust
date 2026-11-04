/** A small looping animation of how a slide is navigated: `mouse` (click zooms, drag moves) or `touch` (pinch zooms, two fingers move, drag selects). */
export function NavigationDemo({ kind }: { kind: "mouse" | "touch" }) {
  return (
    <svg className={`nav-demo nav-demo-${kind}`} viewBox="0 0 240 150" aria-hidden="true" focusable="false">
      <defs>
        <clipPath id={`nd-clip-${kind}`}>
          <rect x="10" y="8" width="220" height="134" rx="6" />
        </clipPath>
      </defs>
      <rect x="10" y="8" width="220" height="134" rx="6" className="nd-frame" />
      <g clipPath={`url(#nd-clip-${kind})`}>
        <g className="nd-slide">
          <rect x="0" y="0" width="240" height="150" className="nd-bg" />
          <path className="nd-tissue" d="M60 40c20-22 60-18 78-4 22 16 48 8 62 28 10 22-8 44-36 48-20 3-30 18-58 16-32-2-62-14-64-40-2-20 4-34 18-48z" />
          <circle className="nd-cell" cx="110" cy="60" r="5" />
          <circle className="nd-cell" cx="150" cy="82" r="6" />
          <circle className="nd-cell" cx="92" cy="92" r="4" />
          <circle className="nd-cell" cx="168" cy="58" r="4" />
        </g>
        {kind === "mouse" ? (
          <>
            <circle className="nd-ripple" cx="150" cy="75" r="14" />
            <path className="nd-cursor" d="M0 0l0 15 4-4 3 7 3-1.5-3-7 6 0z" />
          </>
        ) : (
          <>
            <rect className="nd-select" x="80" y="40" width="70" height="46" rx="2" />
            <circle className="nd-finger nd-f1" r="7" />
            <circle className="nd-finger nd-f2" r="7" />
          </>
        )}
      </g>
    </svg>
  );
}
