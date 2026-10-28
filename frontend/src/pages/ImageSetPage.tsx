import { useCallback, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, listAll } from "../api/client";
import type { Product, SetImage, SetSettings, Tag } from "../api/types";
import { Dropdown } from "../components/Dropdown";
import { ManualRegistration } from "../components/ManualRegistration";
import { NewRegistrationDialog, RegistrationPanel } from "../components/Registrations";
import { DeleteImagesDialog, DeleteSetDialog, MoveImagesDialog, SetSettingsDialog } from "../components/SetDialogs";
import { Thumb } from "../components/Thumb";
import { useUploads } from "../hooks/useUploads";

type Sort = "name" | "newest" | "size";
type Dialog = "settings" | "delete-set" | "move" | "delete-images" | "register" | null;

const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);

export function ImageSetPage() {
  const id = Number(useParams().setId);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<"images" | "registration">("images");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("name");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dialog, setDialog] = useState<Dialog>(null);
  const [regPair, setRegPair] = useState<{ source?: number; target?: number }>({});
  const [manual, setManual] = useState<{ source: number; target: number; names: [string, string] } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [newTag, setNewTag] = useState("");
  const [error, setError] = useState<string | null>(null);

  const settings = useQuery({ queryKey: ["set-settings", id], queryFn: () => api<SetSettings>(`/api/v2/image-sets/${id}/settings`) });
  const meta = useQuery({
    queryKey: ["set-meta", id],
    queryFn: () => api<{ set_tags: Tag[]; product_set: Product[] }>(`/api/v2/image-sets/${id}?fields=id,set_tags,product_set&expand=set_tags,product_set`),
  });
  const allProducts = useQuery({ queryKey: ["products"], queryFn: () => listAll<Product>("/api/v2/products", { fields: "id,name,team" }) });
  const images = useQuery({
    queryKey: ["images", id],
    queryFn: () => listAll<SetImage>("/api/v2/images", { image_set: id, fields: "id,name,width,height,mpp,frames,image_set,time,crop_source" }),
  });
  const can = settings.data?.permissions;
  const locked = settings.data?.image_lock ?? false;

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["images", id] });
    void qc.invalidateQueries({ queryKey: ["set-settings", id] });
    void qc.invalidateQueries({ queryKey: ["image-sets"] });
    setSelected(new Set());
  }, [qc, id]);
  const uploads = useUploads(id, refresh);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (images.data ?? []).filter((i) => !q || i.name.toLowerCase().includes(q));
    const by: Record<Sort, (a: SetImage, b: SetImage) => number> = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
      newest: (a, b) => b.time.localeCompare(a.time),
      size: (a, b) => b.width * b.height - a.width * a.height,
    };
    return [...list].sort(by[sort]);
  }, [images.data, search, sort]);
  const chosen = useMemo(() => (images.data ?? []).filter((i) => selected.has(i.id)), [images.data, selected]);

  const toggle = (imageId: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(imageId)) n.delete(imageId);
      else n.add(imageId);
      return n;
    });
  const allShown = visible.length > 0 && visible.every((i) => selected.has(i.id));

  const act = async (fn: () => Promise<unknown>, done: () => void) => {
    setError(null);
    try {
      await fn();
      done();
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    }
  };
  const addTag = () => {
    const name = newTag.trim();
    if (!name) return;
    void act(() => api(`/api/v2/image-sets/${id}/tags`, { json: { name } }), () => {
      setNewTag("");
      void qc.invalidateQueries({ queryKey: ["set-meta", id] });
    });
  };
  const removeTag = (name: string) => act(() => api(`/api/v2/image-sets/${id}/tags/${encodeURIComponent(name)}`, { method: "DELETE" }), () => void qc.invalidateQueries({ queryKey: ["set-meta", id] }));
  const addProduct = (pid: number) => act(() => api(`/api/v2/image-sets/${id}/products/${pid}`, { method: "PUT" }), () => void qc.invalidateQueries({ queryKey: ["set-meta", id] }));
  const removeProduct = (pid: number) => act(() => api(`/api/v2/image-sets/${id}/products/${pid}`, { method: "DELETE" }), () => void qc.invalidateQueries({ queryKey: ["set-meta", id] }));

  const canUpload = !!can?.edit_set && !locked;
  const s = settings.data;
  const ownProducts = new Set((meta.data?.product_set ?? []).map((p) => p.id));
  const addable = (allProducts.data ?? []).filter((p) => !ownProducts.has(p.id) && p.team === s?.team).map((p) => ({ id: p.id, label: p.name }));

  return (
    <section
      className={`main wide ${dragging ? "dragging" : ""}`}
      onDragOver={(e) => {
        if (canUpload && e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        setDragging(false);
        if (canUpload && e.dataTransfer.files.length) {
          e.preventDefault();
          uploads.add(e.dataTransfer.files);
        }
      }}
    >
      <div className="crumbs">
        <Link to="/">Image sets</Link> / <span>{s?.name ?? "…"}</span>
      </div>
      <div className="toolbar">
        <h2>{s?.name}</h2>
        {s?.image_lock && <span className="badge locked" title="Locked: no uploads, no deleting or moving of images">🔒 locked</span>}
        {s?.public && <span className="badge">public</span>}
        <span className="muted">{s ? `${s.image_count} image${s.image_count === 1 ? "" : "s"}` : ""}{s?.team_name ? ` · ${s.team_name}` : ""}</span>
        <span className="spacer" />
        {canUpload && (
          <>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && uploads.add(e.target.files)} />
            <button className="btn primary" onClick={() => fileInput.current?.click()}>
              Upload images
            </button>
          </>
        )}
        {can?.edit_set && (
          <button className="btn" onClick={() => setDialog("settings")}>
            Settings
          </button>
        )}
        {can?.delete_set && (
          <Dropdown items={[{ id: "delete", label: "Delete image set…" }]} onPick={() => setDialog("delete-set")} title="More">
            More
          </Dropdown>
        )}
      </div>
      {s?.description && <p className="muted">{s.description}</p>}
      {error && (
        <p className="error" onClick={() => setError(null)}>
          {error}
        </p>
      )}

      <div className="meta-row">
        <span className="meta-label">Tags</span>
        {(meta.data?.set_tags ?? []).map((t) => (
          <span key={t.id} className="tag">
            {t.name}
            {can?.edit_set && (
              <button aria-label={`Remove ${t.name}`} onClick={() => void removeTag(t.name)}>
                ✕
              </button>
            )}
          </span>
        ))}
        {can?.edit_set && (
          <input className="tag-input" placeholder="add a tag…" value={newTag} onChange={(e) => setNewTag(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTag()} maxLength={100} />
        )}
        <span className="meta-label gap">Products</span>
        {(meta.data?.product_set ?? []).map((p) => (
          <span key={p.id} className="tag product" title="Annotation types of this product are offered in the image set">
            {p.name}
            {can?.edit_set && (
              <button aria-label={`Remove ${p.name}`} onClick={() => void removeProduct(p.id)}>
                ✕
              </button>
            )}
          </span>
        ))}
        {can?.edit_set && addable.length > 0 && (
          <Dropdown items={addable} onPick={(pid) => void addProduct(Number(pid))} title="Add a product">
            + product
          </Dropdown>
        )}
      </div>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "images"} className={tab === "images" ? "active" : ""} onClick={() => setTab("images")}>
          Images
        </button>
        <button role="tab" aria-selected={tab === "registration"} className={tab === "registration" ? "active" : ""} onClick={() => setTab("registration")}>
          Registration
        </button>
      </div>

      {uploads.items.length > 0 && (
        <div className="uploads glass">
          <div className="toolbar">
            <strong>Uploads</strong>
            <span className="spacer" />
            <button className="btn ghost small" onClick={uploads.clear} disabled={uploads.busy && uploads.items.every((i) => i.state !== "done" && i.state !== "error")}>
              Clear finished
            </button>
          </div>
          {uploads.items.map((u) => (
            <div key={u.key} className={`upload ${u.state}`}>
              <span className="name" title={u.name}>
                {u.name}
              </span>
              <span className="muted small">{fmtBytes(u.size)}</span>
              {u.state === "error" ? (
                <span className="error small">{u.message}</span>
              ) : (
                <progress max={1} value={u.state === "processing" ? undefined : u.progress} />
              )}
              <span className="small">{u.state === "done" ? "✓" : u.state === "processing" ? "reading…" : u.state === "waiting" ? "waiting" : ""}</span>
            </div>
          ))}
        </div>
      )}

      {tab === "images" && (
        <>
          <div className="toolbar">
            <label className="check" title="Select all shown">
              <input type="checkbox" checked={allShown} onChange={() => setSelected(allShown ? new Set() : new Set(visible.map((i) => i.id)))} />
            </label>
            {chosen.length > 0 ? (
              <>
                <strong>{chosen.length} selected</strong>
                {can?.delete_images && !locked && (
                  <button className="btn" onClick={() => setDialog("move")}>
                    Move…
                  </button>
                )}
                {can?.delete_images && !locked && (
                  <button className="btn danger" onClick={() => setDialog("delete-images")}>
                    Delete…
                  </button>
                )}
                {can?.edit_set && chosen.length === 2 && (
                  <button
                    className="btn"
                    onClick={() => {
                      setRegPair({ source: chosen[0].id, target: chosen[1].id });
                      setDialog("register");
                    }}
                  >
                    Register these two…
                  </button>
                )}
                <button className="btn ghost" onClick={() => setSelected(new Set())}>
                  Clear
                </button>
              </>
            ) : (
              <span className="muted small">Select images to move, delete or register them</span>
            )}
            <span className="spacer" />
            <select className="search" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort">
              <option value="name">Name</option>
              <option value="newest">Newest first</option>
              <option value="size">Largest first</option>
            </select>
            <input className="search" placeholder="Filter images…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {images.isLoading && <p className="muted">Loading…</p>}
          {images.error && <p className="error">Could not load images.</p>}
          {images.data && images.data.length === 0 && (
            <div className="empty glass">
              <p>This image set is empty.</p>
              {canUpload ? <p className="muted">Drop image files here, or use “Upload images”. ZIP files are unpacked.</p> : <p className="muted">{locked ? "It is locked." : "You cannot add images to it."}</p>}
            </div>
          )}
          <div className="grid">
            {visible.map((i) => (
              <div key={i.id} className={`tile glass ${selected.has(i.id) ? "selected" : ""}`}>
                <label className="tile-check" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={selected.has(i.id)} onChange={() => toggle(i.id)} aria-label={`Select ${i.name}`} />
                </label>
                <Link to={`/images/${i.id}`} className="tile-link">
                  <Thumb imageId={i.id} alt={i.name} />
                  <div className="tile-name" title={i.name}>
                    {i.name}
                  </div>
                  <div className="muted small">
                    {i.width.toLocaleString("en-US")}×{i.height.toLocaleString("en-US")}
                    {i.frames > 1 ? ` · ${i.frames} frames` : ""}
                    {i.crop_source != null ? " · crop" : ""}
                  </div>
                </Link>
              </div>
            ))}
          </div>
        </>
      )}
      {tab === "registration" && (
        <RegistrationPanel
          images={images.data ?? []}
          canEdit={!!can?.edit_set}
          onManual={(source, target) => setManual({ source, target, names: [images.data?.find((i) => i.id === source)?.name ?? `image ${source}`, images.data?.find((i) => i.id === target)?.name ?? `image ${target}`] })}
          onNew={() => {
            setRegPair({});
            setDialog("register");
          }}
        />
      )}

      {dragging && <div className="drop-hint">Drop the files to upload them</div>}
      {dialog === "settings" && s && <SetSettingsDialog settings={s} onClose={() => setDialog(null)} onSaved={refresh} />}
      {dialog === "delete-set" && s && <DeleteSetDialog settings={s} onClose={() => setDialog(null)} onDeleted={() => navigate("/", { replace: true })} />}
      {dialog === "move" && <MoveImagesDialog images={chosen} from={id} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === "delete-images" && <DeleteImagesDialog images={chosen} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === "register" && images.data && (
        <NewRegistrationDialog
          images={images.data}
          setId={id}
          onManual={(s, t) => setManual({ source: s.id, target: t.id, names: [s.name, t.name] })}
          source={regPair.source}
          target={regPair.target}
          onClose={() => setDialog(null)}
          onStarted={() => {
            setTab("registration");
            void qc.invalidateQueries({ queryKey: ["registration-jobs"] });
          }}
        />
      )}
      {manual && (
        <ManualRegistration
          {...manual}
          onClose={() => setManual(null)}
          onSaved={() => {
            void qc.invalidateQueries({ queryKey: ["registrations"] });
            void qc.invalidateQueries({ queryKey: ["overlay-registrations"] });
          }}
        />
      )}
    </section>
  );
}
