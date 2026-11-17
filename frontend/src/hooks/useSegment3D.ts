import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import type { Extent } from "../viewer-core/mpr3d";

/** What the server says about a mask (`GET /api/v2/segmentation/{id}/volume` and the answer of every operation). */
export interface MaskState {
  annotation: number;
  count: number;
  volume_mm3: number;
  extent_mm: Extent;
  voxel_mm: [number, number, number];
  slices: number[];
  bbox: number[] | null;
  can_undo: boolean;
  can_redo: boolean;
  note?: string;
  changed?: boolean;
  /** masks of the same group that lost (or got back) voxels through this step */
  changed_others?: number[];
}

export type Op =
  | { op: "stroke"; plane: number; frame: number; points: [number, number][]; radius_mm: number; ball: boolean; mode: "add" | "remove" }
  | { op: "lasso"; plane: number; frame: number; points: [number, number][]; mode: "add" | "remove" }
  | { op: "wand"; plane: number; frame: number; point: [number, number]; tolerance: number; volume: boolean; max_radius_mm?: number; mode: "add" | "remove" }
  | { op: "interpolate" }
  | { op: "copy"; from: number; to: number; through: number; add: boolean }
  | { op: "grow" | "shrink"; steps: number }
  | { op: "fill_holes" | "keep_largest" | "clear" };

export interface Message {
  kind: "error" | "note";
  text: string;
}

/**
 * The mask of one annotation in the three-plane view: its state, and the operations on it. Operations run one after the other
 * (a stroke drawn while the one before is still being stored waits for it), `version` counts the changes so that the plane
 * overlays know when to load their slice again.
 */
export function useSegment3D(annotationId: number | null, onOthers?: (annotations: number[]) => void) {
  const othersRef = useRef(onOthers);
  othersRef.current = onOthers;
  const [state, setState] = useState<MaskState | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(0);
  const [message, setMessage] = useState<Message | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const current = useRef(annotationId);
  current.current = annotationId;

  useEffect(() => {
    setState(null);
    setMessage(null);
    setVersion((v) => v + 1);
    if (annotationId == null) return;
    let live = true;
    api<MaskState>(`/api/v2/segmentation/${annotationId}/volume`)
      .then((s) => live && setState(s))
      .catch((e) => live && setMessage({ kind: "error", text: e instanceof ApiError ? e.detail : String(e) }));
    return () => {
      live = false;
    };
  }, [annotationId]);

  const send = useCallback((path: string, body?: Op): Promise<MaskState | null> => {
    const id = current.current;
    if (id == null) return Promise.resolve(null);
    setBusy((b) => b + 1);
    const run = async (): Promise<MaskState | null> => {
      try {
        const s = await api<MaskState>(`/api/v2/segmentation/${id}/${path}`, body ? { json: body } : { method: "POST" });
        if (current.current === id) {
          setState(s);
          if (s.changed !== false) setVersion((v) => v + 1);
          if (s.changed_others?.length) othersRef.current?.(s.changed_others);
          setMessage(s.note ? { kind: "note", text: s.note } : null);
        }
        return s;
      } catch (e) {
        const text = e instanceof ApiError ? (e.status === 403 ? "You may not change masks in this image set." : e.status === 409 ? "Nothing to undo or redo." : e.detail) : String(e);
        if (current.current === id) setMessage({ kind: "error", text });
        setVersion((v) => v + 1); // what is shown may differ from what is stored now
        return null;
      } finally {
        setBusy((b) => b - 1);
      }
    };
    const next = queue.current.then(run, run);
    queue.current = next;
    return next;
  }, []);

  return {
    state,
    version,
    busy: busy > 0,
    message,
    dismiss: useCallback(() => setMessage(null), []),
    op: useCallback((o: Op) => send("ops", o), [send]),
    /** the mask was changed elsewhere (an automatic segmentation finished): read its state again and redraw */
    reload: useCallback(async () => {
      const id = current.current;
      if (id == null) return;
      try {
        const s = await api<MaskState>(`/api/v2/segmentation/${id}/volume`);
        if (current.current === id) {
          setState(s);
          setVersion((v) => v + 1);
        }
      } catch (e) {
        if (current.current === id) setMessage({ kind: "error", text: e instanceof ApiError ? e.detail : String(e) });
      }
    }, []),
    undo: useCallback(() => send("undo"), [send]),
    redo: useCallback(() => send("redo"), [send]),
  };
}
