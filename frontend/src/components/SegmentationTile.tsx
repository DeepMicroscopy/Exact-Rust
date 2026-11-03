import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMenuTrigger } from "./ImageMenu";
import type { LinkedFile } from "./LinkSegmentationDialog";

/**
 * A segmentation file (3D Slicer NRRD) in the image grid, next to the images: its picture is the busiest axial slice (over the
 * volume's own slice when it is linked). A click opens it in the three-plane view of its volume; a file without a volume asks for
 * one first. The menu (right click, long press) has the rest: link, unlink, download, delete.
 */
export function SegmentationTile({ file, volumeName, onOpen, onMenu }: { file: LinkedFile; volumeName: string | null; onOpen(): void; onMenu(x: number, y: number): void }) {
  const trigger = useMenuTrigger(onMenu);
  const [failed, setFailed] = useState(false);
  const n = file.segments.length;
  return (
    <div className="tile glass seg-tile" data-testid="seg-tile" {...trigger}>
      <button className="tile-link seg-open" onClick={onOpen} draggable={false} title={file.image == null ? "Link it to a volume to open it" : "Open it over its volume"}>
        {failed ? <div className="thumb placeholder" aria-label={file.name} /> : <img className="thumb" loading="lazy" decoding="async" fetchPriority="low" alt={file.name} src={`/api/v2/linked-volumes/${file.id}/thumbnail?v=${file.image ?? 0}`} onError={() => setFailed(true)} />}
        <span className="badge seg-badge">▨ segmentation</span>
        <div className="tile-name" title={file.filename}>
          {file.name}
        </div>
        <div className="muted small">
          {n} segment{n === 1 ? "" : "s"} · {file.image == null ? <span className="seg-unlinked">not linked</span> : <>on {volumeName ?? `image ${file.image}`}</>}
        </div>
      </button>
    </div>
  );
}

export interface SegmentationMenuModel {
  x: number;
  y: number;
  file: LinkedFile;
  canEdit: boolean;
}

/** The menu of a segmentation file in the grid. Closes on a choice, Escape, or a click elsewhere. */
export function SegmentationMenu({ model, onClose, onOpen, onLink, onUnlink, onDelete }: { model: SegmentationMenuModel; onClose(): void; onOpen(): void; onLink(): void; onUnlink(): void; onDelete(): void }) {
  const root = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: model.x, top: model.y });
  const { file, canEdit } = model;
  useLayoutEffect(() => {
    const r = root.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ left: Math.max(8, Math.min(model.x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(model.y, window.innerHeight - r.height - 8)) });
  }, [model.x, model.y]);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [onClose]);
  const pick = (fn: () => void) => () => {
    onClose();
    fn();
  };
  return (
    <div className="ctx glass" ref={root} style={pos} role="menu" aria-label={`Menu of ${file.name}`} onContextMenu={(e) => e.preventDefault()}>
      <div className="ctx-title muted small" title={file.filename}>
        {file.name}
      </div>
      <button role="menuitem" onClick={pick(onOpen)}>
        {file.image == null ? "Link to a volume to open…" : "Open over its volume"}
      </button>
      <a role="menuitem" className="ctx-link" href={`/api/v2/linked-volumes/${file.id}/file`} download onClick={() => window.setTimeout(onClose, 50)}>
        Download
      </a>
      {canEdit && file.image != null && (
        <button role="menuitem" onClick={pick(onLink)}>
          Link to another volume…
        </button>
      )}
      {canEdit && file.image != null && (
        <button role="menuitem" onClick={pick(onUnlink)}>
          Unlink
        </button>
      )}
      {canEdit && (
        <button role="menuitem" className="danger" onClick={pick(onDelete)}>
          Delete…
        </button>
      )}
    </div>
  );
}
