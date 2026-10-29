import { ParamFields, changedOf, defaultsOf, type ParamSpec, type ParamValues } from "./ParamFields";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, listAll } from "../api/client";
import type { Page } from "../api/client";
import type { Registration, RegistrationJob, SetImage } from "../api/types";
import { ImagePicker } from "./ImagePicker";
import { Modal } from "./Modal";
import { Thumb } from "./Thumb";

export interface RegistrationPlugin {
  id: number;
  name: string;
  author: string;
  package: string;
  default: boolean;
  parameters_schema: ParamSpec[] | null;
}

const msg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

/**
 * Registers `source` (an image of this set) onto `target` (an image of any set): a worker computes it, or the points are
 * picked by hand (`onManual`). A point of the source maps to the target through the result.
 */
export function NewRegistrationDialog({ images, setId, source: initialSource, target: initialTarget, onClose, onStarted, onManual }: { images: SetImage[]; setId: number; source?: number; target?: number; onClose(): void; onStarted(): void; onManual(source: SetImage, target: SetImage): void }) {
  const [source, setSource] = useState<number>(initialSource ?? images[0]?.id ?? 0);
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [targetSet, setTargetSet] = useState<number>(setId);
  const [target, setTarget] = useState<number>(initialTarget ?? images.find((i) => i.id !== (initialSource ?? images[0]?.id))?.id ?? 0);
  const [inverse, setInverse] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [plugin, setPlugin] = useState<number | null>(null);
  const [values, setValues] = useState<ParamValues>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sets = useQuery({ queryKey: ["image-set-names"], queryFn: () => listAll<{ id: number; name: string }>("/api/v2/image-sets", { fields: "id,name" }) });
  const other = useQuery({
    queryKey: ["images", targetSet],
    enabled: targetSet !== setId,
    queryFn: () => listAll<SetImage>("/api/v2/images", { image_set: targetSet, fields: "id,name,width,height,mpp,frames,image_set,time,crop_source" }),
  });
  const plugins = useQuery({ queryKey: ["registration-plugins"], queryFn: () => api<{ items: RegistrationPlugin[] }>("/api/v2/registration-plugins"), staleTime: 0 });
  const chosen = plugins.data?.items.find((p) => p.id === plugin) ?? plugins.data?.items.find((p) => p.default) ?? plugins.data?.items[0] ?? null;
  const schema = chosen?.parameters_schema ?? [];
  useEffect(() => setValues(defaultsOf(schema)), [chosen?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const candidates = (targetSet === setId ? images : (other.data ?? [])).filter((i) => i.id !== source);
  // keep the target valid when the set or the source changes
  useEffect(() => {
    if (!candidates.some((i) => i.id === target)) setTarget(candidates[0]?.id ?? 0);
  }, [candidates, target]);
  const go = async () => {
    if (mode === "manual") {
      const s = images.find((i) => i.id === source);
      const t = candidates.find((i) => i.id === target);
      if (s && t) {
        onManual(s, t);
        onClose();
      }
      return;
    }
    setBusy(true);
    try {
      await api(`/api/v2/images/${source}/register`, { json: { target_image: target, create_inverse_registration: inverse, ...(chosen ? { plugin: chosen.id, ...changedOf(schema, values) } : {}) } });
      onStarted();
      onClose();
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };
  return (
    <Modal title="Register two images" onClose={onClose} wide>
      <div className="seg" role="radiogroup" aria-label="Method">
        <button role="radio" aria-checked={mode === "auto"} className={mode === "auto" ? "active" : ""} onClick={() => setMode("auto")}>
          Automatic
        </button>
        <button role="radio" aria-checked={mode === "manual"} className={mode === "manual" ? "active" : ""} onClick={() => setMode("manual")}>
          Manual
        </button>
      </div>
      <p className="muted small">
        {mode === "auto" ? "A worker finds the transformation that maps the source image onto the target image; this can take a few minutes for large slides." : "You click the same spots in both images; the transformation is estimated from them. Works for any pair, also where the automatic registration fails."}
      </p>
      <ImagePicker label="Source image" images={images} value={source} onChange={setSource} />
      <label className="field">
        <span>Target image set</span>
        <select aria-label="Target image set" value={targetSet} onChange={(e) => setTargetSet(Number(e.target.value))}>
          <option value={setId}>This image set</option>
          {(sets.data ?? [])
            .filter((x) => x.id !== setId)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
        </select>
      </label>
      <ImagePicker label="Target image" images={candidates} value={target} onChange={setTarget} />
      {mode === "auto" && (
        <>
          <label className="check">
            <input type="checkbox" checked={inverse} onChange={(e) => setInverse(e.target.checked)} /> Also create the inverse registration (target onto source)
          </label>
          {(plugins.data?.items.length ?? 0) > 1 && (
            <label className="field">
              <span>Registration method</span>
              <select aria-label="Registration method" value={chosen?.id ?? ""} onChange={(e) => setPlugin(Number(e.target.value))}>
                {plugins.data?.items.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.default ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(plugins.data?.items.length ?? 0) === 1 && chosen && <p className="muted small">Method: {chosen.name}</p>}
          {plugins.data && plugins.data.items.length === 0 && <p className="warn small">No registration method is available: start a registration worker (helpers/queue_worker.py) or pick the points by hand.</p>}
          {schema.length > 0 && (
            <>
              <button className="btn ghost small" onClick={() => setAdvanced((a) => !a)}>
                {advanced ? "▾" : "▸"} Parameters
              </button>
              {advanced && <ParamFields schema={schema} values={values} onChange={setValues} />}
            </>
          )}
        </>
      )}
      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => void go()} disabled={busy || !source || !target || source === target || (mode === "auto" && !chosen)}>
          {mode === "auto" ? "Start" : "Pick points…"}
        </button>
      </div>
    </Modal>
  );
}

const STATUS: Record<RegistrationJob["status"], string> = { queued: "waiting for a worker", running: "computing…", done: "done", failed: "failed" };

/** Registrations of the images of an image set and the jobs that compute them. */
export function RegistrationPanel({ images, canEdit, onNew, onManual }: { images: SetImage[]; canEdit: boolean; onNew(): void; onManual(source: number, target: number, review?: boolean): void }) {
  const qc = useQueryClient();
  const ids = useMemo(() => images.map((i) => i.id), [images]);
  const byId = useMemo(() => new Map(images.map((i) => [i.id, i])), [images]);
  const idList = ids.join(",");
  const jobsRef = useRef<RegistrationJob[]>([]);
  const regs = useQuery({
    queryKey: ["registrations", idList],
    enabled: ids.length > 0,
    // while a job is open its result will show up
    refetchInterval: () => (jobsRef.current.some((j) => j.status === "queued" || j.status === "running") ? 2500 : false),
    queryFn: async () => {
      const [a, b] = await Promise.all([
        api<Page<Registration>>(`/api/v2/registrations?source_image__in=${idList}&limit=1000`),
        api<Page<Registration>>(`/api/v2/registrations?target_image__in=${idList}&limit=1000`),
      ]);
      const seen = new Map<number, Registration>();
      for (const r of [...a.items, ...b.items]) seen.set(r.id, r);
      return [...seen.values()].sort((x, y) => y.id - x.id);
    },
  });
  const jobs = useQuery({
    queryKey: ["registration-jobs", idList],
    enabled: ids.length > 0,
    queryFn: async () => (await api<{ items: RegistrationJob[] }>("/api/v2/registration-jobs")).items.filter((j) => byId.has(j.source_image) || byId.has(j.target_image)),
    refetchInterval: (q) => ((q.state.data ?? []).some((j) => j.status === "queued" || j.status === "running") ? 2500 : false),
  });
  jobsRef.current = jobs.data ?? [];
  // a job that finished has produced a registration the list does not know yet
  const refetchRegs = regs.refetch;
  useEffect(() => {
    if ((jobs.data ?? []).some((j) => j.status === "done" && j.registration != null && !(regs.data ?? []).some((r) => r.id === j.registration))) void refetchRegs();
  }, [jobs.data, regs.data, refetchRegs]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["registrations"] });
    void qc.invalidateQueries({ queryKey: ["registration-jobs"] });
  };
  const inverse = useMutation({ mutationFn: (id: number) => api(`/api/v2/registrations/${id}/inverse`, { method: "POST" }), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id: number) => api(`/api/v2/registrations/${id}`, { method: "DELETE" }), onSuccess: refresh });
  const redo = useMutation({ mutationFn: (r: { source: number; target: number }) => api(`/api/v2/images/${r.source}/register`, { json: { target_image: r.target } }), onSuccess: refresh });
  // images of other sets that take part in a registration
  const foreign = useMemo(() => [...new Set([...(regs.data ?? []).flatMap((r) => [r.source_image, r.target_image]), ...(jobs.data ?? []).flatMap((j) => [j.source_image, j.target_image])])].filter((i) => !byId.has(i)).sort((a, b) => a - b), [regs.data, jobs.data, byId]);
  const foreignNames = useQuery({
    queryKey: ["image-names", foreign.join(",")],
    enabled: foreign.length > 0,
    queryFn: async () => new Map((await api<Page<{ id: number; name: string }>>(`/api/v2/images?id__in=${foreign.join(",")}&fields=id,name&limit=1000`)).items.map((i) => [i.id, i.name])),
  });
  const name = (id: number) => byId.get(id)?.name ?? foreignNames.data?.get(id) ?? `image ${id}`;
  const open = (jobs.data ?? []).filter((j) => j.status === "queued" || j.status === "running" || j.status === "failed");
  const has = (s: number, t: number) => (regs.data ?? []).some((r) => r.source_image === s && r.target_image === t);

  return (
    <div className="registrations">
      <div className="toolbar">
        <h3>Registrations</h3>
        <span className="spacer" />
        {canEdit && (
          <button className="btn primary" onClick={onNew} disabled={images.length < 1}>
            New registration…
          </button>
        )}
      </div>
      {images.length < 1 && <p className="muted">This image set has no images to register.</p>}

      {open.length > 0 && (
        <div className="jobs">
          {open.map((j) => (
            <div key={j.id} className={`job ${j.status}`}>
              <span className={`badge ${j.status}`}>{STATUS[j.status]}</span>
              <span className="name">
                {name(j.source_image)} → {name(j.target_image)}
              </span>
              {j.error && (
                <span className="muted small err" title={j.error}>
                  {j.error.split("\n").at(-1)?.slice(0, 120)}
                </span>
              )}
              {j.status === "failed" && canEdit && (
                <button className="btn small" onClick={() => redo.mutate({ source: j.source_image, target: j.target_image })}>
                  Try again
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {regs.isLoading && <p className="muted">Loading…</p>}
      {regs.data && regs.data.length === 0 && open.length === 0 && <p className="muted">No registrations yet.</p>}
      <div className="reg-list">
        {(regs.data ?? []).map((r) => (
          <div key={r.id} className="reg glass">
            <div className="reg-pair">
              <div className="reg-img">
                <Thumb imageId={r.source_image} alt="" />
                <span className="name" title={name(r.source_image)}>
                  {name(r.source_image)}
                </span>
              </div>
              <span className="arrow">→</span>
              <div className="reg-img">
                <Thumb imageId={r.target_image} alt="" />
                <span className="name" title={name(r.target_image)}>
                  {name(r.target_image)}
                </span>
              </div>
            </div>
            <div className="reg-facts muted small">
              {r.registration_error >= 0 && <span title="mean registration error">error {r.registration_error.toFixed(2)} px</span>}
              {r.get_scale && <span>scale {r.get_scale[0].toFixed(3)}</span>}
              {r.rotation_angle != null && <span>rotation {r.rotation_angle.toFixed(1)}°</span>}
              {r.runtime >= 0 && <span>{r.runtime} s</span>}
            </div>
            {canEdit && (
              <div className="reg-actions">
                {!has(r.target_image, r.source_image) && (
                  <button className="btn small" onClick={() => inverse.mutate(r.id)} disabled={inverse.isPending} title="Create the registration of the target onto the source">
                    Add inverse
                  </button>
                )}
                <button className="btn small" onClick={() => redo.mutate({ source: r.source_image, target: r.target_image })} title="Compute it again automatically">
                  Recompute
                </button>
                <button className="btn small" onClick={() => onManual(r.source_image, r.target_image, true)} title="Lay the source image over the target to check the registration">
                  Review
                </button>
                {byId.has(r.source_image) && (
                  <button className="btn small" onClick={() => onManual(r.source_image, r.target_image)} title="Set it by picking points">
                    Redo manually
                  </button>
                )}
                <button className="btn small danger" onClick={() => window.confirm("Delete this registration?") && remove.mutate(r.id)}>
                  Delete
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
