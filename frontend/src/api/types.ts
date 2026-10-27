export interface User {
  id: number;
  username: string;
  is_staff: boolean;
  is_superuser: boolean;
}

export interface Team {
  id: number;
  name: string;
}

export interface ImageSet {
  id: number;
  name: string;
  description: string;
  team: number;
  images: number[];
  path: string;
}

export interface ImageSummary {
  id: number;
  name: string;
  width: number;
  height: number;
  frames: number;
  depth: number;
  image_set: number;
}

export interface AnnotationType {
  id: number;
  name: string;
  vector_type: number;
  color_code: string;
  closed: boolean;
}

export type Vector = Record<string, number | undefined>;

export interface Annotation {
  id: number;
  annotation_type: number;
  vector: Vector | null;
  image: number;
}
