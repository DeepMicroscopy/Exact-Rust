import { useState } from "react";
import { usePreferences } from "../hooks/usePreferences";
import { POINTER_GESTURES_TEXT, POINTER_MODES, type Part, type PointerKind, type PointerMode } from "../viewer-core/pointerMap";

const on = (hot: Part | null, ...parts: Part[]) => (hot && parts.includes(hot) ? "hot" : "");

function Mouse({ hot }: { hot: Part | null }) {
  return (
    <svg className="pv-device" viewBox="0 0 120 170" role="img" aria-label="A mouse with two buttons and a wheel">
      <path className="pv-body" d="M60 6c-26 0-44 18-44 46v66c0 25 18 46 44 46s44-21 44-46V52C104 24 86 6 60 6z" />
      <path className={`pv-btn ${on(hot, "left", "drag")}`} d="M58 8C32 9 18 26 18 52v10h40z" />
      <path className="pv-btn" d="M62 8c26 1 40 18 40 44v10H62z" />
      <path className="pv-split" d="M60 8v56M18 64h84" />
      <rect className={`pv-wheel ${on(hot, "wheel", "middle")}`} x="53" y="22" width="14" height="28" rx="7" />
      {hot === "middle" && <text x="60" y="84" textAnchor="middle" className="pv-note">press</text>}
      {hot === "wheel" && <path className="pv-arrows" d="M60 12v-6M56 10l4-5 4 5M60 62v6M56 64l4 5 4-5" />}
      {hot === "drag" && <path className="pv-arrows" d="M28 100h-14M18 96l-5 4 5 4M92 100h14M102 96l5 4-5 4M60 120v14M56 130l4 5 4-5" />}
    </svg>
  );
}

function Trackpad({ hot }: { hot: Part | null }) {
  const dot = (cx: number, cy: number, cls = "") => <circle className={`pv-finger ${cls}`} cx={cx} cy={cy} r="9" />;
  return (
    <svg className="pv-device" viewBox="0 0 200 150" role="img" aria-label="A trackpad">
      <rect className="pv-body" x="6" y="8" width="188" height="134" rx="14" />
      {hot === "tap" && <>{dot(100, 75, "tap")}<circle className="pv-ring" cx="100" cy="75" r="20" /></>}
      {hot === "drag" && <>{dot(70, 75)}<path className="pv-arrows" d="M82 75h60M134 68l9 7-9 7" /></>}
      {hot === "swipe2" && <>{dot(80, 60)}{dot(110, 60)}<path className="pv-arrows" d="M60 102h80M132 95l9 7-9 7M68 95l-9 7 9 7" /></>}
      {hot === "pinch" && <>{dot(72, 102)}{dot(128, 48)}<path className="pv-arrows" d="M90 84l-8 8M82 80v12h12M110 66l8-8M118 70V58h-12" /></>}
      {!hot && <text x="100" y="80" textAnchor="middle" className="pv-note">point at a gesture</text>}
    </svg>
  );
}

/** What the mouse or the trackpad does, as chosen under Preferences → Slide navigation (the other can be looked at too). */
export function PointerView({ initialMode }: { initialMode: PointerMode }) {
  const { prefs } = usePreferences();
  const [picked, setPicked] = useState<PointerKind | null>(null);
  const [mode, setMode] = useState<PointerMode>(initialMode);
  const [hot, setHot] = useState<Part | null>(null);
  const kind: PointerKind = picked ?? (prefs.legacy_navigation ? "mouse" : "trackpad");
  const rows = POINTER_GESTURES_TEXT[kind][mode];
  return (
    <div className="pv" data-testid="pointer-view">
      <div className="kb-controls">
        <div className="seg" role="group" aria-label="Situation">
          {POINTER_MODES.map((m) => (
            <button key={m.id} aria-pressed={mode === m.id} className={mode === m.id ? "active" : ""} onClick={() => setMode(m.id)} data-testid={`pv-mode-${m.id}`}>
              {m.title}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Device">
          <button aria-pressed={kind === "mouse"} className={kind === "mouse" ? "active" : ""} onClick={() => setPicked("mouse")} data-testid="pv-mouse">
            Mouse-optimized
          </button>
          <button aria-pressed={kind === "trackpad"} className={kind === "trackpad" ? "active" : ""} onClick={() => setPicked("trackpad")} data-testid="pv-trackpad">
            Trackpad / tablet
          </button>
        </div>
      </div>
      <p className="muted small">
        Your setting (Preferences → Slide navigation): <b>{prefs.legacy_navigation ? "mouse-optimized" : "trackpad / tablet-optimized"}</b>.
      </p>
      <div className="pv-body-row">
        <div className="pv-figure">{kind === "mouse" ? <Mouse hot={hot} /> : <Trackpad hot={hot} />}</div>
        <ul className="pv-list" data-testid="pv-list">
          {rows.map((g) => (
            <li key={g.how + g.text} onPointerEnter={() => setHot(g.part)} onPointerLeave={() => setHot(null)} onFocus={() => setHot(g.part)} onBlur={() => setHot(null)} tabIndex={0} data-part={g.part}>
              <b>{g.how}</b>
              <span>{g.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
