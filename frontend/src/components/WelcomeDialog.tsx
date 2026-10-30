import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { Modal } from "./Modal";

/** Opened from the top bar: "What's new" shows the greeting again. */
export const OPEN_WELCOME = "exact:whatsnew";

interface Welcome {
  show: boolean;
  notice: string | null;
}

const ITEMS: { title: string; text: React.ReactNode }[] = [
  {
    title: "Same account, same data",
    text: "Your annotations, image sets and teams are the ones you know from EXACT. Nothing has to be moved or converted.",
  },
  {
    title: "Faster",
    text: "Image sets, lists and slides open in a fraction of the time, and a large slide that needs a moment to open says so with a spinner.",
  },
  {
    title: "Annotating",
    text: (
      <>
        Click an annotation to select it, then drag it or its handles. The toolbox at the bottom follows what you are doing. Keys work as before: <kbd>1</kbd>–<kbd>9</kbd> choose the type,{" "}
        <kbd>Y</kbd> hides the annotations, <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes. New: <kbd>A</kbd> switches to one-click mode, where every click places an annotation of the type's size.
      </>
    ),
  },
  {
    title: "Polygons",
    text: (
      <>
        Drag along an outline, or click the corners. <kbd>Shift</kbd>+drag adds area to a selected polygon, <kbd>Alt</kbd>+drag erases it; <kbd>S</kbd>, <kbd>G</kbd> and <kbd>D</kbd> are scissors, glue and knife. With{" "}
        <kbd>Shift</kbd>+drag you move the image while drawing.
      </>
    ),
  },
  {
    title: "Tablet and pen",
    text: "On an iPad the Apple Pencil paints polygons like a brush (round + / − buttons and the brush size appear at the edge of the screen), a finger moves and zooms the image. Phones are good for looking.",
  },
  {
    title: "In the image sets",
    text: "Drop files on an image set to upload them, register two images onto each other, export annotations, and look at the statistics of a team. CT and MRI volumes open in three planes.",
  },
];

/**
 * The greeting for people who have not been on this server before: what is different from the EXACT they know. It appears once after the
 * first login (the server remembers per user that it was shown); "What's new" in the top bar opens it again. Closing it, in any way, counts as seen.
 */
export function WelcomeGate() {
  const qc = useQueryClient();
  const welcome = useQuery({ queryKey: ["welcome"], queryFn: () => api<Welcome>("/api/v2/welcome"), staleTime: Infinity, retry: false });
  const [open, setOpen] = useState(false);
  const [shownOnce, setShownOnce] = useState(false);
  useEffect(() => {
    if (welcome.data?.show && !shownOnce) {
      setShownOnce(true);
      setOpen(true);
    }
  }, [welcome.data, shownOnce]);
  useEffect(() => {
    const again = () => setOpen(true);
    window.addEventListener(OPEN_WELCOME, again);
    return () => window.removeEventListener(OPEN_WELCOME, again);
  }, []);
  if (!open) return null;
  const close = () => {
    setOpen(false);
    if (welcome.data?.show) {
      void api("/api/v2/welcome/seen", { method: "POST" }).catch(() => undefined);
      qc.setQueryData<Welcome>(["welcome"], { ...welcome.data, show: false });
    }
  };
  return (
    <Modal title="Welcome to the new EXACT" onClose={close} className="welcome-modal">
      <div data-testid="welcome">
        {welcome.data?.notice && (
          <p className="welcome-notice" role="note" data-testid="welcome-notice">
            {welcome.data.notice}
          </p>
        )}
        <div className="welcome-scroll">
          <p className="muted">A new interface for the EXACT you use. Here is what is different:</p>
          <ul className="welcome-list">
            {ITEMS.map((i) => (
              <li key={i.title}>
                <strong>{i.title}</strong>
                <span>{i.text}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="muted small">You can read this again any time under "What's new" in the menu at the top.</p>
        <div className="modal-actions">
          <button className="btn primary" onClick={close} data-testid="welcome-close">
            Got it
          </button>
        </div>
      </div>
    </Modal>
  );
}
