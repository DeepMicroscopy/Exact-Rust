import { describe, expect, it } from "vitest";
import { labelOn, labelVector } from "./globalLabels";

const a = (id: number, type: number, vector: { frame?: number } | null, deleted = false) => ({ id, annotation_type: type, vector, deleted });

describe("global labels", () => {
  it("is set by an annotation of its type, not by a deleted one or one of another type", () => {
    expect(labelOn([a(1, 7, null)], 7, 1)?.id).toBe(1);
    expect(labelOn([a(1, 7, null, true)], 7, 1)).toBeUndefined();
    expect(labelOn([a(1, 8, null)], 7, 1)).toBeUndefined();
  });
  it("holds on the frame it names only", () => {
    expect(labelOn([a(1, 7, { frame: 3 })], 7, 3)?.id).toBe(1);
    expect(labelOn([a(1, 7, { frame: 3 })], 7, 4)).toBeUndefined();
  });
  it("holds on every frame without a frame, and on every frame for a multi frame type", () => {
    expect(labelOn([a(1, 7, {})], 7, 9)?.id).toBe(1);
    expect(labelOn([a(1, 7, { frame: 3 })], 7, 9, true)?.id).toBe(1);
  });
  it("finds the label of the frame among the labels of others", () => {
    expect(labelOn([a(1, 7, { frame: 2 }), a(2, 7, { frame: 3 })], 7, 3)?.id).toBe(2);
  });
  it("is created with a frame on images with frames only", () => {
    expect(labelVector(false)).toBeNull();
    expect(labelVector(true)).toEqual({});
  });
});
