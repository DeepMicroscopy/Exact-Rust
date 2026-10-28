import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError, listAll } from "../api/client";
import type { AnnotationType, Team } from "../api/types";
import { Modal } from "./Modal";

interface FormatDoc {
  id?: number;
  name: string;
  team: number;
  public: boolean;
  image_aggregation: boolean;
  include_blurred: boolean;
  include_concealed: boolean;
  base_format: string;
  image_format: string | null;
  annotation_format: string;
  vector_format: string;
  not_in_image_format: string;
  name_format: string;
  annotation_types: number[];
}

const DEFAULTS: Omit<FormatDoc, "team"> = {
  name: "",
  public: false,
  image_aggregation: false,
  include_blurred: true,
  include_concealed: true,
  base_format: "%%content",
  image_format: "",
  annotation_format: "%%imagename|%%type|{%%vector}|",
  vector_format: '"x%%count1": %%x,"y%%count1": %%y,',
  not_in_image_format: "image name|annotation type|not in image",
  name_format: "export_%%exportid.txt",
  annotation_types: [],
};

const HELP: [string, string][] = [
  ["Annotation", "%%imagename %%imagewidth %%imageheight %%imageset %%type %%vector %%frame %%UUID %%meta_data %%deleted %%first_editor %%first_timepoint %%last_editor %%last_timepoint"],
  ["Geometry (pixels)", "%%minx %%maxx %%miny %%maxy %%width %%height %%cx %%cy %%rad %%dia"],
  ["Geometry (relative to the image)", "%%relminx %%relmaxx %%relminy %%relmaxy %%relwidth %%relheight %%relcx %%relcy %%relrad %%reldia"],
  ["Vector (once per point)", "%%count0 %%count1 %%x %%y %%relx %%rely %%br"],
  ["Conditions", "%%ifblurred … %%endif, %%ifnotblurred … %%endif, %%ifconcealed … %%endif, %%ifnotconcealed … %%endif"],
  ["Image (per image)", "%%annotations %%annoamount %%imagename %%imagewidth %%imageheight %%frame"],
  ["Whole file", "%%content %%view %%imageset %%team %%setdescription %%setlocation"],
  ["File name", "%%exportid %%imageset %%team %%setlocation"],
];

/** Creates or changes an export format: which annotation types, and the text templates that write them. */
export function ExportFormatEditor({ formatId, onClose, onSaved }: { formatId: number | null; onClose(): void; onSaved(id: number): void }) {
  const teams = useQuery({ queryKey: ["teams"], queryFn: () => listAll<Team>("/api/v2/teams", { fields: "id,name" }) });
  const types = useQuery({ queryKey: ["annotation-types-names"], queryFn: () => listAll<AnnotationType>("/api/v2/annotation-types", { fields: "id,name,product" }) });
  const [doc, setDoc] = useState<FormatDoc | null>(null);
  const loaded = useQuery({
    queryKey: ["export-format", formatId],
    enabled: formatId != null,
    staleTime: 0,
    queryFn: () => api<FormatDoc>(`/api/v2/export-formats/${formatId}`),
  });
  const value: FormatDoc | null = doc ?? (formatId != null ? (loaded.data ?? null) : teams.data ? { ...DEFAULTS, team: teams.data[0]?.id ?? 0 } : null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  const set = <K extends keyof FormatDoc>(k: K, v: FormatDoc[K]) => value && setDoc({ ...value, [k]: v });
  const save = async () => {
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const body = { ...value, image_format: value.image_aggregation ? (value.image_format ?? "") : value.image_format || null };
      const r = formatId == null ? await api<{ id: number }>("/api/v2/export-formats", { json: body }) : await api<{ id: number }>(`/api/v2/export-formats/${formatId}`, { method: "PATCH", json: body });
      onSaved(r.id);
      onClose();
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const toggleType = (id: number) => value && set("annotation_types", value.annotation_types.includes(id) ? value.annotation_types.filter((t) => t !== id) : [...value.annotation_types, id]);
  const area = (k: "base_format" | "annotation_format" | "vector_format" | "not_in_image_format" | "name_format", label: string, rows = 2) =>
    value && (
      <label className="field">
        <span>{label}</span>
        <textarea className="mono" rows={rows} value={value[k]} onChange={(e) => set(k, e.target.value)} spellCheck={false} aria-label={label} />
      </label>
    );
  return (
    <Modal title={formatId == null ? "New export format" : "Edit export format"} onClose={onClose} wide>
      {!value && <p className="muted">Loading…</p>}
      {value && (
        <>
          <div className="row2">
            <label className="field">
              <span>Name (at most 20 characters)</span>
              <input value={value.name} maxLength={20} onChange={(e) => set("name", e.target.value)} aria-label="Format name" />
            </label>
            <label className="field">
              <span>Team</span>
              <select value={value.team} onChange={(e) => set("team", Number(e.target.value))} aria-label="Format team">
                {(teams.data ?? []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="checks">
            <label className="check">
              <input type="checkbox" checked={value.public} onChange={(e) => set("public", e.target.checked)} /> Public (every user may export with it)
            </label>
            <label className="check">
              <input type="checkbox" checked={value.image_aggregation} onChange={(e) => set("image_aggregation", e.target.checked)} /> One block per image
            </label>
            <label className="check">
              <input type="checkbox" checked={value.include_blurred} onChange={(e) => set("include_blurred", e.target.checked)} /> Include blurred
            </label>
            <label className="check">
              <input type="checkbox" checked={value.include_concealed} onChange={(e) => set("include_concealed", e.target.checked)} /> Include concealed
            </label>
          </div>
          <fieldset className="type-pick">
            <legend>Annotation types</legend>
            {(types.data ?? []).map((t) => (
              <label key={t.id} className="check">
                <input type="checkbox" checked={value.annotation_types.includes(t.id)} onChange={() => toggleType(t.id)} /> {t.name}
              </label>
            ))}
          </fieldset>
          {area("annotation_format", "Per annotation", 3)}
          {area("vector_format", "Per point of the annotation")}
          {value.image_aggregation && (
            <label className="field">
              <span>Per image (put %%annotations where its annotations go)</span>
              <textarea className="mono" rows={3} value={value.image_format ?? ""} onChange={(e) => set("image_format", e.target.value)} spellCheck={false} aria-label="Per image" />
            </label>
          )}
          {area("not_in_image_format", "Annotation “not in image”")}
          {area("base_format", "Whole file (%%content is where the annotations go)", 3)}
          {area("name_format", "File name", 1)}
          <button className="btn ghost small" onClick={() => setHelp((h) => !h)}>
            {help ? "▾" : "▸"} Placeholders
          </button>
          {help && (
            <dl className="help">
              {HELP.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd className="mono">{v}</dd>
                </div>
              ))}
            </dl>
          )}
          {error && <p className="error">{error}</p>}
          <div className="modal-actions">
            <button className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy || !value.name.trim() || value.annotation_types.length === 0} onClick={() => void save()} title={value.annotation_types.length === 0 ? "Choose at least one annotation type" : undefined}>
              Save format
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
