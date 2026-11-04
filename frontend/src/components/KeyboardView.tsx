import { useEffect, useState } from "react";
import { LAYERS, MODES, resolve, type KbLayer, type KbLayout, type KbMode } from "../viewer-core/keyboardMap";

const KINDS = [
  ["move", "Move, zoom, step"],
  ["edit", "Edit annotations"],
  ["tool", "Tools"],
  ["view", "Show / hide"],
  ["image", "Images"],
  ["help", "Help, search"],
] as const;

function initialLayout(): KbLayout {
  try {
    const v = localStorage.getItem("exact.kb.layout");
    if (v === "en" || v === "de") return v;
  } catch {
    /* default below */
  }
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("de") ? "de" : "en";
}

/** The shortcuts on a keyboard: choose the layout (English / German), the situation, and hold Shift or Ctrl / ⌘ to see what they add. */
export function KeyboardView({ initialMode }: { initialMode: KbMode }) {
  const [layout, setLayout] = useState<KbLayout>(initialLayout);
  const [mode, setMode] = useState<KbMode>(initialMode);
  const [picked, setPicked] = useState<KbLayer>("none");
  const [held, setHeld] = useState<KbLayer>("none");
  const [tip, setTip] = useState<string>("");
  // holding Shift or Ctrl / ⌘ while the help is open shows that layer
  useEffect(() => {
    const on = (e: KeyboardEvent) => setHeld(e.ctrlKey || e.metaKey ? "ctrl" : e.shiftKey ? "shift" : "none");
    const off = () => setHeld("none");
    window.addEventListener("keydown", on);
    window.addEventListener("keyup", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("keydown", on);
      window.removeEventListener("keyup", on);
      window.removeEventListener("blur", off);
    };
  }, []);
  const layer = held !== "none" ? held : picked;
  const rows = resolve(layout, mode, layer);
  const choose = (l: KbLayout) => {
    setLayout(l);
    try {
      localStorage.setItem("exact.kb.layout", l);
    } catch {
      /* not remembered */
    }
  };
  return (
    <div className="kb" data-testid="keyboard-view">
      <div className="kb-controls">
        <div className="seg" role="group" aria-label="Situation">
          {MODES.map((m) => (
            <button key={m.id} aria-pressed={mode === m.id} className={mode === m.id ? "active" : ""} onClick={() => setMode(m.id)} data-testid={`kb-mode-${m.id}`}>
              {m.title}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Keyboard layout">
          <button aria-pressed={layout === "en"} className={layout === "en" ? "active" : ""} onClick={() => choose("en")} data-testid="kb-en">
            English
          </button>
          <button aria-pressed={layout === "de"} className={layout === "de" ? "active" : ""} onClick={() => choose("de")} data-testid="kb-de">
            Deutsch
          </button>
        </div>
        <div className="seg" role="group" aria-label="Held key">
          {LAYERS.map((l) => (
            <button key={l.id} aria-pressed={layer === l.id} className={layer === l.id ? "active" : ""} onClick={() => setPicked(l.id)} data-testid={`kb-layer-${l.id}`}>
              {l.title}
            </button>
          ))}
        </div>
      </div>
      <div className="kb-board" role="img" aria-label={`Keyboard with the shortcuts of: ${MODES.find((m) => m.id === mode)?.title}, ${layer === "none" ? "plain keys" : layer === "shift" ? "with Shift" : "with Ctrl or Command"}`}>
        {rows.map((row, i) => (
          <div className="kb-row" key={i}>
            {row.map(({ cap, legend, shifted, binding, viaShift }) => (
              <div
                key={cap.code}
                className={`kb-key ${binding ? `bound ${binding.kind}` : ""} ${cap.mod ? "mod" : ""}`}
                style={{ width: `calc(var(--kb-u) * ${cap.w ?? 1})`, marginLeft: cap.gap ? `calc(var(--kb-u) * ${cap.gap})` : undefined }}
                title={binding ? `${viaShift ? "Shift + " : ""}${legend}: ${binding.text}` : undefined}
                onPointerEnter={() => setTip(binding ? `${viaShift ? `Shift + ${shifted}` : legend}: ${binding.text}` : "")}
                data-testid={`kb-key-${cap.code}`}
                data-action={binding?.label ?? ""}
              >
                <span className="kb-legend">
                  {shifted && layout === "en" && shifted.length === 1 && !/[A-Z]/.test(legend) ? <i>{shifted}</i> : null}
                  {legend}
                </span>
                {binding && <span className="kb-action">{binding.label}</span>}
              </div>
            ))}
          </div>
        ))}
      </div>
      <p className="kb-tip muted small" aria-live="polite">{tip || "Hold Shift or Ctrl / ⌘ (or use the buttons) to see what they add. Point at a key for the full text."}</p>
      <div className="kb-legendbar">
        {KINDS.map(([k, t]) => (
          <span key={k}>
            <i className={`kb-swatch ${k}`} /> {t}
          </span>
        ))}
      </div>
    </div>
  );
}
