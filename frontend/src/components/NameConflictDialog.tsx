import { useState } from "react";
import type { NameConflict } from "../hooks/useUploads";
import { Modal } from "./Modal";

/** The set has an image of this name already: give the file another name or leave it out. */
export function NameConflictDialog({ conflict, onResolve }: { conflict: NameConflict; onResolve(name: string | null): void }) {
  const [name, setName] = useState(conflict.suggestion);
  const trimmed = name.trim();
  return (
    <Modal title="An image of this name exists" onClose={() => onResolve(null)}>
      <p>
        This image set has an image named <strong>{conflict.file.name}</strong> already. Upload the file under another name, or cancel it.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed) onResolve(trimmed);
        }}
      >
        <label className="field">
          <span>New name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="New name" maxLength={255} />
        </label>
        <p className="muted small">Keep the file extension: it tells the server what kind of file it is.</p>
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={() => onResolve(null)}>
            Cancel upload
          </button>
          <button type="submit" className="btn primary" disabled={!trimmed || trimmed === conflict.file.name}>
            Upload as “{trimmed || "…"}”
          </button>
        </div>
      </form>
    </Modal>
  );
}
