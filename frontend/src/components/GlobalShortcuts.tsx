import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { isTypingTarget } from "../viewer-core/shortcuts";
import { SCOPE_TITLE, SHORTCUTS, scopeOf, type Scope } from "../viewer-core/shortcutTable";
import { PointerView } from "./PointerView";
import { KeyboardView } from "./KeyboardView";
import { Modal } from "./Modal";

/** Sent by the "?" buttons: opens the list of keys. */
export const SHOW_HELP = "exact:shortcut-help";

/** The visible search field that is on top (a dialog's before the page's). */
function searchField(): HTMLInputElement | null {
  const all = [...document.querySelectorAll<HTMLInputElement>("input[data-search]")].filter((i) => i.offsetParent !== null);
  return all[all.length - 1] ?? null;
}

/** The list of keys for the page the user is on (the page's own first). */
export function ShortcutHelp({ onClose }: { onClose(): void }) {
  const here = scopeOf(useLocation().pathname);
  const [view, setView] = useState<"keyboard" | "pointer" | "list">("keyboard");
  const order: Scope[] = [here, "everywhere", ...(["lists", "viewer", "volume"] as Scope[]).filter((s) => s !== here)];
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose} wide>
      <div className="seg help-tabs" role="tablist" aria-label="View">
        <button role="tab" aria-selected={view === "keyboard"} className={view === "keyboard" ? "active" : ""} onClick={() => setView("keyboard")} data-testid="help-tab-keyboard">
          On a keyboard
        </button>
        <button role="tab" aria-selected={view === "pointer"} className={view === "pointer" ? "active" : ""} onClick={() => setView("pointer")} data-testid="help-tab-pointer">
          Mouse / trackpad
        </button>
        <button role="tab" aria-selected={view === "list"} className={view === "list" ? "active" : ""} onClick={() => setView("list")} data-testid="help-tab-list">
          As a list
        </button>
      </div>
      {view === "pointer" && <PointerView initialMode={here === "volume" ? "volume" : "select"} />}
      {view === "keyboard" && <KeyboardView initialMode={here === "volume" ? "volume" : here === "viewer" ? "viewer" : "lists"} />}
      <div className="shortcut-help" data-testid="shortcut-help" hidden={view !== "list"}>
        {order.map((scope, n) => (
          <section key={scope} className={n > 1 ? "other" : ""}>
            <h3>{SCOPE_TITLE[scope]}{scope === here && <span className="muted small"> (this page)</span>}</h3>
            <dl>
              {SHORTCUTS.filter((s) => s.scope === scope).map((s) => (
                <div key={s.keys + s.text}>
                  <dt>
                    {s.keys.split(/\s{2}or\s{2}/).map((alt, i) => (
                      <span key={alt}>
                        {i > 0 && <span className="muted"> or </span>}
                        <kbd>{alt}</kbd>
                      </span>
                    ))}
                  </dt>
                  <dd>{s.text}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}

/** Keys that work on every page: `?` (the list), G then P (preferences), `/` and Ctrl/Cmd + F (the search field of the page). */
export function GlobalShortcuts() {
  const [help, setHelp] = useState(false);
  const navigate = useNavigate();
  const g = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey && e.key.toLowerCase() === "f") {
        const f = searchField();
        if (f) {
          e.preventDefault();
          f.focus();
          f.select();
        }
        return;
      }
      if (mod || e.altKey || isTypingTarget(e.target)) return;
      if (e.key === "?") {
        e.preventDefault();
        setHelp((h) => !h);
      } else if (e.key === "/") {
        const f = searchField();
        if (f) {
          e.preventDefault();
          f.focus();
          f.select();
        }
      } else if (e.key.toLowerCase() === "g" && !e.shiftKey) {
        g.current = Date.now();
      } else if (e.key.toLowerCase() === "p" && !e.shiftKey && Date.now() - g.current < 1200) {
        g.current = 0;
        navigate("/preferences");
      }
    };
    const open = () => setHelp(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(SHOW_HELP, open);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(SHOW_HELP, open);
    };
  }, [navigate]);
  return help ? <ShortcutHelp onClose={() => setHelp(false)} /> : null;
}
