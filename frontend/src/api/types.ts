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
  mpp?: number;
}

export interface AnnotationType {
  id: number;
  name: string;
  vector_type: number;
  color_code: string;
  closed: boolean;
  node_count?: number;
  default_width?: number;
  default_height?: number;
  size_unit?: string;
  sort_order?: number;
  product?: number | null;
}

export type Vector = Record<string, number | undefined>;

export interface Annotation {
  id: number;
  annotation_type: number;
  vector: Vector | null;
  image: number;
  last_edit_time?: string;
  /** whether the signed-in user verified it */
  verified_by_user?: boolean;
  deleted?: boolean;
  unique_identifier?: string;
}
