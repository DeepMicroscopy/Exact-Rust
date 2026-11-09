import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";

/** The personal settings of the account (`/api/v2/me/preferences`). */
export interface Preferences {
  /** navigate slides as the old EXACT did: a click on the background zooms in, a drag always moves the slide */
  legacy_navigation: boolean;
  /** show the registered image at once when an image has exactly one to overlay */
  auto_overlay: boolean;
  /** how opaque an overlay image is when it is first shown, in whole percent (0 - 100) */
  overlay_opacity: number;
  /** show a slider for the zoom level in the viewer */
  zoom_slider: boolean;
  /** how far one press of + / − zooms: low (25 %, the default), medium (50 %) or high (a factor of 2) */
  zoom_step: "low" | "medium" | "high";
  /** annotations may reach outside the image (negative coordinates, or beyond its size); off: they are held at the edge */
  allow_outside: boolean;
}

const DEFAULTS: Preferences = { legacy_navigation: false, auto_overlay: false, overlay_opacity: 50, zoom_slider: false, zoom_step: "low", allow_outside: false };
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
