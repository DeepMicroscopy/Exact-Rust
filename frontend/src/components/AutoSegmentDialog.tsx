import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { Modal } from "./Modal";
import { ParamFields, changedOf, defaultsOf, type ParamSpec, type ParamValues } from "./ParamFields";

interface Segmenter {
  id: number;
  name: string;
  author: string;
  description: string;
  parameters_schema: ParamSpec[];
  available: boolean;
}

interface SegJob {
  id: number;
  status: "queued" | "running" | "done" | "failed";
  progress: number;
  message: string | null;
  worker: string | null;
  annotation: number | null;
}

const msg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

/**
 * "Auto segment": a worker computes the mask of a volume with one of the segmenters it announced (a classical method such as a
 * threshold, or a model of your own: see the administration guide). The mask is put into the mask annotation of the chosen
 * type, replacing or adding to what is there, and shows like a painted one; the caller refreshes its views when `onStarted`'s
 * job is done (`onDone`).
 */
export function AutoSegmentDialog({ imageId, segTypes, onClose, onStarted, onDone }: { imageId: number; segTypes: { id: number; name: string; color?: string }[]; onClose(): void; onStarted?(): void; onDone?(annotation: number | null): void }) {
  const segmenters = useQuery({ queryKey: ["segmenters"], queryFn: () => api<{ items: Segmenter[]; workers: { name: string }[] }>("/api/v2/segmenters"), staleTime: 0 });
  const usable = (segmenters.data?.items ?? []).filter((s) => s.available);
  const [segmenter, setSegmenter] = useState<string>("");
  const [type, setType] = useState<number>(segTypes[0]?.id ?? 0);
  const [mode, setMode] = useState<"replace" | "add">("replace");
  const [values, setValues] = useState<ParamValues>({});
  const [job, setJob] = useState<SegJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const chosen = usable.find((s) => s.name === segmenter) ?? usable[0] ?? null;
  const schema = chosen?.parameters_schema ?? [];
  useEffect(() => setValues(defaultsOf(schema)), [chosen?.name]); // eslint-disable-line react-hooks/exhaustive-deps

  const finished = useRef(false);
  // while a job is on, ask for it now and then
  useEffect(() => {
    if (!job || job.status === "done" || job.status === "failed") return;
    const timer = window.setInterval(() => {
      api<SegJob>(`/api/v2/segmentation-jobs/${job.id}`)
        .then(setJob)
        .catch((e) => setError(msg(e)));
    }, 1500);
    return () => window.clearInterval(timer);
  }, [job]);
  useEffect(() => {
    if (job?.status === "done" && !finished.current) {
      finished.current = true;
      onDone?.(job.annotation);
    }
  }, [job, onDone]);

  const start = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const made = await api<SegJob>(`/api/v2/images/${imageId}/auto-segment`, { json: { segmenter: chosen.name, annotation_type: type, mode, parameters: changedOf(schema, values) } });
      setJob(made);
      onStarted?.();
    } catch (e) {
      setError(msg(e));
    }
    setBusy(false);
  };

  const running = job && (job.status === "queued" || job.status === "running");
  const workers = segmenters.data?.workers.length ?? 0;
  return (
    <Modal title="Auto segment" onClose={onClose} wide>
      {!job && (
        <>
          <p className="muted small">A worker computes the mask of the whole volume. The result is a mask like a painted one: you can correct it with the brush and undo it.</p>
          {segmenters.isLoading && <p className="muted">Loading…</p>}
          {segmenters.data && usable.length === 0 && <p className="warn small">No segmentation method is available: start a segmentation worker (helpers/segment_worker.py, see the administration guide).</p>}
          {chosen && (
            <>
              <label className="field">
                <span>Method</span>
                <select aria-label="Segmentation method" value={chosen.name} onChange={(e) => setSegmenter(e.target.value)}>
                  {usable.map((s) => (
                    <option key={s.id} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              {chosen.description && <p className="muted small">{chosen.description}</p>}
              <label className="field">
                <span>Mask of the type</span>
                <select aria-label="Segmentation type" value={type} onChange={(e) => setType(Number(e.target.value))}>
                  {segTypes.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              {segTypes.length === 0 && <p className="warn small">The image set has no segmentation type: add a product with one to the image set first.</p>}
              <div className="seg" role="radiogroup" aria-label="What to do with the existing mask">
                <button role="radio" aria-checked={mode === "replace"} className={mode === "replace" ? "active" : ""} onClick={() => setMode("replace")}>
                  Replace the mask
                </button>
                <button role="radio" aria-checked={mode === "add"} className={mode === "add" ? "active" : ""} onClick={() => setMode("add")}>
                  Add to the mask
                </button>
              </div>
              {schema.length > 0 && <ParamFields schema={schema} values={values} onChange={setValues} />}
              {workers === 0 && <p className="muted small">No segmentation worker has asked for work in the last minutes: the job waits until one does.</p>}
            </>
          )}
        </>
      )}
      {job && (
        <div role="status" aria-live="polite">
          <p>
            {job.status === "queued" && "Waiting for a worker…"}
            {job.status === "running" && (job.message ?? "Working…")}
            {job.status === "done" && "The mask is ready."}
            {job.status === "failed" && "The segmentation failed."}
          </p>
          {running && <progress max={1} value={job.progress} aria-label="Progress" style={{ width: "100%" }} />}
          {job.status === "failed" && <p className="error small">{job.message}</p>}
          {job.status === "done" && <p className="muted small">{job.message ? `${job.message}. ` : ""}Look at it in the three planes; undo removes it again.</p>}
        </div>
      )}
      {error && <p className="error small">{error}</p>}
      <div className="modal-actions">
        {!job && (
          <button className="btn primary" onClick={() => void start()} disabled={busy || !chosen || !type}>
            Start
          </button>
        )}
        <button className="btn" onClick={onClose}>
          {running ? "Close (it keeps running)" : "Close"}
        </button>
      </div>
    </Modal>
  );
}
