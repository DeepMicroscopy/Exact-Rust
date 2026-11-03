import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, listAll } from "../api/client";
import type { Product, SetImage, SetSettings, Tag } from "../api/types";
import { Dropdown } from "../components/Dropdown";
import { NameConflictDialog } from "../components/NameConflictDialog";
import { UploadTile } from "../components/UploadTile";
import { AnnotationCounts } from "../components/AnnotationCounts";
import { AuxFilesDialog } from "../components/AuxFilesDialog";
import { LinkSegmentationDialog, type LinkedFile } from "../components/LinkSegmentationDialog";
import { ConvertSegmentationDialog, isNrrdName } from "../components/ConvertSegmentationDialog";
import { SegmentationMenu, SegmentationTile, type SegmentationMenuModel } from "../components/SegmentationTile";
import { ExportDialog } from "../components/ExportDialog";
import { ManualRegistration } from "../components/ManualRegistration";
import { NewRegistrationDialog, RegistrationPanel } from "../components/Registrations";
import { ImageMenu, useMenuTrigger, type ImageMenuModel } from "../components/ImageMenu";
import { DeleteImagesDialog, DeleteSetDialog, MoveImagesDialog, SetSettingsDialog } from "../components/SetDialogs";
import { Thumb } from "../components/Thumb";
import { useUploads } from "../hooks/useUploads";

type Sort = "name" | "newest" | "size";
type Dialog = "export" | "files" | "settings" | "delete-set" | "move" | "delete-images" | "register" | null;

/** One image of the overview: select it, open it, or get its menu (right click, long press). */
function ImageTile({ image: i, selected, onToggle, onMenu, onNrrd }: { image: SetImage; selected: boolean; onToggle(): void; onMenu(x: number, y: number): void; /** the file is an NRRD segmentation: a click asks to convert it instead of opening a viewer that cannot show it */ onNrrd(): void }) {
  const trigger = useMenuTrigger(onMenu);
  return (
    <div className={`tile glass ${selected ? "selected" : ""}`} {...trigger}>
      <label className="tile-check" onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={selected} onChange={onToggle} aria-label={`Select ${i.name}`} />
      </label>
      <Link to={`/images/${i.id}`} className="tile-link" draggable={false} onClick={isNrrdName(i.name) ? (e) => { e.preventDefault(); onNrrd(); } : undefined}>
        <Thumb imageId={i.id} alt={i.name} />
        {isNrrdName(i.name) && <span className="badge seg-badge" title="A 3D Slicer segmentation: click to convert it to a segmentation file">▨ segmentation file?</span>}
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
  );
}

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
  const [manual, setManual] = useState<{ source: number; target: number; names: [string, string]; review?: boolean } | null>(null);
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
    void qc.invalidateQueries({ queryKey: ["annotation-counts", id] });
    void qc.invalidateQueries({ queryKey: ["set-settings", id] });
    void qc.invalidateQueries({ queryKey: ["image-sets"] });
    setSelected(new Set());
  }, [qc, id]);
  const existingNames = useCallback(() => (images.data ?? []).map((i) => i.name), [images.data]);
  const uploaded = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["images", id] });
    void qc.invalidateQueries({ queryKey: ["set-settings", id] });
    void qc.invalidateQueries({ queryKey: ["image-sets"] });
  }, [qc, id]);
  // a segmentation file that has arrived asks which volume it belongs to (the best name match is chosen); several wait in turn
  const [linkQueue, setLinkQueue] = useState<number[]>([]);
  const onSegmentation = useCallback((fileId: number) => setLinkQueue((q) => [...q, fileId]), []);
  const linkedFiles = useQuery({ queryKey: ["linked-set", id], queryFn: () => api<LinkedFile[]>(`/api/v2/image-sets/${id}/linked-volumes`) });
  const uploads = useUploads(id, uploaded, existingNames, onSegmentation);
  // a finished upload gives way to the real card as soon as the list has the image; a segmentation file has no card
  const shownUploads = uploads.items.filter((u) => u.segmentationId == null && !(u.state === "done" && u.imageId != null && (images.data ?? []).some((i) => i.id === u.imageId)));
  // ... and is dismissed for good then: it must not come back when the image is deleted later
  const { items: uploadItems, dismiss: dismissUpload } = uploads;
  useEffect(() => {
    for (const u of uploadItems) if (u.state === "done" && u.imageId != null && (images.data ?? []).some((i) => i.id === u.imageId)) dismissUpload(u.key);
  }, [uploadItems, images.data, dismissUpload]);

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
  // segmentation files are in the grid beside the images (filtered and sorted with them)
  const segFiles = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (linkedFiles.data ?? [])
      .filter((f) => !q || f.name.toLowerCase().includes(q))
      .sort(sort === "newest" ? (a, b) => b.time.localeCompare(a.time) : (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [linkedFiles.data, search, sort]);
  const cards = useMemo(() => {
    type Card = { key: string; name: string; time: string; image?: SetImage; file?: LinkedFile };
    const all: Card[] = [...visible.map((i) => ({ key: `i${i.id}`, name: i.name, time: i.time, image: i })), ...segFiles.map((f) => ({ key: `s${f.id}`, name: f.name, time: f.time, file: f }))];
    // images keep their order for "largest first" (files have no size in pixels and come last)
    if (sort === "name") all.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    else if (sort === "newest") all.sort((a, b) => b.time.localeCompare(a.time));
    return all;
  }, [visible, segFiles, sort]);
  const [segMenu, setSegMenu] = useState<SegmentationMenuModel | null>(null);
  const [linkOne, setLinkOne] = useState<number | null>(null);
  const [convert, setConvert] = useState<{ id: number; name: string } | null>(null);
  // `?link=<file>`: arriving after a conversion from the viewer page; the link dialog opens for the new file
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const l = Number(params.get("link"));
    if (l > 0) {
      setLinkOne(l);
      setParams({}, { replace: true });
    }
  }, [params, setParams]);
  const volumeNames = useMemo(() => new Map((images.data ?? []).map((i) => [i.id, i.name])), [images.data]);
  const segChanged = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["linked-set", id] });
    void qc.invalidateQueries({ queryKey: ["linked-image"] });
    void qc.invalidateQueries({ queryKey: ["related"] });
  }, [qc, id]);
  const openSeg = (f: LinkedFile) => (f.image != null ? navigate(`/images/${f.image}/planes?seg=${f.id}`) : setLinkOne(f.id));
  const chosen = useMemo(() => (images.data ?? []).filter((i) => selected.has(i.id)), [images.data, selected]);
  // the menu of an image; Move acts on the whole selection when the image is part of it, otherwise on this one image
  const [menu, setMenu] = useState<(ImageMenuModel & { image: SetImage }) | null>(null);
  const [moveList, setMoveList] = useState<SetImage[] | null>(null);
  const openMenu = (image: SetImage, x: number, y: number) => {
    const group = selected.has(image.id) && chosen.length > 1 ? chosen : [image];
    setMenu({ x, y, id: image.id, name: image.name, image, moveCount: group.length, canMove: !!can?.delete_images && !locked, moveWhy: locked ? "The image set is locked." : "You may not move images out of this image set." });
  };

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
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => {
                if (e.target.files) uploads.add(e.target.files);
                e.target.value = "";
              }} />
            <button className="btn primary" onClick={() => fileInput.current?.click()}>
              Upload images
            </button>
          </>
        )}
        {!!s?.auxiliary_file_count && can?.read && (
          <button className="btn" onClick={() => setDialog("files")}>
            Files ({s.auxiliary_file_count})
          </button>
        )}
        {can?.read && (
          <button className="btn" onClick={() => setDialog("export")}>
            Export
          </button>
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

      {tab === "images" && (
        <div className="set-layout">
        <div className="set-main">
          <div className="toolbar">
            <label className="check" title="Select all shown">
              <input type="checkbox" checked={allShown} onChange={() => setSelected(allShown ? new Set() : new Set(visible.map((i) => i.id)))} />
            </label>
            {chosen.length > 0 ? (
              <>
                <strong>{chosen.length} selected</strong>
                {can?.delete_images && !locked && (
                  <button
                    className="btn"
                    onClick={() => {
                      setMoveList(null);
                      setDialog("move");
                    }}
                  >
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
              <span className="muted small hide-narrow">Select images to move, delete or register them</span>
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
          {images.data && images.data.length === 0 && segFiles.length === 0 && shownUploads.length === 0 && (
            <div className="empty glass">
              <p>This image set is empty.</p>
              {canUpload ? <p className="muted">Drop image files here, or use “Upload images”. ZIP files are unpacked.</p> : <p className="muted">{locked ? "It is locked." : "You cannot add images to it."}</p>}
            </div>
          )}
          <div className="grid">
            {shownUploads.map((u) => (
              <UploadTile key={`u${u.key}`} item={u} onDismiss={() => uploads.dismiss(u.key)} />
            ))}
            {cards.map((c) =>
              c.image ? (
                <ImageTile key={c.key} image={c.image} selected={selected.has(c.image.id)} onToggle={() => toggle(c.image!.id)} onMenu={(x, y) => openMenu(c.image!, x, y)} onNrrd={() => setConvert(c.image!)} />
              ) : (
                <SegmentationTile key={c.key} file={c.file!} volumeName={c.file!.image == null ? null : (volumeNames.get(c.file!.image) ?? null)} onOpen={() => openSeg(c.file!)} onMenu={(x, y) => setSegMenu({ x, y, file: c.file!, canEdit: !!can?.edit_set })} />
              ),
            )}
          </div>
        </div>
        <AnnotationCounts setId={id} />
        </div>
      )}
      {tab === "registration" && (
        <RegistrationPanel
          images={images.data ?? []}
          canEdit={!!can?.edit_set}
          onManual={(source, target, review) => setManual({ source, target, review, names: [images.data?.find((i) => i.id === source)?.name ?? `image ${source}`, images.data?.find((i) => i.id === target)?.name ?? `image ${target}`] })}
          onNew={() => {
            setRegPair({});
            setDialog("register");
          }}
        />
      )}

      {uploads.conflict && <NameConflictDialog key={uploads.conflict.file.name + uploads.conflict.suggestion} conflict={uploads.conflict} onResolve={uploads.resolve} />}
      {dragging && <div className="drop-hint">Drop the files to upload them</div>}
      {dialog === "settings" && s && <SetSettingsDialog settings={s} onClose={() => setDialog(null)} onSaved={refresh} />}
      {dialog === "files" && <AuxFilesDialog setId={id} onChanged={refresh} onClose={() => setDialog(null)} />}
      {segMenu && (
        <SegmentationMenu
          model={segMenu}
          onClose={() => setSegMenu(null)}
          onOpen={() => openSeg(segMenu.file)}
          onLink={() => setLinkOne(segMenu.file.id)}
          onUnlink={() => void act(() => api(`/api/v2/linked-volumes/${segMenu.file.id}`, { method: "PUT", json: { image: null } }), segChanged)}
          onDelete={() => {
            if (window.confirm(`Delete ${segMenu.file.filename}?`)) void act(() => api(`/api/v2/linked-volumes/${segMenu.file.id}`, { method: "DELETE" }), segChanged);
          }}
        />
      )}
      {convert && (
        <ConvertSegmentationDialog
          image={convert}
          onClose={() => setConvert(null)}
          onConverted={(file) => {
            setConvert(null);
            refresh();
            segChanged();
            setLinkOne(file.id); // the next step: which volume it belongs to
          }}
        />
      )}
      {linkOne != null && <LinkSegmentationDialog key={`one${linkOne}`} id={linkOne} onClose={() => setLinkOne(null)} onChanged={segChanged} onLinked={(image) => navigate(`/images/${image}/planes?seg=${linkOne}`)} />}
      {linkQueue.length > 0 && <LinkSegmentationDialog key={linkQueue[0]} id={linkQueue[0]} onClose={() => setLinkQueue((q) => q.slice(1))} onChanged={segChanged} />}
      {dialog === "export" && <ExportDialog setId={id} canCreate={!!can?.create_export} canDelete={!!can?.edit_set} onClose={() => setDialog(null)} />}
      {dialog === "delete-set" && s && <DeleteSetDialog settings={s} onClose={() => setDialog(null)} onDeleted={() => navigate("/", { replace: true })} />}
      {menu && (
        <ImageMenu
          model={menu}
          onClose={() => setMenu(null)}
          onConvert={isNrrdName(menu.name) ? () => setConvert({ id: menu.id, name: menu.name }) : undefined}
          onMove={() => {
            setMoveList(menu.moveCount > 1 ? chosen : [menu.image]);
            setMenu(null);
            setDialog("move");
          }}
        />
      )}
      {dialog === "move" && <MoveImagesDialog images={moveList ?? chosen} from={id} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === "delete-images" && <DeleteImagesDialog images={chosen} segFiles={(linkedFiles.data ?? []).filter((f) => f.image != null && chosen.some((i) => i.id === f.image))} onClose={() => setDialog(null)} onDone={() => { refresh(); segChanged(); }} />}
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
