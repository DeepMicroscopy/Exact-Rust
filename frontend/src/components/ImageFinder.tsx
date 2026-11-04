import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listAll } from "../api/client";
import { SearchInput } from "./SearchInput";
import { Thumb } from "./Thumb";
import { Modal } from "./Modal";

/** Search the other images of the image set from within the viewer (Ctrl/Cmd + F): type, Up / Down, Enter opens. */
export function ImageFinder({ setId, currentId, onOpen, onClose }: { setId: number; currentId: number; onOpen(id: number): void; onClose(): void }) {
  const images = useQuery({ queryKey: ["set-image-names", setId], queryFn: () => listAll<{ id: number; name: string }>("/api/v2/images", { image_set: setId, fields: "id,name" }), staleTime: 60_000 });
  const [q, setQ] = useState("");
  // the dialog focuses its first button (the close button): the search field is where typing must go
  useEffect(() => document.querySelector<HTMLInputElement>(".finder input")?.focus(), []);
  const [at, setAt] = useState(0);
  const found = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return (images.data ?? []).filter((i) => words.every((w) => i.name.toLowerCase().includes(w))).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [images.data, q]);
  const shown = found.slice(0, 50);
  const cur = Math.min(at, Math.max(0, shown.length - 1));
  return (
    <Modal title="Find an image in this set" onClose={onClose}>
      <div className="finder" data-testid="image-finder">
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
              setAt((n) => Math.min(Math.max(0, n + (e.key === "ArrowDown" ? 1 : -1)), shown.length - 1));
            } else if (e.key === "Enter" && shown[cur]) {
              onOpen(shown[cur].id);
            }
          }}
        />
        {images.isLoading && <p className="muted">Loading…</p>}
        <ul className="finder-list" role="listbox" aria-label="Images">
          {shown.map((i, n) => (
            <li key={i.id} role="option" aria-selected={n === cur} className={n === cur ? "on" : ""}>
              <button className="finder-item" onClick={() => onOpen(i.id)} onMouseEnter={() => setAt(n)}>
                <span className="finder-thumb">
                  <Thumb imageId={i.id} alt="" />
                </span>
                <span className="finder-name">{i.name}</span>
                {i.id === currentId && <span className="muted small">open now</span>}
              </button>
            </li>
          ))}
          {images.data && shown.length === 0 && <li className="muted">No image of this set matches.</li>}
        </ul>
        {found.length > shown.length && <p className="muted small">Showing {shown.length} of {found.length}: type more of the name.</p>}
      </div>
    </Modal>
  );
}
