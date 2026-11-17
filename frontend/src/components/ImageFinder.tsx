import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listAll } from "../api/client";
import { SearchInput } from "./SearchInput";
import { Thumb } from "./Thumb";
import { Modal } from "./Modal";

/** Sent by Ctrl/Cmd + F and "/" so that an already open (pinned) finder takes the focus. */
export const FINDER_FOCUS = "exact:finder-focus";

const STORE = "exact-image-finder";

/** What the viewer remembers of the finder: whether it is pinned (stays beside the image) and, if so, whether it is open. */
export function readFinder(): { pinned: boolean; open: boolean } {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "{}");
    return {
      pinned: v.pinned === true,
      open: v.pinned === true && v.open === true,
    };
  } catch {
    return { pinned: false, open: false };
  }
}

export function saveFinder(pinned: boolean, open: boolean) {
  try {
    localStorage.setItem(STORE, JSON.stringify({ pinned, open }));
  } catch {
    /* private window: the pin is then only kept until the page is left */
  }
}

/**
 * Search the other images of the image set from within the viewer (Ctrl/Cmd + F): type, Up / Down, Enter opens. A dialog at first;
 * the pin turns it into a panel beside the image that stays open (and keeps the viewer's keys working) while images are opened.
 */
export function ImageFinder({
  setId,
  currentId,
  pinned,
  onPin,
  onOpen,
  onClose,
}: {
  setId: number;
  currentId: number;
  pinned: boolean;
  onPin(pinned: boolean): void;
  onOpen(id: number): void;
  onClose(): void;
}) {
  const images = useQuery({
    queryKey: ["set-image-names", setId],
    queryFn: () =>
      listAll<{ id: number; name: string }>("/api/v2/images", {
        image_set: setId,
        fields: "id,name",
      }),
    staleTime: 60_000,
  });
  const [q, setQ] = useState("");
  // (the dialog itself puts the focus into the first field; this also covers the pin, which replaces the dialog by a panel)
  const focusSearch = () =>
    document.querySelector<HTMLInputElement>(".finder input")?.focus();
  // pinning moves the finder from the dialog to the panel (new elements): the search field takes the focus again
  useEffect(() => focusSearch(), [pinned]);
  useEffect(() => {
    window.addEventListener(FINDER_FOCUS, focusSearch);
    return () => window.removeEventListener(FINDER_FOCUS, focusSearch);
  }, []);
  const [at, setAt] = useState(0);
  const found = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (images.data ?? [])
      .filter((i) => words.every((w) => i.name.toLowerCase().includes(w)))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
  }, [images.data, q]);
  const shown = found.slice(0, 50);
  const cur = Math.min(at, Math.max(0, shown.length - 1));
  const body = (
    <div
      className={`finder ${pinned ? "pinned" : ""}`}
      data-testid="image-finder"
    >
      <div className="finder-head">
        <SearchInput
          history="viewer-images"
          className="search"
          placeholder="Name of the image…"
          aria-label="Find an image"
          value={q}
          onChange={(v) => {
            setQ(v);
            setAt(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setAt((n) =>
                Math.min(
                  Math.max(0, n + (e.key === "ArrowDown" ? 1 : -1)),
                  shown.length - 1,
                ),
              );
            } else if (e.key === "Enter" && shown[cur]) {
              onOpen(shown[cur].id);
            } else if (e.key === "Escape" && pinned) {
              e.stopPropagation();
              (e.target as HTMLElement).blur(); // back to the image, the panel stays
            }
          }}
        />
        <button
          className={`btn ghost finder-pin ${pinned ? "on" : ""}`}
          onClick={() => onPin(!pinned)}
          aria-pressed={pinned}
          title={
            pinned
              ? "Unpin: show the finder as a dialog again"
              : "Pin: keep the finder beside the image while you annotate"
          }
          data-testid="finder-pin"
        >
          {pinned ? "📌 Pinned" : "📌 Pin"}
        </button>
        {pinned && (
          <button
            className="btn ghost"
            onClick={onClose}
            aria-label="Close the finder"
            data-testid="finder-close"
          >
            ✕
          </button>
        )}
      </div>
      {images.isLoading && <p className="muted">Loading…</p>}
      <ul className="finder-list" role="listbox" aria-label="Images">
        {shown.map((i, n) => (
          <li
            key={i.id}
            role="option"
            aria-selected={n === cur}
            className={n === cur ? "on" : ""}
          >
            <button
              className="finder-item"
              onClick={() => onOpen(i.id)}
              onMouseEnter={() => setAt(n)}
            >
              <span className="finder-thumb">
                <Thumb imageId={i.id} alt="" />
              </span>
              <span className="finder-name">{i.name}</span>
              {i.id === currentId && (
                <span className="muted small">open now</span>
              )}
            </button>
          </li>
        ))}
        {images.data && shown.length === 0 && (
          <li className="muted">No image of this set matches.</li>
        )}
      </ul>
      {found.length > shown.length && (
        <p className="muted small">
          Showing {shown.length} of {found.length}: type more of the name.
        </p>
      )}
    </div>
  );
  return pinned ? (
    <aside className="finder-dock glass" aria-label="Find an image in this set">
      {body}
    </aside>
  ) : (
    <Modal title="Find an image in this set" onClose={onClose}>
      {body}
    </Modal>
  );
}
