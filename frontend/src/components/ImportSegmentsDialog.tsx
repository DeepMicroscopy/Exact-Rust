import { useMemo, useState } from "react";
import { api, ApiError } from "../api/client";
import { createAnnotation } from "../api/annotations";
import type { Annotation, AnnotationType, Product } from "../api/types";
import { VectorType } from "../viewer-core/types";
import { Modal } from "./Modal";
import { volumeText, type LinkedFile } from "./LinkSegmentationDialog";

const norm = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const msg = (e: unknown) => (e instanceof ApiError ? e.detail : e instanceof Error ? e.message : String(e));

type Pick = number | "new" | "";
interface Row {
  include: boolean;
  type: Pick;
}
type Status = { state: "wait" | "work" | "ok" | "bad"; text?: string };

/**
 * Step two of a linked segmentation file: its segments become mask annotations of the volume (ordinary annotations from then on:
 * editable, counted, exported). Every segment goes to a segmentation type of the image set (the one with its name, else a new type
 * in a product of the set, in the colour of the segment), and the mask replaces what the type's mask holds, or is added to it.
 * Two segments sent to the same type are united.
 */
export function ImportSegmentsDialog({
  imageId,
  file,
  size,
  segTypes,
  products,
  annotations,
  onClose,
  onDone,
}: {
  imageId: number;
  file: LinkedFile;
  /** the axial picture of the volume (the mask grid) */
  size: { width: number; height: number };
  /** the segmentation types the image set offers */
  segTypes: AnnotationType[];
  /** the products of the image set (new types are made in one of them) */
  products: Product[];
  annotations: Annotation[];
  onClose(): void;
  /** every import is done (or failed): look at the first type that received a mask */
  onDone(firstTypeId: number | null): void;
}) {
  const present = file.segments.filter((g) => g.voxels > 0);
  const [rows, setRows] = useState<Record<number, Row>>(() =>
    Object.fromEntries(
      present.map((g) => {
        const t = segTypes.find((s) => norm(s.name) === norm(g.name));
        return [g.index, { include: true, type: (t ? t.id : products.length ? "new" : "") as Pick }];
      }),
    ),
  );
  const [product, setProduct] = useState<number | null>(products[0]?.id ?? null);
  const [mode, setMode] = useState<"replace" | "add">("replace");
  const [status, setStatus] = useState<Record<number, Status>>({});
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const chosen = useMemo(() => present.filter((g) => rows[g.index]?.include && rows[g.index].type !== ""), [present, rows]);
  const needsNew = chosen.some((g) => rows[g.index].type === "new");
  const set = (i: number, p: Partial<Row>) => setRows((r) => ({ ...r, [i]: { ...r[i], ...p } }));

  const run = async () => {
    setRunning(true);
    const made = new Map<string, number>(); // new types by name, so that two segments of one name share the type
    const touched = new Set<number>(); // types that received a mask in this run: later segments are added to it
    let first: number | null = null;
    const existing = new Map<number, number>();
    for (const a of annotations) if (!a.deleted && a.id > 0 && !existing.has(a.annotation_type)) existing.set(a.annotation_type, a.id);
    for (const g of chosen) {
      setStatus((s) => ({ ...s, [g.index]: { state: "work" } }));
      try {
        const pick = rows[g.index].type;
        let typeId: number;
        if (pick === "new") {
          const key = norm(g.name);
          let id = made.get(key);
          if (id == null) {
            const t = await api<AnnotationType>("/api/v2/annotation-types", {
              json: { name: g.name, active: true, vector_type: VectorType.Segmentation, node_count: 0, color_code: g.color, sort_order: 0, enable_blurred: false, enable_concealed: false, multi_frame: false, default_width: 50, default_height: 50, size_unit: "px", closed: true, area_hit_test: true, product },
            });
            id = t.id;
            made.set(key, id);
          }
          typeId = id;
        } else typeId = pick as number;
        let annotation = existing.get(typeId);
        if (annotation == null) {
          const a = await createAnnotation({ image: imageId, annotation_type: typeId, vector: { tile_size: 256, width: size.width, height: size.height }, unique_identifier: crypto.randomUUID() });
          annotation = a.id;
          existing.set(typeId, annotation);
        }
        await api(`/api/v2/linked-volumes/${file.id}/import`, { json: { segment: g.index, annotation, mode: touched.has(typeId) ? "add" : mode } });
        touched.add(typeId);
        first ??= typeId;
        setStatus((s) => ({ ...s, [g.index]: { state: "ok" } }));
      } catch (e) {
        setStatus((s) => ({ ...s, [g.index]: { state: "bad", text: msg(e) } }));
      }
    }
    setRunning(false);
    setFinished(true);
    onDone(first);
  };

  return (
    <Modal title="Import as annotations" onClose={running ? () => undefined : onClose} wide>
      <div className="import-seg" data-testid="import-seg">
        <p className="muted small">
          Each segment of <strong>{file.name}</strong> becomes the mask of a segmentation type of this image. The file stays linked and unchanged.
        </p>
        <table className="admin-table">
          <thead>
            <tr>
              <th />
              <th>Segment</th>
              <th>Volume</th>
              <th>Segmentation type</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {present.map((g) => {
              const r = rows[g.index];
              const st = status[g.index];
              return (
                <tr key={g.index} data-testid="import-row">
                  <td>
                    <input type="checkbox" checked={r.include} disabled={running || finished} onChange={(e) => set(g.index, { include: e.target.checked })} aria-label={`Import ${g.name}`} />
                  </td>
                  <td>
                    <span className="seg-swatch" style={{ background: g.color }} aria-hidden="true" /> {g.name}
                  </td>
                  <td className="muted small">{volumeText(g.volume_mm3)}</td>
                  <td>
                    <select value={String(r.type)} disabled={running || finished || !r.include} onChange={(e) => set(g.index, { type: e.target.value === "new" ? "new" : e.target.value === "" ? "" : Number(e.target.value) })} aria-label={`Type for ${g.name}`}>
                      <option value="">Choose a type…</option>
                      {products.length > 0 && <option value="new">New type “{g.name}”</option>}
                      {segTypes.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="small">
                    {st?.state === "work" && <span className="spinner" role="status" aria-label="Importing" />}
                    {st?.state === "ok" && <span className="ok">✓ imported</span>}
                    {st?.state === "bad" && <span className="error">{st.text}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {needsNew && products.length > 1 && (
          <label className="field">
            <span>New types go into the product</span>
            <select value={product ?? ""} disabled={running || finished} onChange={(e) => setProduct(Number(e.target.value))}>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {segTypes.length === 0 && products.length === 0 && <p className="error small">This image set has no product, so there is no segmentation type to import into.</p>}
        <fieldset className="seg-choice">
          <legend>If the type already has a mask in this image</legend>
          <label>
            <input type="radio" name="mode" checked={mode === "replace"} disabled={running || finished} onChange={() => setMode("replace")} /> Replace it
          </label>
          <label>
            <input type="radio" name="mode" checked={mode === "add"} disabled={running || finished} onChange={() => setMode("add")} /> Add to it
          </label>
        </fieldset>
        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={running}>
            {finished ? "Close" : "Cancel"}
          </button>
          {!finished && (
            <button className="btn primary" onClick={() => void run()} disabled={running || chosen.length === 0} data-testid="import-go">
              Import {chosen.length} segment{chosen.length === 1 ? "" : "s"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
