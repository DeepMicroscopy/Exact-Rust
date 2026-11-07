import { useEffect, useMemo, useState, type MutableRefObject } from "react";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { FloatingPanel } from "./FloatingPanel";
import { changedOf, defaultsOf, ParamFields, type ParamValues } from "./ParamFields";
import { useAnalysis, type AnalysisPlugin } from "../hooks/useAnalysis";
import { countAbove, type Detections, type PluginResultLayer } from "../viewer-core/pluginResultLayer";

/** What is shown in the viewer: result entries (by id) with their threshold. Kept by the viewer page, so that closing the panel keeps it. */
export type ShownEntries = Record<number, number>;

const msg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

/** The icon of the top bar: a robot's head (the plugins), with a dot when the image has results. */
export function AnalysisButton({ open, results, onClick }: { open: boolean; results: number; onClick(): void }) {
  return (
    <button className={`btn ghost icon-btn ${open ? "on" : ""}`} onClick={onClick} aria-pressed={open} aria-label="Analysis" data-testid="analysis-button" title={results ? `Analysis: ${results} result${results === 1 ? "" : "s"} for this image; run plugins` : "Analysis: run plugins on this image"}>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3v2.5M9 3.6 10 5.6M15 3.6 14 5.6" />
        <rect x="4.5" y="6" width="15" height="11.5" rx="3.5" />
        <circle cx="9.3" cy="11.5" r="1.5" fill="currentColor" stroke="none" />
        <circle cx="14.7" cy="11.5" r="1.5" fill="currentColor" stroke="none" />
        <path d="M9.5 15h5M2.8 10.5v3.5M21.2 10.5v3.5M8.5 17.5v2.5M15.5 17.5v2.5" />
      </svg>
      {results > 0 && <span className="adjust-dot" aria-hidden="true" />}
    </button>
  );
}

/** Loads the detections of the shown entries and gives them to the canvas layer (renders nothing). */
export function AnalysisLayers({ shown, layerRef }: { shown: ShownEntries; layerRef: MutableRefObject<PluginResultLayer | null> }) {
  const ids = Object.keys(shown).map(Number);
  const loaded = useQueries({
    queries: ids.map((id) => ({ queryKey: ["detections", id], queryFn: () => api<Detections>(`/api/v2/plugin-result-entries/${id}/detections`), staleTime: 5 * 60_000 })),
  });
  const data = loaded.map((q) => q.data);
  useEffect(() => {
    layerRef.current?.setLayers(ids.flatMap((id, i) => (data[i] ? [{ id, data: data[i] as Detections, threshold: shown[id] }] : [])));
  }, [shown, ...data]);
  useEffect(() => () => layerRef.current?.setLayers([]), [layerRef]);
  return null;
}

function PluginCard({ plugin, imageId }: { plugin: AnalysisPlugin; imageId: number }) {
  const qc = useQueryClient();
  const [values, setValues] = useState<ParamValues>(() => defaultsOf(plugin.parameters_schema));
  const [open, setOpen] = useState(false);
  const run = useMutation({
    mutationFn: () => api(`/api/v2/images/${imageId}/analyze`, { json: { plugin: plugin.id, params: changedOf(plugin.parameters_schema, values) } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["analysis", imageId] }),
  });
  const job = plugin.job;
  const busy = job?.status === "queued" || job?.status === "running";
  return (
    <div className="analysis-card" data-testid="analysis-plugin">
      <div className="analysis-head">
        <div>
          <b>{plugin.name}</b>
          {plugin.author && <span className="muted small"> · {plugin.author}</span>}
        </div>
        <button className="btn primary small" onClick={() => run.mutate()} disabled={busy || run.isPending} data-testid="analysis-run">
          {job?.status === "failed" ? "Run again" : "Run"}
        </button>
      </div>
      {job?.status === "queued" && <p className="muted small">Waiting for a worker.{!plugin.served && <span className="warn"> No worker has asked for this plugin lately: the job waits until one is started.</span>}</p>}
      {job?.status === "running" && (
        <p className="muted small">
          Running{job.progress != null ? ` · ${Math.round(job.progress)} %` : ""}
          <progress max={100} value={job.progress ?? 0} />
        </p>
      )}
      {job?.status === "failed" && <p className="error small" title={job.error ?? ""}>Failed: {job.error}</p>}
      {run.error && <p className="error small">{msg(run.error)}</p>}
      {plugin.parameters_schema.length > 0 && (
        <>
          <button className="btn ghost small" onClick={() => setOpen((o) => !o)}>
            {open ? "▾" : "▸"} Parameters
          </button>
          {open && <ParamFields schema={plugin.parameters_schema} values={values} onChange={setValues} />}
        </>
      )}
    </div>
  );
}

/** The window of the analysis button: results this image has (shown over the image, with a threshold) and the plugins that can be run. */
export function AnalysisPanel({ imageId, shown, setShown, onClose }: { imageId: number; shown: ShownEntries; setShown(s: ShownEntries): void; onClose(): void }) {
  const analysis = useAnalysis(imageId, true);
  const a = analysis.data;
  const cached = useQueries({ queries: Object.keys(shown).map((id) => ({ queryKey: ["detections", Number(id)], queryFn: () => api<Detections>(`/api/v2/plugin-result-entries/${id}/detections`), staleTime: 5 * 60_000 })) });
  const counts = useMemo(() => new Map(cached.flatMap((q) => (q.data ? [[q.data.id, q.data] as const] : []))), [cached]);
  const toggle = (id: number, threshold: number) => {
    const next = { ...shown };
    if (id in next) delete next[id];
    else next[id] = threshold;
    setShown(next);
  };
  return (
    <FloatingPanel title="Analysis" onClose={onClose} storageKey="exact.analysis.pos" initial={{ right: 16, top: 64 }} className="analysis-panel">
      <div data-testid="analysis-panel">
        <h4>Results for this image</h4>
        {analysis.isLoading && <p className="muted small">Loading…</p>}
        {a && a.results.length === 0 && <p className="muted small">No analysis has been run on this image yet.</p>}
        {a?.results.map((r) => (
          <div key={r.id} className="analysis-result">
            <div>
              <b>{r.plugin.name}</b>
              <span className="muted small"> · {r.completed_time ? new Date(r.completed_time).toLocaleString() : ""}</span>
            </div>
            {r.entries.map((e) => {
              const on = e.id in shown;
              const d = counts.get(e.id);
              return (
                <div key={e.id} className="analysis-entry" data-testid="analysis-entry">
                  <label className="check">
                    <input type="checkbox" checked={on} onChange={() => toggle(e.id, e.default_threshold)} aria-label={`Show ${e.name}`} /> {e.name}
                    <span className="muted small"> · {e.count} detection{e.count === 1 ? "" : "s"}</span>
                  </label>
                  {on && (
                    <div className="analysis-threshold">
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={shown[e.id]}
                        onChange={(ev) => setShown({ ...shown, [e.id]: Number(ev.target.value) })}
                        onPointerUp={(ev) => (ev.target as HTMLElement).blur()}
                        aria-label={`Threshold of ${e.name}`}
                      />
                      <output className="small">
                        ≥ {shown[e.id].toFixed(2)}
                        {d ? ` · ${countAbove(d, shown[e.id])} shown${d.truncated ? " (first 300,000)" : ""}` : " · loading…"}
                      </output>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        <h4>Run an analysis</h4>
        {a && a.plugins.length === 0 && <p className="muted small">No analysis plugin is available for this image set. A worker has to announce one (and, if the plugin names products, one of them has to be used by the set).</p>}
        {a?.plugins.map((p) => (
          <PluginCard key={p.id} plugin={p} imageId={imageId} />
        ))}
      </div>
    </FloatingPanel>
  );
}
