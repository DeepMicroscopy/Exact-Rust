import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";

/** The personal settings of the account (`/api/v2/me/preferences`). */
export interface Preferences {
  /** navigate slides as the old EXACT did: a click on the background zooms in, a drag always moves the slide */
  legacy_navigation: boolean;
  /** show the registered image at once when an image has exactly one to overlay */
  auto_overlay: boolean;
}

const DEFAULTS: Preferences = { legacy_navigation: false, auto_overlay: false };
const KEY = ["preferences"];

export function usePreferences(): { prefs: Preferences; set(p: Partial<Preferences>): Promise<void> } {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => api<Preferences>("/api/v2/me/preferences"), staleTime: Infinity });
  const set = useCallback(
    async (p: Partial<Preferences>) => {
      qc.setQueryData<Preferences>(KEY, (old) => ({ ...DEFAULTS, ...old, ...p }));
      try {
        qc.setQueryData(KEY, await api<Preferences>("/api/v2/me/preferences", { method: "PUT", json: p }));
      } catch {
        await qc.invalidateQueries({ queryKey: KEY });
      }
    },
    [qc],
  );
  return { prefs: q.data ?? DEFAULTS, set };
}
