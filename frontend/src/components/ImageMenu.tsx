import { useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";

export interface Related {
  id: number;
  name: string;
  set: number;
  set_name: string;
  kind: "crop_of" | "crop" | "registered_to" | "registered_from" | "segmentation";
  /** a segmentation entry: the file (its `id` is the volume it opens) */
  file?: number;
}

const KIND: Record<Related["kind"], string> = {
  crop_of: "Cropped from",
  crop: "Crop of this image",
  registered_to: "Registered onto",
  registered_from: "Registered from",
  segmentation: "Segmentation file",
};

export interface ImageMenuModel {
  x: number;
  y: number;
  id: number;
  name: string;
  /** how many images Move acts on: the whole selection when the image is part of it */
  moveCount: number;
  canMove: boolean;
  moveWhy: string;
}

/**
 * The menu of an image in the image-set overview (right click, or a long press on a touch screen): open, download, move,
 * and the images linked to it (registrations, crops). Closes on a choice, Escape, or a click elsewhere.
 */
export function ImageMenu({ model, onClose, onMove, onConvert }: { model: ImageMenuModel; onClose(): void; onMove(): void; /** an NRRD segmentation that was uploaded as an image can become a segmentation file */ onConvert?(): void }) {
  const root = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const [pos, setPos] = useState({ left: model.x, top: model.y });
  const [open, setOpen] = useState(false);
  const related = useQuery({ queryKey: ["related", model.id], queryFn: () => api<Related[]>(`/api/v2/images/${model.id}/related`), staleTime: 30_000 });
  const links = related.data ?? [];
  const packed = /\.(mrxs|vsi)$/i.test(model.name);

  useLayoutEffect(() => {
    const r = root.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ left: Math.max(8, Math.min(model.x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(model.y, window.innerHeight - r.height - 8)) });
  }, [model.x, model.y, open, links.length]);

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

  return (
    <div className="ctx glass" ref={root} style={pos} role="menu" aria-label={`Menu of ${model.name}`} onContextMenu={(e) => e.preventDefault()}>
      <div className="ctx-title muted small" title={model.name}>
        {model.name}
      </div>
      <button role="menuitem" onClick={() => navigate(`/images/${model.id}`)}>
        Open
      </button>
      <a role="menuitem" className="ctx-link" href={`/api/v2/images/${model.id}/download`} download onClick={() => window.setTimeout(onClose, 50)} title={packed ? "Slides with a folder are packed into a ZIP file first; the download starts when it is ready" : "Download the original file"}>
        Download{packed ? " (ZIP)" : ""}
      </a>
      {onConvert && (
        <button role="menuitem" onClick={onConvert} title="This file is a 3D Slicer segmentation, not an image">
          Convert to segmentation file…
        </button>
      )}
      <button role="menuitem" onClick={onMove} disabled={!model.canMove} title={model.canMove ? "Move to another image set" : model.moveWhy}>
        {model.moveCount > 1 ? `Move ${model.moveCount} selected images…` : "Move…"}
      </button>
      <button role="menuitem" aria-expanded={open} onClick={() => setOpen((o) => !o)} disabled={related.isSuccess && links.length === 0}>
        <span>
          Related images{related.isLoading ? "" : ` (${links.length})`}
        </span>
        <span className="caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="ctx-sub">
          {related.isLoading && <div className="muted small">Loading…</div>}
          {links.map((r) => (
            <button key={`${r.kind}-${r.id}`} role="menuitem" className="ctx-related" onClick={() => navigate(r.kind === "segmentation" ? `/images/${r.id}/planes?seg=${r.file}` : `/images/${r.id}`)} title={`${KIND[r.kind]}: ${r.name} (${r.set_name})`}>
              <span className="muted small">{KIND[r.kind]}</span>
              <span className="ctx-related-name">{r.name}</span>
              <span className="muted small">{r.set_name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Handlers that open a menu on right click and on a long press with a finger (a press that moves is a scroll or a pan).
 * The click that follows a long press is swallowed, so that it does not open the image under the menu.
 */
export function useMenuTrigger(open: (x: number, y: number) => void) {
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  const firedUntil = useRef(0);
  const stop = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  useEffect(() => stop, []);
  return {
    onContextMenu: (e: ReactMouseEvent) => {
      e.preventDefault();
      if (performance.now() < firedUntil.current) return; // the long press has opened it already
      open(e.clientX, e.clientY);
    },
    onPointerDown: (e: ReactPointerEvent) => {
      stop();
      if (e.pointerType !== "touch") return;
      const [x, y] = [e.clientX, e.clientY];
      press.current = {
        x,
        y,
        timer: window.setTimeout(() => {
          press.current = null;
          firedUntil.current = performance.now() + 800;
          open(x, y);
        }, 550),
      };
    },
    onPointerMove: (e: ReactPointerEvent) => {
      if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 10) stop();
    },
    onPointerUp: stop,
    onPointerCancel: stop,
    onClickCapture: (e: ReactMouseEvent) => {
      if (performance.now() < firedUntil.current) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
  };
}
