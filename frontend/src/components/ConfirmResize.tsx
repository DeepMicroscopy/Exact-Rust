import { Modal } from "./Modal";

/** Changing to a fixed-size type changes the size: ask whether to resize (around the centre) or leave the class alone. */
export function ConfirmResize({ typeName, from, to, sizeLabel, onConfirm, onClose }: { typeName: string; from: [number, number]; to: [number, number]; sizeLabel: string | null; onConfirm(): void; onClose(): void }) {
  return (
    <Modal title="Resize the annotation?" onClose={onClose}>
      <p>
        <strong>{typeName}</strong> has a fixed size of {to[0]} × {to[1]} px{sizeLabel ? ` (${sizeLabel})` : ""}, but this annotation is {from[0]} × {from[1]} px.
      </p>
      <p>Resize it to that size around its centre and change the class, or leave it as it is?</p>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Keep the class
        </button>
        <button
          className="btn primary"
          autoFocus
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          Resize and change class
        </button>
      </div>
    </Modal>
  );
}
