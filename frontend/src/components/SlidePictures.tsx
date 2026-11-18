import { useState } from "react";
import { Modal } from "./Modal";

/** What a scanner calls its pictures ("label", "macro", "SlidePreview", ...), in words a person reads. */
export function pictureTitle(name: string): string {
  const n = name.toLowerCase();
  if (n === "label") return "Label";
  if (n === "macro") return "Macro photo";
  if (n === "slidepreview" || n === "overview") return "Slide preview";
  if (n === "thumbnail") return "Thumbnail";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The pictures the scanner stored in the slide file besides the image: label, macro photo of the whole slide, preview. */
export function SlidePictures({ imageId, names, onClose }: { imageId: number; names: string[]; onClose(): void }) {
  const [name, setName] = useState(names[0] ?? "");
  const [failed, setFailed] = useState<string | null>(null);
  const src = `/api/v2/images/${imageId}/associated-images/${encodeURIComponent(name)}`;
  return (
    <Modal title="Slide label and photos" onClose={onClose} wide>
      {names.length > 1 && (
        <div className="seg" role="tablist" aria-label="Picture">
          {names.map((n) => (
            <button key={n} role="tab" aria-selected={n === name} className={n === name ? "active" : ""} onClick={() => setName(n)}>
              {pictureTitle(n)}
            </button>
          ))}
        </div>
      )}
      <div className="slide-picture" data-testid="slide-picture">
        {failed === name ? <p className="warn small">This picture cannot be read from the file.</p> : <img key={name} src={src} alt={pictureTitle(name)} onError={() => setFailed(name)} />}
      </div>
      <p className="muted small">Stored in the slide file by the scanner.</p>
    </Modal>
  );
}
