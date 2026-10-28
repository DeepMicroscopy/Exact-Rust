import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import type { Page } from "../api/client";
import type { Registration, RegistrationJob, SetImage } from "../api/types";
import { Modal } from "./Modal";
import { Thumb } from "./Thumb";

const msg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

/** Starts a registration job: `source` onto `target` (a point of the source maps to the target through the result). */
export function NewRegistrationDialog({ images, source: initialSource, target: initialTarget, onClose, onStarted }: { images: SetImage[]; source?: number; target?: number; onClose(): void; onStarted(): void }) {
  const [source, setSource] = useState<number>(initialSource ?? images[0]?.id ?? 0);
  const [target, setTarget] = useState<number>(initialTarget ?? images.find((i) => i.id !== (initialSource ?? images[0]?.id))?.id ?? 0);
  const [inverse, setInverse] = useState(true);
  const [advanced, setAdvanced] = useState(false);
  const [features, setFeatures] = useState(512);
  const [ratio, setRatio] = useState(0.7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    try {
      await api(`/api/v2/images/${source}/register`, { json: { target_image: target, create_inverse_registration: inverse, ...(advanced ? { maxFeatures: features, ratio } : {}) } });
      onStarted();
      onClose();
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };
  return (
    <Modal title="Register two images" onClose={onClose}>
      <p className="muted small">The server finds the transformation that maps the source image onto the target image (a worker computes it; this can take a few minutes for large slides).</p>
      <label className="field">
        <span>Source image</span>
        <select value={source} onChange={(e) => setSource(Number(e.target.value))}>
          {images.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Target image</span>
        <select value={target} onChange={(e) => setTarget(Number(e.target.value))}>
          {images.filter((i) => i.id !== source).map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={inverse} onChange={(e) => setInverse(e.target.checked)} /> Also create the inverse registration (target onto source)
      </label>
      <button className="btn ghost small" onClick={() => setAdvanced((a) => !a)}>
        {advanced ? "▾" : "▸"} Parameters
      </button>
      {advanced && (
        <div className="params">
          <label className="field">
            <span>Features per tile</span>
            <input type="number" min={32} max={4096} value={features} onChange={(e) => setFeatures(Number(e.target.value))} />
          </label>
          <label className="field">
            <span>Match ratio</span>
            <input type="number" min={0.1} max={1} step={0.05} value={ratio} onChange={(e) => setRatio(Number(e.target.value))} />
          </label>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => void go()} disabled={busy || !source || !target || source === target}>
          Start
        </button>
      </div>
    </Modal>
  );
}

const STATUS: Record<RegistrationJob["status"], string> = { queued: "waiting for a worker", running: "computing…", done: "done", failed: "failed" };

/** Registrations of the images of an image set and the jobs that compute them. */
export function RegistrationPanel({ images, canEdit, onNew }: { images: SetImage[]; canEdit: boolean; onNew(): void }) {
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
  const name = (id: number) => byId.get(id)?.name ?? `image ${id}`;
  const open = (jobs.data ?? []).filter((j) => j.status === "queued" || j.status === "running" || j.status === "failed");
  const has = (s: number, t: number) => (regs.data ?? []).some((r) => r.source_image === s && r.target_image === t);

  return (
    <div className="registrations">
      <div className="toolbar">
        <h3>Registrations</h3>
        <span className="spacer" />
        {canEdit && (
          <button className="btn primary" onClick={onNew} disabled={images.length < 2}>
            New registration…
          </button>
        )}
      </div>
      {images.length < 2 && <p className="muted">An image set needs at least two images to register them.</p>}

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
                <button className="btn small" onClick={() => redo.mutate({ source: r.source_image, target: r.target_image })} title="Compute it again">
                  Recompute
                </button>
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
