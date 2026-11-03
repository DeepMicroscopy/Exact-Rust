import { useState } from "react";
import { api, ApiError } from "../api/client";
import { Modal } from "./Modal";
import type { LinkedFile } from "./LinkSegmentationDialog";

/** An uploaded file that is an NRRD (a 3D Slicer segmentation) cannot be opened as an image. */
export const isNrrdName = (name: string | undefined | null) => /\.nrrd$/i.test(name ?? "");

/**
 * Asks whether an NRRD that was uploaded as an image should become a segmentation file of its image set (see
 * `POST /images/{id}/convert-to-segmentation`): it is then linked to a volume and drawn over it. The file stays, the image entry goes;
 * a file with annotations, registrations or crops is refused with the reason.
 */
export function ConvertSegmentationDialog({ image, onClose, onConverted }: { image: { id: number; name: string }; onClose(): void; onConverted(file: LinkedFile): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const convert = async () => {
    setBusy(true);
    setError(null);
    try {
      const file = await api<LinkedFile>(`/api/v2/images/${image.id}/convert-to-segmentation`, { method: "POST" });
      onConverted(file);
    } catch (e) {
      setError(e instanceof ApiError ? e.detail : String(e));
      setBusy(false);
    }
  };
  return (
    <Modal title="This is a segmentation file" onClose={busy ? () => undefined : onClose}>
      <div data-testid="convert-seg">
        <p>
          <strong>{image.name}</strong> is a 3D Slicer segmentation (NRRD). It cannot be shown as an image.
        </p>
        <p>
          Convert it to a <strong>segmentation file</strong>: it stays in this image set, you link it to its CT or MR volume (the name tells which) and it is drawn over the volume.
          Its segments can then be imported as annotations. The entry in the image list goes; the file itself is kept.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Not now
          </button>
          <button className="btn primary" onClick={() => void convert()} disabled={busy} data-testid="convert-go">
            Convert to segmentation file
          </button>
        </div>
      </div>
    </Modal>
  );
}
