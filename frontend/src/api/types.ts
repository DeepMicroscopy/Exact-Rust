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
  /** set for crops: the image they were cut from and the position (and frame) of the crop in it */
  crop_source?: number | null;
  crop_x?: number | null;
  crop_y?: number | null;
  crop_frame?: number | null;
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
  deleted?: boolean;
  unique_identifier?: string;
}
