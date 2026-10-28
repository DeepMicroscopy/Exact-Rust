import { Modal } from "./Modal";

export function ConfirmDelete({ what, onConfirm, onClose }: { what: string; onConfirm(): void; onClose(): void }) {
  return (
    <Modal title="Delete annotation?" onClose={onClose}>
      <p>{what}</p>
      <p className="muted small">You can bring it back with Undo (Ctrl+Z) in this session.</p>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn danger"
          autoFocus
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          Delete
        </button>
      </div>
    </Modal>
  );
}
