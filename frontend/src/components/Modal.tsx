import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** A dialog over the page: Escape and a click on the backdrop close it, the first button or field gets the focus. */
export function Modal({ title, onClose, children, wide = false, className = "" }: { title: string; onClose(): void; children: ReactNode; wide?: boolean; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  // once, when the dialog opens (not again whenever the page behind it renders and hands in a new onClose): a field of the body first
  // (the search field of a finder), else a primary button, else the first button
  useEffect(() => {
    const b = box.current;
    const first = b?.querySelector<HTMLElement>(".modal-body input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]), .modal-body textarea") ?? b?.querySelector<HTMLElement>("button.primary, button.btn");
    first?.focus();
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", key, true); // before the viewer's shortcuts
    return () => window.removeEventListener("keydown", key, true);
  }, [onClose]);
  // in the body: a dialog opened from another dialog must not sit inside its (transformed) box
  return createPortal(
    <div className="modal-back" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal glass ${wide ? "wide" : ""} ${className}`} role="dialog" aria-modal="true" aria-label={title} ref={box}>
        <header>
          <h2>{title}</h2>
          <button className="btn ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
