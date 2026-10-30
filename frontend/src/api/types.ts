export interface User {
  id: number;
  username: string;
  is_staff: boolean;
  is_superuser: boolean;
  /** may look, not change: the server refuses every write */
  read_only?: boolean;
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
  /** the annotations of this type are shown on every frame of a stack, not only on the frame they were drawn on */
  multi_frame?: boolean;
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

export interface SetSettings {
  id: number;
  name: string;
  description: string | null;
  location: string | null;
  public: boolean;
  public_collaboration: boolean;
  image_lock: boolean;
  priority: number;
  collaboration_type: number;
  main_annotation_type: number | null;
  team: number | null;
  team_name: string | null;
  time: string;
  creator: number | null;
  image_count: number;
  auxiliary_file_count: number;
  permissions: { read: boolean; annotate: boolean; edit_set: boolean; delete_set: boolean; delete_images: boolean; create_export: boolean };
}

export interface SetImage {
  id: number;
  name: string;
  width: number;
  height: number;
  mpp: number;
  frames: number;
  image_set: number;
  time: string;
  crop_source: number | null;
}

export interface Product {
  id: number;
  name: string;
  team: number | null;
}

export interface Tag {
  id: number;
  name: string;
}

export interface Registration {
  id: number;
  source_image: number;
  target_image: number;
  registration_error: number;
  runtime: number;
  rotation_angle: number | null;
  get_scale: [number, number] | null;
  transformation_matrix: Record<string, number> | null;
}

export interface RegistrationJob {
  id: number;
  source_image: number;
  target_image: number;
  params: Record<string, unknown>;
  status: "queued" | "running" | "done" | "failed";
  error: string | null;
  worker: string | null;
  registration: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}
