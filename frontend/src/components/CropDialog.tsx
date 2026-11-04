import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../api/client";
import { Modal } from "./Modal";
import { useRegisteredImages } from "../hooks/useRegisteredImages";
import {
  cropRegistrationPoints,
  invertAffine,
  mappedRegion,
} from "../viewer-core/overlay";

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
  /** `extra`: how many images registered with the source were cropped as well */
  onDone(imageId: number, setId: number, extra?: number): void;
}

const NEW = "new";
const SAME = "same";

interface Step {
  key: string;
  label: string;
  state: "wait" | "run" | "ok" | "fail";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Asks where the crop should go (an existing image set or a new one), then calls the server's crop. */
export function CropDialog({
  imageId,
  region,
  frame,
  source,
  mpp,
  onClose,
  onDone,
}: Props) {
  // always fresh: the list changes when image sets are created or locked
  const sets = useQuery({
    queryKey: ["writable-sets"],
    queryFn: () => api<{ items: WritableSet[] }>("/api/v2/image-sets/writable"),
    staleTime: 0,
    refetchOnMount: "always",
  });
  const teams = useQuery({
    queryKey: ["teams-mine"],
    queryFn: () =>
      api<{ items: { id: number; name: string }[] }>(
        "/api/v2/teams?limit=200&fields=id,name",
      ),
  });
  const [target, setTarget] = useState<string>("");
  const [name, setName] = useState("Crops");
  const [team, setTeam] = useState<number | null>(source.team);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // the images registered with this one can be cropped at the same place (the region mapped through the registration)
  const registered = useRegisteredImages(imageId);
  const others = (registered.data ?? [])
    .map((o) => {
      const inv = invertAffine(o.map);
      return {
        ...o,
        region: inv && mappedRegion(inv, region, o.width, o.height),
      };
    })
    .filter((o) => o.region);
  const [withOthers, setWithOthers] = useState(false);
  const [skip, setSkip] = useState<Set<number>>(new Set());
  // the image set of each registered image's crop: as the first crop, an existing one, or a new one with a name
  const [targets, setTargets] = useState<Record<number, string>>({});
  const [newNames, setNewNames] = useState<Record<number, string>>({});
  const targetOf = (id: number) => targets[id] ?? SAME;
  const nameOf = (id: number) => newNames[id] ?? "Crops (registered)";
  const chosenOthers = withOthers ? others.filter((o) => !skip.has(o.id)) : [];
  const [done, setDone] = useState<{
    id: number;
    set: number;
    extra: number;
  } | null>(null);
  const [existing, setExisting] = useState<{ id: number; set: number } | null>(
    null,
  );

  // the steps of a run, shown as a checklist while it goes on
  const [steps, setSteps] = useState<Step[]>([]);
  const mark = (key: string, state: Step["state"]) =>
    setSteps((all) =>
      all.map((st) => (st.key === key ? { ...st, state } : st)),
    );
  /** runs one step of the checklist: running, then done or failed (and the failure goes on) */
  const doStep = async <T,>(key: string, fn: () => Promise<T>): Promise<T> => {
    mark(key, "run");
    try {
      const out = await fn();
      mark(key, "ok");
      return out;
    } catch (e) {
      mark(key, "fail");
      throw e;
    }
  };

  const items = sets.data?.items ?? [];
  const choice = target || (items[0] ? String(items[0].id) : NEW);
  const size =
    mpp > 0
      ? ` (${((region.w * mpp) / 1000).toFixed(2)} × ${((region.h * mpp) / 1000).toFixed(2)} mm)`
      : "";

  const run = async () => {
    if (choice === NEW && !name.trim())
      return setError("Give the new image set a name.");
    if (
      chosenOthers.some((o) => targetOf(o.id) === NEW && !nameOf(o.id).trim())
    )
      return setError(
        "Give each new image set for the registered images a name.",
      );
    setBusy(true);
    setError(null);
    setExisting(null);
    const teamId = team ?? teams.data?.items[0]?.id;
    const newSet = (nm: string) =>
      api<{ id: number }>("/api/v2/image-sets", {
        json: { name: nm, team: teamId, products: source.products },
      }).then((c) => c.id);
    // the plan: every step is listed before the first one starts
    const plan: Step[] = [];
    if (choice === NEW)
      plan.push({
        key: "set",
        label: `Create the image set “${name.trim()}”`,
        state: "wait",
      });
    plan.push({ key: "crop", label: "Crop this image", state: "wait" });
    const seenNew = new Set<string>();
    for (const o of chosenOthers) {
      const nm = nameOf(o.id).trim();
      if (targetOf(o.id) === NEW && !seenNew.has(nm)) {
        seenNew.add(nm);
        plan.push({
          key: `set:${nm}`,
          label: `Create the image set “${nm}”`,
          state: "wait",
        });
      }
      plan.push({
        key: `crop:${o.id}`,
        label: `Crop ${o.name}`,
        state: "wait",
      });
      plan.push({
        key: `reg:${o.id}`,
        label: `Register the crop of ${o.name} onto this crop`,
        state: "wait",
      });
    }
    setSteps(plan);
    try {
      const setId =
        choice === NEW
          ? await doStep("set", () => newSet(name.trim()))
          : Number(choice);
      const img = await doStep("crop", () =>
        api<{ id: number }>(`/api/v2/images/${imageId}/crop`, {
          json: { ...region, frame, image_set: setId },
        }),
      );
      if (chosenOthers.length === 0) {
        await sleep(500);
        onDone(img.id, setId);
        return;
      }
      // one new image set per name: registered images that choose the same new name share it
      const created = new Map<string, number>();
      const failed: string[] = [];
      let made = 0;
      for (const o of chosenOthers) {
        try {
          const t = targetOf(o.id);
          const nm = nameOf(o.id).trim();
          let otherSet = setId;
          if (t === NEW) {
            let id = created.get(nm);
            if (id == null) {
              id = await doStep(`set:${nm}`, () => newSet(nm));
              created.set(nm, id);
            }
            otherSet = id;
          } else if (t !== SAME) otherSet = Number(t);
          // frame 0: the frames of a registered image are not those of this one
          const id = await doStep(`crop:${o.id}`, async () => {
            try {
              return (
                await api<{ id: number }>(`/api/v2/images/${o.id}/crop`, {
                  json: { ...o.region, frame: 0, image_set: otherSet },
                })
              ).id;
            } catch (e) {
              // cropped there before: that image is registered all the same
              const ex =
                e instanceof ApiError && e.status === 409
                  ? e.body?.existing
                  : undefined;
              if (typeof ex !== "number") throw e;
              return ex;
            }
          });
          made++;
          // the crops keep the registration of their images: the crop of the registered image onto the crop of this one, and back
          await doStep(`reg:${o.id}`, () =>
            api("/api/v2/registrations/manual", {
              json: {
                source_image: id,
                target_image: img.id,
                points: cropRegistrationPoints(o.map, o.region!, region),
                inverse: true,
              },
            }),
          );
        } catch (e) {
          failed.push(
            `${o.name}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      if (failed.length === 0) {
        await sleep(500);
        onDone(img.id, setId, made);
      } else {
        setDone({ id: img.id, set: setId, extra: made });
        setError(
          `The crop was made, but not completely for: ${failed.join("; ")}`,
        );
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const ex = e.body?.existing;
        if (typeof ex === "number")
          setExisting({ id: ex, set: Number(choice) });
        setError("This region was cropped into that image set before.");
      } else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const byTeam = new Map<string, WritableSet[]>();
  for (const s of items)
    byTeam.set(s.team_name, [...(byTeam.get(s.team_name) ?? []), s]);

  return (
    <Modal title="Crop to new image" onClose={busy ? () => undefined : onClose}>
      <p>
        Save the region of this annotation, {region.w} × {region.h} px{size}, as
        a new image{frame > 0 ? ` (frame ${frame + 1})` : ""}.
      </p>
      {steps.length === 0 ? (
        <>
          <label className="field">
            <span>Target image set</span>
            <select
              value={choice}
              onChange={(e) => setTarget(e.target.value)}
              disabled={busy}
            >
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
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy}
                  maxLength={256}
                />
              </label>
              <label className="field">
                <span>Team</span>
                <select
                  value={team ?? ""}
                  onChange={(e) => setTeam(Number(e.target.value))}
                  disabled={busy}
                >
                  {(teams.data?.items ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="muted small">
                The new image set gets the annotation types (products) of this
                image's set.
              </p>
            </>
          )}
          {others.length > 0 && !done && (
            <div className="crop-others" data-testid="crop-others">
              <label className="check">
                <input
                  type="checkbox"
                  checked={withOthers}
                  onChange={(e) => setWithOthers(e.target.checked)}
                  disabled={busy}
                  data-testid="crop-with-registered"
                />
                Also crop the{" "}
                {others.length === 1 ? "image" : `${others.length} images`}{" "}
                registered with this one, at the same place
              </label>
              {withOthers && (
                <>
                  <ul className="plain-list">
                    {others.map((o) => (
                      <li key={o.id}>
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={!skip.has(o.id)}
                            disabled={busy}
                            onChange={(e) =>
                              setSkip((sk) => {
                                const n = new Set(sk);
                                if (e.target.checked) n.delete(o.id);
                                else n.add(o.id);
                                return n;
                              })
                            }
                          />
                          {o.name}{" "}
                          <span className="muted small">
                            ({o.region?.w} × {o.region?.h} px)
                          </span>
                        </label>
                        {!skip.has(o.id) && (
                          <div className="crop-target">
                            <select
                              value={targetOf(o.id)}
                              onChange={(e) =>
                                setTargets((t) => ({
                                  ...t,
                                  [o.id]: e.target.value,
                                }))
                              }
                              disabled={busy}
                              aria-label={`Image set for the crop of ${o.name}`}
                              data-testid={`crop-target-${o.id}`}
                            >
                              <option value={SAME}>
                                Image set: the same as above
                              </option>
                              {[...byTeam.entries()].map(([t, list]) => (
                                <optgroup key={t} label={t}>
                                  {list.map((st) => (
                                    <option key={st.id} value={st.id}>
                                      {st.name}
                                    </option>
                                  ))}
                                </optgroup>
                              ))}
                              <option value={NEW}>＋ New image set…</option>
                            </select>
                            {targetOf(o.id) === NEW && (
                              <input
                                value={nameOf(o.id)}
                                onChange={(e) =>
                                  setNewNames((n) => ({
                                    ...n,
                                    [o.id]: e.target.value,
                                  }))
                                }
                                disabled={busy}
                                maxLength={256}
                                aria-label={`Name of the new image set for ${o.name}`}
                                placeholder="Name of the new image set"
                              />
                            )}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </>
      ) : (
        <ol className="crop-steps" data-testid="crop-steps" aria-live="polite">
          {steps.map((st) => (
            <li key={st.key} className={st.state} data-state={st.state}>
              <span className="mark" aria-hidden="true">
                {st.state === "run" ? (
                  <span className="spinner" />
                ) : st.state === "ok" ? (
                  "✓"
                ) : st.state === "fail" ? (
                  "✗"
                ) : (
                  "○"
                )}
              </span>
              {st.label}
            </li>
          ))}
        </ol>
      )}
      {error && (
        <p className="error">
          {error}{" "}
          {existing && (
            <button
              className="btn"
              onClick={() => onDone(existing.id, existing.set)}
            >
              Open it
            </button>
          )}
        </p>
      )}
      <div className="modal-actions">
        {done ? (
          <button
            className="btn primary"
            onClick={() => onDone(done.id, done.set, done.extra)}
          >
            Close
          </button>
        ) : (
          <>
            <button className="btn ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            {steps.length > 0 && !busy && (
              <button
                className="btn"
                onClick={() => {
                  setSteps([]);
                  setError(null);
                  setExisting(null);
                }}
              >
                Back
              </button>
            )}
            {(steps.length === 0 || busy) && (
              <button
                className="btn primary"
                onClick={() => void run()}
                disabled={busy || sets.isLoading}
                data-testid="crop-run"
              >
                {busy
                  ? "Cropping…"
                  : chosenOthers.length
                    ? `Crop (${chosenOthers.length + 1} images)`
                    : "Crop"}
              </button>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
