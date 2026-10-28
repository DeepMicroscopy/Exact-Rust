import { describe, expect, it } from "vitest";
import { CROSS_PLANES, centreOf, frameOf, pixelOf, shapeOf, stepped, voxelAt, type Plane } from "./mpr";

// 4 x 6 x 8 voxels; the images are shown at twice the voxel size along x (physical aspect) and as they are otherwise
const shape = shapeOf([
  { frames: 8, width: 8, height: 6 }, // axial: nx*2 x ny
  { frames: 6, width: 8, height: 8 }, // coronal: nx*2 x nz
  { frames: 4, width: 6, height: 8 }, // sagittal: ny x nz
])!;

describe("mpr geometry", () => {
  it("reads the voxel counts from the frames of the planes", () => {
    expect([shape.nx, shape.ny, shape.nz]).toEqual([4, 6, 8]);
  });
  it("maps a point of a plane to the voxel under it, as the renderer lays out the slice", () => {
    // axial: the left of the image is the right side of the volume (x counts from the right)
    expect(voxelAt(shape, 0, 0.5, 0.5, 3)).toEqual({ x: 3, y: 5, z: 3 });
    expect(voxelAt(shape, 0, 7.9, 5.9, 3)).toEqual({ x: 0, y: 0, z: 3 });
    // coronal: the top of the image is the top (high z) of the volume
    expect(voxelAt(shape, 1, 0.5, 0.5, 2)).toEqual({ x: 3, y: 2, z: 7 });
    // sagittal: the left of the image is the front (y = 0)
    expect(voxelAt(shape, 2, 0.5, 0.5, 1)).toEqual({ x: 1, y: 0, z: 7 });
  });
  it("returns the point of the voxel's centre, and the two are inverse to each other", () => {
    for (const plane of [0, 1, 2] as Plane[]) {
      for (const v of [{ x: 0, y: 0, z: 0 }, { x: 3, y: 5, z: 7 }, { x: 2, y: 1, z: 4 }]) {
        const [px, py] = pixelOf(shape, plane, v);
        expect(voxelAt(shape, plane, px, py, frameOf(plane, v))).toEqual(v);
      }
    }
  });
  it("keeps the other planes' slices when a click is in one plane", () => {
    const click = voxelAt(shape, 0, 4, 3, 5);
    expect(click.z).toBe(5);
    // the coronal slice shows the click's y, the sagittal slice its x
    expect(frameOf(1, click)).toBe(click.y);
    expect(frameOf(2, click)).toBe(click.x);
  });
  it("steps through the slices of a plane without leaving the volume", () => {
    expect(stepped(shape, 0, { x: 1, y: 1, z: 7 }, 1).z).toBe(7);
    expect(stepped(shape, 1, { x: 1, y: 0, z: 1 }, -1).y).toBe(0);
    expect(stepped(shape, 2, { x: 1, y: 1, z: 1 }, 2).x).toBe(3);
    expect(centreOf(shape)).toEqual({ x: 2, y: 3, z: 4 });
  });
  it("tells which plane a crosshair line stands for", () => {
    expect(CROSS_PLANES[0]).toEqual({ vertical: 2, horizontal: 1 });
    expect(CROSS_PLANES[1].horizontal).toBe(0);
    expect(CROSS_PLANES[2].vertical).toBe(1);
  });
});
