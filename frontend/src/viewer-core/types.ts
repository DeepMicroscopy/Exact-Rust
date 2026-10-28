export const VectorType = {
  BoundingBox: 1,
  Point: 2,
  Line: 3,
  MultiLine: 4,
  Polygon: 5,
  FixedSizeBoundingBox: 6,
  Global: 7,
  Segmentation: 8,
} as const;

export interface Shape {
  id: number;
  typeId: number;
  vectorType: number;
  closed: boolean;
  /** the signed-in user verified it (drawn solid; others dashed) */
  verified?: boolean;
  /** vertex list in image pixels */
  points: [number, number][];
  /** bounding box in image pixels for culling */
  bbox: [number, number, number, number];
}

export interface TypeStyle {
  color: string;
  vectorType: number;
  closed: boolean;
}
