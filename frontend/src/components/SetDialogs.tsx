import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, listAll } from "../api/client";
import type { AnnotationType, Product, SetImage, SetSettings } from "../api/types";
import { Modal } from "./Modal";

const message = (e: unknown) => (e instanceof ApiError && e.body?.errors ? Object.values(e.body.errors as Record<string, string[]>).flat().join(" ") : e instanceof Error ? e.message : String(e));

/** Name, description and flags of an image set. */
export function SetSettingsDialog({ settings, onClose, onSaved }: { settings: SetSettings; onClose(): void; onSaved(): void }) {
  const [form, setForm] = useState({
    name: settings.name,
    description: settings.description ?? "",
    location: settings.location ?? "",
    public: settings.public,
    public_collaboration: settings.public_collaboration,
    image_lock: settings.image_lock,
    collaboration_type: settings.collaboration_type,
    main_annotation_type: settings.main_annotation_type,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const types = useQuery({ queryKey: ["annotation-types-brief"], queryFn: () => listAll<AnnotationType>("/api/v2/annotation-types", { fields: "id,name,vector_type,product" }) });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/v2/image-sets/${settings.id}`, { method: "PATCH", json: { ...form, description: form.description || null, location: form.location || null } });
      onSaved();
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Image set settings" onClose={onClose}>
      <label className="field">
        <span>Name</span>
        <input value={form.name} onChange={(e) => set("name", e.target.value)} maxLength={256} />
      </label>
      <label className="field">
        <span>Description</span>
        <textarea value={form.description} onChange={(e) => set("description", e.target.value)} rows={3} maxLength={1000} />
      </label>
      <label className="field">
        <span>Location</span>
        <input value={form.location} onChange={(e) => set("location", e.target.value)} maxLength={256} />
      </label>
      <label className="field">
        <span>Main annotation type</span>
        <select value={form.main_annotation_type ?? ""} onChange={(e) => set("main_annotation_type", e.target.value ? Number(e.target.value) : null)}>
          <option value="">none</option>
          {(types.data ?? []).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Annotation mode</span>
        <select value={form.collaboration_type} onChange={(e) => set("collaboration_type", Number(e.target.value))}>
          <option value={0}>Collaborative: everybody sees all annotations</option>
          <option value={1}>Competitive: everybody sees only their own</option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={form.image_lock} onChange={(e) => set("image_lock", e.target.checked)} /> Lock the image set (no uploads, no deleting or moving of images)
      </label>
      <label className="check">
        <input type="checkbox" checked={form.public} onChange={(e) => set("public", e.target.checked)} /> Public: everybody who is signed in can look at it
      </label>
      <label className="check">
        <input type="checkbox" checked={form.public_collaboration} onChange={(e) => set("public_collaboration", e.target.checked)} disabled={!form.public} /> …and annotate in it
      </label>
      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => void save()} disabled={busy || !form.name.trim()}>
          Save
        </button>
      </div>
    </Modal>
  );
}

/** Deleting a set removes its images, annotations and files: the name has to be typed. */
export function DeleteSetDialog({ settings, onClose, onDeleted }: { settings: SetSettings; onClose(): void; onDeleted(): void }) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    try {
      await api(`/api/v2/image-sets/${settings.id}`, { method: "DELETE" });
      onDeleted();
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  return (
    <Modal title="Delete image set?" onClose={onClose}>
      <p>
        This deletes <strong>{settings.name}</strong> with its {settings.image_count} image{settings.image_count === 1 ? "" : "s"}, all annotations on them and the files. It cannot be undone.
      </p>
      <label className="field">
        <span>Type the name of the image set to confirm</span>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={settings.name} />
      </label>
      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn danger" disabled={busy || typed !== settings.name} onClick={() => void go()}>
          Delete image set
        </button>
      </div>
    </Modal>
  );
}

interface Result {
  image: SetImage;
  ok: boolean;
  text: string;
}

/** Moves the selected images (rows, files and annotations) to another image set; shows what each answered. */
export function MoveImagesDialog({ images: chosen, from, onClose, onDone }: { images: SetImage[]; from: number; onClose(): void; onDone(): void }) {
  const [images] = useState(chosen); // the selection is cleared when the page refreshes; the dialog keeps its own list
  const sets = useQuery({ queryKey: ["writable-sets"], queryFn: () => api<{ items: { id: number; name: string; team_name: string }[] }>("/api/v2/image-sets/writable"), staleTime: 0, refetchOnMount: "always" });
  const [target, setTarget] = useState<string>("");
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState(false);
  const options = (sets.data?.items ?? []).filter((s) => s.id !== from);
  const choice = target || (options[0] ? String(options[0].id) : "");
  const go = async () => {
    setBusy(true);
    const out: Result[] = [];
    for (const image of images) {
      try {
        await api(`/api/v2/images/${image.id}/move`, { json: { image_set: Number(choice) } });
        out.push({ image, ok: true, text: "moved" });
      } catch (e) {
        out.push({ image, ok: false, text: message(e) });
      }
      setResults([...out]);
    }
    setBusy(false);
    onDone();
  };
  const finished = results && results.length === images.length;
  return (
    <Modal title={`Move ${images.length} image${images.length === 1 ? "" : "s"}`} onClose={busy ? () => undefined : onClose}>
      {!results && (
        <>
          <label className="field">
            <span>Target image set</span>
            <select value={choice} onChange={(e) => setTarget(e.target.value)}>
              {options.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.team_name} / {s.name}
                </option>
              ))}
            </select>
          </label>
          <p className="muted small">The files and their annotations move along. The target needs the annotation types the images use.</p>
        </>
      )}
      {results && (
        <ul className="results">
          {results.map((r) => (
            <li key={r.image.id} className={r.ok ? "ok" : "bad"}>
              <span>{r.ok ? "✓" : "✕"}</span> <span className="name">{r.image.name}</span> <span className="muted small">{r.text}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose} disabled={busy}>
          {finished ? "Close" : "Cancel"}
        </button>
        {!results && (
          <button className="btn primary" onClick={() => void go()} disabled={!choice || busy}>
            Move
          </button>
        )}
      </div>
    </Modal>
  );
}

/** Deleting images removes their files and annotations. */
export function DeleteImagesDialog({ images: chosen, onClose, onDone }: { images: SetImage[]; onClose(): void; onDone(): void }) {
  const [images] = useState(chosen);
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    const out: Result[] = [];
    for (const image of images) {
      try {
        await api(`/api/v2/images/${image.id}`, { method: "DELETE" });
        out.push({ image, ok: true, text: "deleted" });
      } catch (e) {
        out.push({ image, ok: false, text: message(e) });
      }
      setResults([...out]);
    }
    setBusy(false);
    onDone();
  };
  return (
    <Modal title={`Delete ${images.length} image${images.length === 1 ? "" : "s"}?`} onClose={busy ? () => undefined : onClose}>
      {!results ? (
        <>
          <p>The images, their annotations and the files are deleted. This cannot be undone.</p>
          <ul className="results">
            {images.slice(0, 8).map((i) => (
              <li key={i.id}>{i.name}</li>
            ))}
            {images.length > 8 && <li className="muted">… and {images.length - 8} more</li>}
          </ul>
        </>
      ) : (
        <ul className="results">
          {results.map((r) => (
            <li key={r.image.id} className={r.ok ? "ok" : "bad"}>
              <span>{r.ok ? "✓" : "✕"}</span> <span className="name">{r.image.name}</span> <span className="muted small">{r.text}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose} disabled={busy}>
          {results && results.length === images.length ? "Close" : "Cancel"}
        </button>
        {!results && (
          <button className="btn danger" onClick={() => void go()}>
            Delete
          </button>
        )}
      </div>
    </Modal>
  );
}

/** New image set: name, team, and the products (annotation types) it offers. */
export function NewSetDialog({ teams, defaultTeam, onClose, onCreated }: { teams: { id: number; name: string }[]; defaultTeam: number | null; onClose(): void; onCreated(id: number): void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [team, setTeam] = useState<number | null>(defaultTeam ?? teams[0]?.id ?? null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const products = useQuery({ queryKey: ["products"], queryFn: () => listAll<Product>("/api/v2/products", { fields: "id,name,team" }) });
  const mine = (products.data ?? []).filter((p) => p.team === team);
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await api<{ id: number }>("/api/v2/image-sets", { json: { name: name.trim(), team, products: [...picked].filter((id) => mine.some((p) => p.id === id)) } });
      await qc.invalidateQueries({ queryKey: ["image-sets"] });
      onCreated(made.id);
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  return (
    <Modal title="New image set" onClose={onClose}>
      <label className="field">
        <span>Name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={256} autoFocus />
      </label>
      <label className="field">
        <span>Team</span>
        <select value={team ?? ""} onChange={(e) => setTeam(Number(e.target.value))}>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <div className="field">
        <span>Products (the annotation types it offers)</span>
        {mine.length === 0 && <span className="muted small">The team has no products yet.</span>}
        {mine.map((p) => (
          <label key={p.id} className="check">
            <input
              type="checkbox"
              checked={picked.has(p.id)}
              onChange={(e) =>
                setPicked((s) => {
                  const n = new Set(s);
                  if (e.target.checked) n.add(p.id);
                  else n.delete(p.id);
                  return n;
                })
              }
            />{" "}
            {p.name}
          </label>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn primary" onClick={() => void create()} disabled={busy || !name.trim() || team == null}>
          Create
        </button>
      </div>
    </Modal>
  );
}
