import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, listAll } from "../api/client";
import { Modal } from "./Modal";
import { DeleteTypeDialog } from "./DeleteTypeDialog";

export interface ProductPerms {
  add_product?: boolean;
  change_product?: boolean;
  delete_product?: boolean;
  add_annotationtype?: boolean;
  change_annotationtype?: boolean;
  delete_annotationtype?: boolean;
}

interface Product {
  id: number;
  name: string;
  description: string | null;
  team: number | null;
}
interface TeamRow {
  id: number;
  name: string;
}
interface AType {
  id: number;
  name: string;
  active: boolean;
  vector_type: number;
  node_count: number;
  color_code: string;
  sort_order: number;
  enable_blurred: boolean;
  enable_concealed: boolean;
  multi_frame: boolean;
  default_width: number;
  default_height: number;
  size_unit: string;
  closed: boolean;
  area_hit_test: boolean;
  /** segmentation types with the same group name exclude each other on a volume: no voxel is in two of them */
  seg_group: string | null;
  /** annotations (not deleted) of this type */
  annotation_count: number;
}

/** The message of an error; a validation error names its fields ("name: A name is required."). */
const msg = (e: unknown) => {
  if (e instanceof ApiError) {
    const errors = e.body?.errors;
    if (errors && typeof errors === "object") {
      const parts = Object.entries(errors as Record<string, unknown>).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(" ") : String(v)}`);
      if (parts.length) return parts.join(" · ");
    }
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
};

export const SHAPES: { id: number; label: string }[] = [
  { id: 1, label: "Bounding box" },
  { id: 2, label: "Point" },
  { id: 3, label: "Line" },
  { id: 4, label: "Multi line" },
  { id: 5, label: "Polygon" },
  { id: 6, label: "Fixed size box" },
  { id: 7, label: "Global (whole image)" },
  { id: 8, label: "Segmentation mask" },
];
const shapeName = (v: number) => SHAPES.find((s) => s.id === v)?.label ?? String(v);

/** Products (the sets of annotation types an image set is annotated with) and their annotation types. */
export function ProductsTab({ perms }: { perms: ProductPerms }) {
  const qc = useQueryClient();
  const products = useQuery({ queryKey: ["admin-products"], queryFn: () => listAll<Product>("/api/v2/products", { fields: "id,name,description,team" }), staleTime: 0 });
  const teams = useQuery({ queryKey: ["admin-teams"], queryFn: () => listAll<TeamRow>("/api/v2/teams", { fields: "id,name" }), staleTime: 0 });
  const [picked, setPicked] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const teamName = (id: number | null) => teams.data?.find((t) => t.id === id)?.name ?? "";
  const list = useMemo(() => [...(products.data ?? [])].sort((a, b) => teamName(a.team).localeCompare(teamName(b.team)) || a.name.localeCompare(b.name)), [products.data, teams.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = picked != null ? (list.find((p) => p.id === picked) ?? null) : (list[0] ?? null); // a product just created is not in the list until it is fetched
  // the tree: teams (alphabetically), their products below; a team can be folded, the choice is remembered
  const tree = useMemo(() => {
    const groups = new Map<string, { key: string; name: string; products: Product[] }>();
    for (const p of list) {
      const key = String(p.team ?? "none");
      if (!groups.has(key)) groups.set(key, { key, name: p.team == null ? "No team" : teamName(p.team) || `Team ${p.team}`, products: [] });
      groups.get(key)!.products.push(p);
    }
    return [...groups.values()];
  }, [list, teams.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const [closed, setClosed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("exact.productTree.closed") ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (key: string) =>
    setClosed((cur) => {
      const n = new Set(cur);
      if (!n.delete(key)) n.add(key);
      try {
        localStorage.setItem("exact.productTree.closed", JSON.stringify([...n]));
      } catch {
        /* private mode */
      }
      return n;
    });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["admin-products"] });
  return (
    <div className="two-col">
      <aside className="sidebar">
        <div className="sidebar-title">Products</div>
        <ul className="tree" role="tree" data-testid="product-tree">
          {tree.map((g) => {
            const open = !closed.has(g.key);
            return (
              <li key={g.key} role="treeitem" aria-expanded={open} data-testid="tree-team">
                <button className="tree-node" onClick={() => toggle(g.key)} aria-label={`${open ? "Collapse" : "Expand"} ${g.name}`}>
                  <span className="tree-caret" aria-hidden>{open ? "▾" : "▸"}</span> {g.name} <span className="muted small">{g.products.length}</span>
                </button>
                {open && (
                  <ul role="group">
                    {g.products.map((p) => (
                      <li key={p.id} role="treeitem">
                        <button className={`side-item tree-leaf ${current?.id === p.id ? "active" : ""}`} onClick={() => setPicked(p.id)} title={g.name} aria-selected={current?.id === p.id}>
                          {p.name}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
        {perms.add_product && (
          <button className="btn small" onClick={() => setCreating(true)} style={{ marginTop: 8 }}>
            New product…
          </button>
        )}
      </aside>
      <div className="admin-main">
        {current ? <ProductPanel key={current.id} product={current} teams={teams.data ?? []} perms={perms} onChanged={refresh} onGone={() => { setPicked(null); refresh(); }} /> : <p className="muted">{picked != null ? "Loading…" : "No product."}</p>}
      </div>
      {creating && <ProductDialog teams={teams.data ?? []} products={list} onClose={() => setCreating(false)} onSaved={(id) => { setPicked(id); refresh(); }} />}
    </div>
  );
}

function ProductPanel({ product, teams, perms, onChanged, onGone }: { product: Product; teams: TeamRow[]; perms: ProductPerms; onChanged(): void; onGone(): void }) {
  const qc = useQueryClient();
  const types = useQuery({ queryKey: ["admin-types", product.id], queryFn: async () => (await api<{ items: AType[] }>(`/api/v2/products/${product.id}/annotation-types`)).items, staleTime: 0 });
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AType | "new" | null>(null);
  const [editProduct, setEditProduct] = useState(false);
  const reload = () => void qc.invalidateQueries({ queryKey: ["admin-types", product.id] });
  const [deleting, setDeleting] = useState<{ id: number; name: string } | null>(null);
  const run = (fn: () => Promise<unknown>, after: () => void) =>
    void fn().then(
      () => {
        setError(null);
        after();
      },
      (e) => setError(msg(e)),
    );
  const rows = [...(types.data ?? [])].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  const canEdit = !!perms.change_annotationtype;
  return (
    <div data-testid="product-panel">
      {deleting && <DeleteTypeDialog type={deleting} onClose={() => setDeleting(null)} onDone={() => { setDeleting(null); setError(null); reload(); }} />}
      <div className="toolbar">
        <h3>{product.name}</h3>
        <span className="muted small">{teams.find((t) => t.id === product.team)?.name}</span>
        <span className="muted small" title="The product's ID, as the API uses it">
          ID {product.id}
        </span>
        <span className="spacer" />
        {perms.change_product && (
          <button className="btn small" onClick={() => setEditProduct(true)}>
            Edit product…
          </button>
        )}
        {perms.delete_product && (
          <button
            className="btn ghost small danger"
            onClick={() => window.confirm(`Delete the product ${product.name} and all its annotation types?`) && run(() => api(`/api/v2/products/${product.id}`, { method: "DELETE" }), onGone)}
          >
            Delete product
          </button>
        )}
      </div>
      {product.description && <p className="muted">{product.description}</p>}
      {error && <p className="error">{error}</p>}
      <table className="admin-table" data-testid="types">
        <thead>
          <tr>
            <th />
            <th title="The annotation type's ID, as the API uses it">ID</th>
            <th>Annotation type</th>
            <th>Shape</th>
            <th>Used</th>
            <th>Order</th>
            <th>Active</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id} className={t.active ? "" : "inactive"}>
              <td>
                <span className="swatch" style={{ background: t.color_code }} />
              </td>
              <td className="muted small" data-testid="type-id">{t.id}</td>
              <td>{t.name}</td>
              <td className="muted small">{shapeName(t.vector_type)}{t.seg_group ? <span className="group-tag" data-testid="type-group" title="The masks of the types in this group exclude each other"> ⛓ {t.seg_group}</span> : null}</td>
              <td className="muted small">{t.annotation_count}</td>
              <td className="muted small">{t.sort_order}</td>
              <td>
                <input type="checkbox" checked={t.active} disabled={!canEdit} onChange={(e) => run(() => api(`/api/v2/annotation-types/${t.id}`, { method: "PATCH", json: { active: e.target.checked } }), reload)} aria-label={`${t.name} is active`} />
              </td>
              <td className="row-actions">
                {canEdit && (
                  <button className="btn ghost small" onClick={() => setEditing(t)}>
                    Edit
                  </button>
                )}
                {perms.delete_annotationtype && (
                  <button className="btn ghost small danger" onClick={() => setDeleting({ id: t.id, name: t.name })} data-testid="type-delete">
                    Delete
                  </button>
                )}
              </td>
            </tr>
          ))}
          {types.data && rows.length === 0 && (
            <tr>
              <td colSpan={8} className="muted">
                This product has no annotation types yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {perms.add_annotationtype && (
        <button className="btn" onClick={() => setEditing("new")}>
          New annotation type…
        </button>
      )}
      {editing && <TypeDialog productId={product.id} groups={[...new Set(rows.map((t) => t.seg_group).filter((g): g is string => !!g))]} type={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={reload} />}
      {editProduct && <ProductDialog product={product} teams={teams} products={[]} onClose={() => setEditProduct(false)} onSaved={onChanged} />}
    </div>
  );
}

function ProductDialog({ product, teams, products, onClose, onSaved }: { product?: Product; teams: TeamRow[]; products: Product[]; onClose(): void; onSaved(id: number): void }) {
  const [name, setName] = useState(product?.name ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [team, setTeam] = useState<number | null>(product?.team ?? teams[0]?.id ?? null);
  const [copy, setCopy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = () => {
    setBusy(true);
    const body = { name: name.trim(), description, team, ...(product ? {} : { copy_product: copy || undefined }) };
    const req = product ? api<{ id: number }>(`/api/v2/products/${product.id}`, { method: "PATCH", json: body }) : api<{ id: number }>("/api/v2/products", { json: body });
    req.then(
      (r) => {
        onSaved(r.id ?? product?.id ?? 0);
        onClose();
      },
      (e) => {
        setError(msg(e));
        setBusy(false);
      },
    );
  };
  return (
    <Modal title={product ? "Edit product" : "New product"} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Product name" autoFocus />
        </label>
        <label className="field">
          <span>Description</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} aria-label="Product description" />
        </label>
        <label className="field">
          <span>Team</span>
          <select value={team ?? ""} onChange={(e) => setTeam(e.target.value ? Number(e.target.value) : null)} aria-label="Product team">
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {!product && products.length > 0 && (
          <label className="field">
            <span>Start with the annotation types of</span>
            <select value={copy} onChange={(e) => setCopy(Number(e.target.value))} aria-label="Copy types from">
              <option value={0}>(none)</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({teams.find((t) => t.id === p.team)?.name})
                </option>
              ))}
            </select>
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !name.trim() || team == null}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

const DEFAULT: Omit<AType, "id" | "annotation_count"> = { name: "", active: true, vector_type: 1, node_count: 0, color_code: "#cc4444", sort_order: 0, enable_blurred: true, enable_concealed: true, multi_frame: false, default_width: 50, default_height: 50, size_unit: "px", closed: true, area_hit_test: true, seg_group: null };

/** The fields of an annotation type that matter for a shape (the others stay at their defaults). */
export function fieldsFor(shape: number) {
  return {
    size: [1, 2, 6].includes(shape),
    nodes: [4, 5].includes(shape),
    closed: [4, 5].includes(shape),
    area: [1, 5, 6].includes(shape),
    flags: shape !== 7 && shape !== 8,
  };
}

function TypeDialog({ productId, groups, type, onClose, onSaved }: { productId: number; groups: string[]; type: AType | null; onClose(): void; onSaved(): void }) {
  const [f, setF] = useState<Omit<AType, "id" | "annotation_count">>(type ? { ...type } : DEFAULT);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((cur) => ({ ...cur, [k]: v }));
  const show = fieldsFor(f.vector_type);
  const save = () => {
    setBusy(true);
    const body = { ...f, name: f.name.trim(), product: productId };
    (type ? api(`/api/v2/annotation-types/${type.id}`, { method: "PATCH", json: body }) : api("/api/v2/annotation-types", { json: body })).then(
      () => {
        onSaved();
        onClose();
      },
      (e) => {
        setError(msg(e));
        setBusy(false);
      },
    );
  };
  const check = (label: string, k: "active" | "closed" | "area_hit_test" | "enable_blurred" | "enable_concealed" | "multi_frame", hint?: string) => (
    <label className="check" title={hint}>
      <input type="checkbox" checked={f[k]} onChange={(e) => set(k, e.target.checked)} aria-label={label} /> {label}
    </label>
  );
  return (
    <Modal title={type ? `Edit ${type.name}` : "New annotation type"} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="field-row">
          <label className="field grow">
            <span>Name</span>
            <input value={f.name} onChange={(e) => set("name", e.target.value)} aria-label="Type name" maxLength={50} autoFocus />
          </label>
          <label className="field">
            <span>Colour</span>
            <input type="color" value={/^#[0-9a-f]{6}$/i.test(f.color_code) ? f.color_code : "#cc4444"} onChange={(e) => set("color_code", e.target.value)} aria-label="Type colour" />
          </label>
        </div>
        <div className="field-row">
          <label className="field grow">
            <span>Shape</span>
            <select value={f.vector_type} onChange={(e) => set("vector_type", Number(e.target.value))} aria-label="Type shape">
              {SHAPES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Order</span>
            <input type="number" value={f.sort_order} onChange={(e) => set("sort_order", Number(e.target.value))} aria-label="Type order" style={{ width: 80 }} />
          </label>
        </div>
        {type && <p className="muted small">The shape of a type that annotations already use cannot be changed.</p>}
        {show.size && (
          <div className="field-row">
            <label className="field">
              <span>Default width</span>
              <input type="number" min={0} step="any" value={f.default_width} onChange={(e) => set("default_width", Number(e.target.value))} aria-label="Default width" style={{ width: 100 }} />
            </label>
            <label className="field">
              <span>Default height</span>
              <input type="number" min={0} step="any" value={f.default_height} onChange={(e) => set("default_height", Number(e.target.value))} aria-label="Default height" style={{ width: 100 }} />
            </label>
            <label className="field">
              <span>Unit</span>
              <select value={f.size_unit} onChange={(e) => set("size_unit", e.target.value)} aria-label="Size unit">
                <option value="px">px</option>
                <option value="mm">mm</option>
                <option value="um">µm</option>
              </select>
            </label>
          </div>
        )}
        {show.nodes && (
          <label className="field">
            <span>Required number of points (0 = any)</span>
            <input type="number" min={0} value={f.node_count} onChange={(e) => set("node_count", Number(e.target.value))} aria-label="Node count" style={{ width: 100 }} />
          </label>
        )}
        {f.vector_type === 8 && (
          <label className="field">
            <span>Group (optional)</span>
            <input list="seg-groups" value={f.seg_group ?? ""} onChange={(e) => set("seg_group", e.target.value.slice(0, 50) || null)} aria-label="Group" data-testid="type-group-input" placeholder="e.g. organs" maxLength={50} />
            <datalist id="seg-groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
            <small className="muted">Segmentation types of one product with the same group exclude each other: no voxel of a volume can be in two of them. Leave empty for none.</small>
          </label>
        )}
        <div className="checks">
          {check("Active", "active", "Inactive types are hidden when annotating; existing annotations stay")}
          {show.closed && check("Closed", "closed")}
          {show.area && check("Area hit test", "area_hit_test", "A click inside the shape selects it, not only one on its outline")}
          {show.flags && check("Blurred flag", "enable_blurred")}
          {show.flags && check("Concealed flag", "enable_concealed")}
          {f.vector_type !== 8 && check("Multi frame", "multi_frame", "One annotation of this type spans several frames of a stack")}
        </div>
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !f.name.trim()}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
