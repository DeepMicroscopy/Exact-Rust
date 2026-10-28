import { useState } from "react";
import type { SetImage } from "../api/types";
import { Thumb } from "./Thumb";

/** Choose one image by its preview (names alone are easily confused); a filter appears for long lists. */
export function ImagePicker({ label, images, value, onChange }: { label: string; images: Pick<SetImage, "id" | "name">[]; value: number; onChange(id: number): void }) {
  const [q, setQ] = useState("");
  const shown = images.filter((i) => i.name.toLowerCase().includes(q.trim().toLowerCase()) || i.id === value);
  return (
    <div className="field">
      <span>{label}</span>
      {images.length > 8 && <input className="search" placeholder="Filter by name" value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Filter ${label}`} />}
      <div className="img-picker" role="radiogroup" aria-label={label}>
        {shown.map((i) => (
          <button key={i.id} type="button" role="radio" aria-checked={i.id === value} aria-label={i.name} className="img-pick" onClick={() => onChange(i.id)} title={i.name}>
            <Thumb imageId={i.id} alt="" />
            <span className="name">{i.name}</span>
          </button>
        ))}
        {shown.length === 0 && <span className="muted small">No images.</span>}
      </div>
    </div>
  );
}
