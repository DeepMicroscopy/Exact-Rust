import type { UploadItem } from "../hooks/useUploads";

const R = 26;
const C = 2 * Math.PI * R;

/** Circular progress: fills while the file is sent, spins while the server reads it (it cannot say how far it is). */
export function Ring({ progress, spinning }: { progress: number; spinning: boolean }) {
  return (
    <svg className={`ring ${spinning ? "spin" : ""}`} viewBox="0 0 64 64" width="64" height="64" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={spinning ? undefined : Math.round(progress * 100)}>
      <circle cx="32" cy="32" r={R} className="ring-bg" />
      <circle cx="32" cy="32" r={R} className="ring-fg" strokeDasharray={spinning ? `${C * 0.25} ${C}` : `${C * progress} ${C}`} transform="rotate(-90 32 32)" />
      {!spinning && (
        <text x="32" y="36" textAnchor="middle" className="ring-text">
          {Math.round(progress * 100)}%
        </text>
      )}
    </svg>
  );
}

const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);

/** A card in the image grid for a file that is on its way. */
export function UploadTile({ item, onDismiss }: { item: UploadItem; onDismiss(): void }) {
  const failed = item.state === "error";
  return (
    <div className={`tile upload-tile glass ${item.state}`} data-testid="upload-tile" data-state={item.state}>
      <div className="upload-body">
        {failed ? (
          <span className="upload-fail" aria-hidden="true">
            !
          </span>
        ) : item.state === "waiting" ? (
          <span className="muted small">waiting</span>
        ) : (
          <Ring progress={item.progress} spinning={item.state === "processing"} />
        )}
      </div>
      <div className="tile-name" title={item.name}>
        {item.name}
      </div>
      <div className="muted small">{failed ? <span className="error">{item.message}</span> : item.state === "processing" ? `${fmtBytes(item.size)} · reading…` : fmtBytes(item.size)}</div>
      {failed && (
        <button className="btn ghost small" onClick={onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}
