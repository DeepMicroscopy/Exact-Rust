import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import { formatArea, formatLength, measureShape } from "../viewer-core/measure";
import type { Shape } from "../viewer-core/types";
import { VectorType } from "../viewer-core/types";
import { Modal } from "./Modal";

interface UserRef {
  id: number;
  username: string;
}

interface Detail {
  id: number;
  time: string;
  last_edit_time: string;
  description: string;
  unique_identifier: string;
  deleted: boolean;
  user: UserRef | number | null;
  last_editor: UserRef | number | null;
  annotation_type: number;
}

interface Verification {
  id: number;
  time: string;
  verified: boolean;
  user: UserRef | number | null;
}

const KINDS: Record<number, string> = {
  [VectorType.BoundingBox]: "Bounding box",
  [VectorType.Point]: "Point",
  [VectorType.Line]: "Line",
  [VectorType.MultiLine]: "Polyline",
  [VectorType.Polygon]: "Polygon",
  [VectorType.FixedSizeBoundingBox]: "Fixed-size box",
  [VectorType.Global]: "Label of the whole image",
  [VectorType.Segmentation]: "Segmentation",
};

const who = (u: UserRef | number | null) => (u == null ? "unknown (e.g. a plugin)" : typeof u === "number" ? `user ${u}` : u.username);
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "–");

/** Who made an annotation, when, how big it is, who verified it. */
export function AnnotationInfo({ shape, typeName, typeColor, mpp, onClose }: { shape: Shape; typeName: string; typeColor?: string; mpp: number; onClose(): void }) {
  const detail = useQuery({ queryKey: ["annotation-info", shape.id], queryFn: () => api<Detail>(`/api/v2/annotations/${shape.id}?expand=user,last_editor`) });
  const verifications = useQuery({
    queryKey: ["annotation-verifications", shape.id],
    queryFn: () => api<{ items: Verification[] }>(`/api/v2/verifications?annotation=${shape.id}&expand=user&limit=200`),
  });
  const m = measureShape(shape);
  const [x1, y1, x2, y2] = shape.bbox.map(Math.round);
  const d = detail.data;
  const yes = (verifications.data?.items ?? []).filter((v) => v.verified);
  return (
    <Modal title="Annotation info" onClose={onClose}>
      <dl className="info">
        <dt>Type</dt>
        <dd>
          <span className="swatch" style={{ background: typeColor }} /> {typeName} <span className="muted">· {KINDS[shape.vectorType] ?? "shape"}</span>
        </dd>
        {m.areaPx2 != null && (
          <>
            <dt>Area</dt>
            <dd>
              {formatArea(m.areaPx2, mpp)} <span className="muted">· {Math.round(m.width)} × {Math.round(m.height)} px, {Math.round(m.areaPx2).toLocaleString("en-US")} px²</span>
            </dd>
          </>
        )}
        {m.lengthPx != null && (
          <>
            <dt>Length</dt>
            <dd>{formatLength(m.lengthPx, mpp)}</dd>
          </>
        )}
        <dt>Position</dt>
        <dd>
          ({x1}, {y1}) – ({x2}, {y2}) px
        </dd>
        <dt>Created by</dt>
        <dd>{detail.isLoading ? "…" : who(d?.user ?? null)}</dd>
        <dt>Created</dt>
        <dd>{detail.isLoading ? "…" : when(d?.time)}</dd>
        <dt>Last edited by</dt>
        <dd>{detail.isLoading ? "…" : who(d?.last_editor ?? null)}</dd>
        <dt>Last edited</dt>
        <dd>{detail.isLoading ? "…" : when(d?.last_edit_time)}</dd>
        <dt>Verified by</dt>
        <dd>{verifications.isLoading ? "…" : yes.length === 0 ? <span className="muted">nobody yet</span> : yes.map((v) => `${who(v.user)} (${when(v.time)})`).join(", ")}</dd>
        {d?.description ? (
          <>
            <dt>Description</dt>
            <dd>{d.description}</dd>
          </>
        ) : null}
        <dt>ID</dt>
        <dd>
          {shape.id} <span className="muted small">· {d?.unique_identifier}</span>
        </dd>
      </dl>
      {detail.error && <p className="error">Could not load the details: {String(detail.error)}</p>}
    </Modal>
  );
}
