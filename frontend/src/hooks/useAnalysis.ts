import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { ParamSpec } from "../components/ParamFields";

export interface AnalysisEntry {
  id: number;
  name: string;
  default_threshold: number;
  count: number;
}
export interface AnalysisResult {
  id: number;
  plugin: { id: number; name: string };
  job: number | null;
  completed_time: string | null;
  entries: AnalysisEntry[];
}
export interface AnalysisJob {
  id: number;
  status: "queued" | "running" | "done" | "failed";
  progress: number | null;
  error: string | null;
  created_time: string | null;
}
export interface AnalysisPlugin {
  id: number;
  name: string;
  package: string;
  author: string;
  parameters_schema: ParamSpec[];
  /** a worker asked for the jobs of this plugin lately */
  served: boolean;
  job: AnalysisJob | null;
}
export interface Analysis {
  results: AnalysisResult[];
  plugins: AnalysisPlugin[];
}

/** What an image has (results of plugins) and what can be run on it; looked at again while a job is waiting or running. */
export function useAnalysis(imageId: number, fast: boolean) {
  return useQuery({
    queryKey: ["analysis", imageId],
    queryFn: () => api<Analysis>(`/api/v2/images/${imageId}/analysis`),
    refetchInterval: (q) => (fast || q.state.data?.plugins.some((p) => p.job && (p.job.status === "queued" || p.job.status === "running")) ? 3000 : false),
  });
}
