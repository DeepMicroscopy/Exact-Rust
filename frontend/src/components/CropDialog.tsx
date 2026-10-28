import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { Modal } from "./Modal";

interface WritableSet {
  id: number;
  name: string;
  team: number;
  team_name: string;
}

interface Props {
  imageId: number;
  /** region in image pixels */
  region: { x: number; y: number; w: number; h: number };
  frame: number;
  /** the image set of the source image: its team and products carry over to a new image set */
  source: { team: number | null; products: number[] };
  mpp: number;
  onClose(): void;
  onDone(imageId: number, setId: number): void;
}

const NEW = "new";

/** Asks where the crop should go (an existing image set or a new one), then calls the server's crop. */
export function CropDialog({ imageId, region, frame, source, mpp, onClose, onDone }: Props) {
  // always fresh: the list changes when image sets are created or locked
  const sets = useQuery({ queryKey: ["writable-sets"], queryFn: () => api<{ items: WritableSet[] }>("/api/v2/image-sets/writable"), staleTime: 0, refetchOnMount: "always" });
  const teams = useQuery({ queryKey: ["teams-mine"], queryFn: () => api<{ items: { id: number; name: string }[] }>("/api/v2/teams?limit=200&fields=id,name") });
  const [target, setTarget] = useState<string>("");
  const [name, setName] = useState("Crops");
  const [team, setTeam] = useState<number | null>(source.team);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<{ id: number; set: number } | null>(null);

  const items = sets.data?.items ?? [];
  const choice = target || (items[0] ? String(items[0].id) : NEW);
  const size = mpp > 0 ? ` (${((region.w * mpp) / 1000).toFixed(2)} × ${((region.h * mpp) / 1000).toFixed(2)} mm)` : "";

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      let setId = Number(choice);
      if (choice === NEW) {
        if (!name.trim()) throw new Error("Give the new image set a name.");
        const created = await api<{ id: number }>("/api/v2/image-sets", { json: { name: name.trim(), team: team ?? teams.data?.items[0]?.id, products: source.products } });
        setId = created.id;
      }
      const img = await api<{ id: number }>(`/api/v2/images/${imageId}/crop`, { json: { ...region, frame, image_set: setId } });
      onDone(img.id, setId);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const ex = e.body?.existing;
        if (typeof ex === "number") setExisting({ id: ex, set: Number(choice) });
        setError("This region was cropped into that image set before.");
      } else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const byTeam = new Map<string, WritableSet[]>();
  for (const s of items) byTeam.set(s.team_name, [...(byTeam.get(s.team_name) ?? []), s]);

  return (
    <Modal title="Crop to new image" onClose={busy ? () => undefined : onClose}>
      <p>
        Save the region of this annotation, {region.w} × {region.h} px{size}, as a new image{frame > 0 ? ` (frame ${frame + 1})` : ""}.
      </p>
      <label className="field">
        <span>Target image set</span>
        <select value={choice} onChange={(e) => setTarget(e.target.value)} disabled={busy}>
          {[...byTeam.entries()].map(([t, list]) => (
            <optgroup key={t} label={t}>
              {list.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </optgroup>
          ))}
          <option value={NEW}>＋ New image set…</option>
        </select>
      </label>
      {choice === NEW && (
        <>
          <label className="field">
            <span>Name of the new image set</span>
            <input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} maxLength={256} />
          </label>
          <label className="field">
            <span>Team</span>
            <select value={team ?? ""} onChange={(e) => setTeam(Number(e.target.value))} disabled={busy}>
              {(teams.data?.items ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <p className="muted small">The new image set gets the annotation types (products) of this image's set.</p>
        </>
      )}
      {error && (
        <p className="error">
          {error}{" "}
          {existing && (
            <button className="btn" onClick={() => onDone(existing.id, existing.set)}>
              Open it
            </button>
          )}
        </p>
      )}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => void run()} disabled={busy || sets.isLoading}>
          {busy ? "Cropping…" : "Crop"}
        </button>
      </div>
    </Modal>
  );
}
