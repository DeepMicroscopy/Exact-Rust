import { useState } from "react";
import { Modal } from "./Modal";

/** A link or password the server shows only once: to copy now. */
export function SecretDialog({ title, intro, value, onClose }: { title: string; intro: string; value: string; onClose(): void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <p>{intro}</p>
      <input className="mono secret" readOnly value={value} onFocus={(e) => e.currentTarget.select()} aria-label="Secret" data-testid="secret" />
      <p className="muted small">It is not stored in a readable form and cannot be shown again.</p>
      <div className="modal-actions">
        <button
          className="btn"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
