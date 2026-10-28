/**
 * Geometry of the three-plane view of a volume. The server renders every plane at its physical aspect, so a slice is shown
 * as `dims[plane]` pixels while the volume has `n` voxels along each axis; these functions convert between a point of a
 * plane's image and a voxel, as the renderer lays them out (crates/exact-wsi/src/nifti.rs `render`):
 *
 *   axial (0)    pixel (c, r) of slice z:  voxel (nx-1-c, ny-1-r, z)      frames: nz
 *   coronal (1)  pixel (c, r) of slice y:  voxel (nx-1-c, y, nz-1-r)      frames: ny
 *   sagittal (2) pixel (c, r) of slice x:  voxel (x, c, nz-1-r)           frames: nx
 */
export type Plane = 0 | 1 | 2;

export interface Voxel {
  x: number;
  y: number;
  z: number;
}

export interface VolumeShape {
  /** voxels along x, y, z (after reorientation) */
  nx: number;
  ny: number;
  nz: number;
  /** displayed size in pixels of the image of each plane (axial, coronal, sagittal) */
  dims: [[number, number], [number, number], [number, number]];
}

export const PLANE_NAMES = ["Axial", "Coronal", "Sagittal"] as const;

/** Frames of each plane: axial runs along z, coronal along y, sagittal along x. */
export function shapeOf(planes: { frames: number; width: number; height: number }[]): VolumeShape | null {
  if (planes.length < 3) return null;
  const [a, c, s] = planes;
  return { nx: s.frames, ny: c.frames, nz: a.frames, dims: [[a.width, a.height], [c.width, c.height], [s.width, s.height]] };
}

const clamp = (v: number, n: number) => Math.min(Math.max(Math.floor(v), 0), n - 1);

/** The slice of `plane` that contains the voxel. */
export function frameOf(plane: Plane, v: Voxel): number {
  return plane === 0 ? v.z : plane === 1 ? v.y : v.x;
}

/** The point (image pixels of the plane's slice) where the voxel's centre lies. */
export function pixelOf(s: VolumeShape, plane: Plane, v: Voxel): [number, number] {
  const [w, h] = s.dims[plane];
  if (plane === 0) return [((s.nx - 1 - v.x + 0.5) / s.nx) * w, ((s.ny - 1 - v.y + 0.5) / s.ny) * h];
  if (plane === 1) return [((s.nx - 1 - v.x + 0.5) / s.nx) * w, ((s.nz - 1 - v.z + 0.5) / s.nz) * h];
  return [((v.y + 0.5) / s.ny) * w, ((s.nz - 1 - v.z + 0.5) / s.nz) * h];
}

/** The voxel under a point of the plane's image, in slice `frame`. */
export function voxelAt(s: VolumeShape, plane: Plane, px: number, py: number, frame: number): Voxel {
  const [w, h] = s.dims[plane];
  if (plane === 0) return { x: s.nx - 1 - clamp((px / w) * s.nx, s.nx), y: s.ny - 1 - clamp((py / h) * s.ny, s.ny), z: clamp(frame, s.nz) };
  if (plane === 1) return { x: s.nx - 1 - clamp((px / w) * s.nx, s.nx), y: clamp(frame, s.ny), z: s.nz - 1 - clamp((py / h) * s.nz, s.nz) };
  return { x: clamp(frame, s.nx), y: clamp((px / w) * s.ny, s.ny), z: s.nz - 1 - clamp((py / h) * s.nz, s.nz) };
}

/** The voxel moved by `delta` slices along the axis a plane steps through. */
export function stepped(s: VolumeShape, plane: Plane, v: Voxel, delta: number): Voxel {
  if (plane === 0) return { ...v, z: clamp(v.z + delta, s.nz) };
  if (plane === 1) return { ...v, y: clamp(v.y + delta, s.ny) };
  return { ...v, x: clamp(v.x + delta, s.nx) };
}

/** The voxel in the middle of the volume. */
export const centreOf = (s: VolumeShape): Voxel => ({ x: Math.floor(s.nx / 2), y: Math.floor(s.ny / 2), z: Math.floor(s.nz / 2) });

/** The two lines of a plane's crosshair: the planes they stand for (a vertical and a horizontal line of the image). */
export const CROSS_PLANES: Record<Plane, { vertical: Plane; horizontal: Plane }> = {
  0: { vertical: 2, horizontal: 1 }, // in the axial image a vertical line is a sagittal plane, a horizontal one a coronal plane
  1: { vertical: 2, horizontal: 0 },
  2: { vertical: 1, horizontal: 0 },
};

/** Colours that tell the planes apart (borders, crosshair lines). */
export const PLANE_COLORS: Record<Plane, string> = { 0: "#ff5a5a", 1: "#4cd37a", 2: "#5aa0ff" };
