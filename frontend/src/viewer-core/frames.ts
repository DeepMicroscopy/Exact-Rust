/**
 * Which annotations belong to which frame. As in the old EXACT an annotation of a stack, volume or movie carries the frame
 * it was drawn on in its vector (`frame`, counted from 1) and is shown on that frame only, unless its type is *multi frame*
 * (then on every frame). An annotation without a frame (drawn before frames were recorded, or on a single image) is shown
 * everywhere, so nothing disappears.
 */
export type FramedVector = { frame?: number | null } | null | undefined;

export function visibleOnFrame(vector: FramedVector, multiFrameType: boolean, frame: number): boolean {
  if (multiFrameType) return true;
  const f = vector?.frame;
  return f == null || f === frame;
}

/** The vector with the frame it is drawn on (none for images without frames). */
export function withFrame<V extends Record<string, number | undefined>>(vector: V, frame: number | null | undefined): V {
  return frame == null ? vector : { ...vector, frame };
}

/** The new vector of an edited annotation keeps the frame the old one had (the editor only knows the geometry). */
export function keepFrame<V extends Record<string, number | undefined>>(next: V, old: FramedVector): V {
  const f = old?.frame;
  return f == null || next.frame != null ? next : { ...next, frame: f };
}
