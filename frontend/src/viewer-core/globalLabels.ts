import type { Vector } from "../api/types";
import { type FramedVector, visibleOnFrame } from "./frames";

/** What the viewer needs to know of an annotation to tell whether a global label is set. */
export interface LabelHolder {
  id: number;
  annotation_type: number;
  vector: FramedVector;
  deleted?: boolean;
}

/**
 * The annotation that sets the global label `typeId` on this frame (counted from 1): one of that frame, or one without a frame
 * (those hold for the whole image), or any of a multi frame type.
 */
export function labelOn(list: readonly LabelHolder[], typeId: number, frame: number, multiFrame = false): LabelHolder | undefined {
  return list.find((a) => a.annotation_type === typeId && !a.deleted && visibleOnFrame(a.vector, multiFrame, frame));
}

/**
 * The vector of a new label. A global annotation has no coordinates, but on an image with frames (stack, volume, movie) it names the
 * frame it is set on, like every annotation drawn there (the server stores it as `{"frame": n}`); `null` on a single image.
 */
export function labelVector(framed: boolean): Vector | null {
  return framed ? {} : null;
}
