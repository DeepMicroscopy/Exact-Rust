import { api } from "./client";
import type { Annotation, Vector } from "./types";

/** Fields the viewer needs of an annotation (the v2 list and the write endpoints return the same shape). */
export const ANNOTATION_FIELDS = "id,annotation_type,vector,image,last_edit_time,verified_by_user,deleted,unique_identifier";

export const createAnnotation = (body: { image: number; annotation_type: number; vector: Vector | null; unique_identifier?: string }) =>
  api<Annotation>("/api/v2/annotations", { json: body });

/** Partial update; `expected_last_edit_time` makes it conditional (409 with the current state when somebody else edited). */
export const patchAnnotation = (id: number, body: { vector?: Vector | null; annotation_type?: number; deleted?: boolean; description?: string; expected_last_edit_time?: string }) =>
  api<Annotation>(`/api/v2/annotations/${id}`, { method: "PATCH", json: body });

export const deleteAnnotation = (id: number) => api<void>(`/api/v2/annotations/${id}`, { method: "DELETE" });

export const verifyAnnotation = (id: number, verified: boolean) => api<Annotation>(`/api/v2/annotations/${id}/verify`, { json: { verified } });
