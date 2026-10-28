import { Modal } from "./Modal";

/** Changing to a fixed-size type changes the size: ask whether to resize (around the centre) or leave the class alone. */
/** Old box (dashed) and new box (solid) around the same centre, scaled to fit. */
function SizeChange({ from, to }: { from: [number, number]; to: [number, number] }) {
  const W = 260;
  const H = 120;
  const pad = 14;
  const k = Math.min((W - 2 * pad) / Math.max(from[0], to[0]), (H - 2 * pad) / Math.max(from[1], to[1]));
  const box = (s: [number, number]) => ({ x: W / 2 - (s[0] * k) / 2, y: H / 2 - (s[1] * k) / 2, w: s[0] * k, h: s[1] * k });
  const a = box(from);
  const b = box(to);
  return (
    <svg className="size-change" data-testid="size-change" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={`from ${from[0]}×${from[1]} to ${to[0]}×${to[1]} px`}>
      <rect x={a.x} y={a.y} width={a.w} height={a.h} fill="none" stroke="currentColor" strokeOpacity={0.6} strokeDasharray="4 3" />
      <rect x={b.x} y={b.y} width={b.w} height={b.h} fill="rgba(80,160,255,0.2)" stroke="#4aa3ff" strokeWidth={2} />
      <circle cx={W / 2} cy={H / 2} r={2} fill="currentColor" />
    </svg>
  );
}

export function ConfirmResize({ typeName, from, to, sizeLabel, onConfirm, onClose }: { typeName: string; from: [number, number]; to: [number, number]; sizeLabel: string | null; onConfirm(): void; onClose(): void }) {
  return (
    <Modal title="Resize the annotation?" onClose={onClose}>
      <p>
        <strong>{typeName}</strong> has a fixed size of {to[0]} × {to[1]} px{sizeLabel ? ` (${sizeLabel})` : ""}, but this annotation is {from[0]} × {from[1]} px.
      </p>
      <div style={{ textAlign: "center" }}>
        <SizeChange from={from} to={to} />
        <div className="muted" style={{ fontSize: 12 }}>
          dashed: now ({from[0]} × {from[1]}) · solid: after ({to[0]} × {to[1]})
        </div>
      </div>
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
