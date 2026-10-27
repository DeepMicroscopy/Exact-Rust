import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, listAll } from "../api/client";
import type { ImageSet, ImageSummary } from "../api/types";
import { Thumb } from "../components/Thumb";

export function ImageSetPage() {
  const { setId } = useParams();
  const [search, setSearch] = useState("");
  const set = useQuery({ queryKey: ["image-set", setId], queryFn: () => api<ImageSet>(`/api/v2/image-sets/${setId}?fields=id,name,description,team`) });
  const images = useQuery({
    queryKey: ["images", setId],
    queryFn: () => listAll<ImageSummary>("/api/v2/images", { image_set: setId!, fields: "id,name,width,height,frames,depth,image_set" }),
  });
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (images.data ?? []).filter((i) => !q || i.name.toLowerCase().includes(q));
  }, [images.data, search]);

  return (
    <section className="main wide">
      <div className="crumbs">
        <Link to="/">Image sets</Link> / <span>{set.data?.name ?? "…"}</span>
      </div>
      <div className="toolbar">
        <h2>{set.data?.name}</h2>
        <span className="muted">{images.data ? `${images.data.length} images` : ""}</span>
        <span className="spacer" />
        <input className="search" placeholder="Filter images…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {set.data?.description && <p className="muted">{set.data.description}</p>}
      {images.isLoading && <p className="muted">Loading…</p>}
      {images.error && <p className="error">Could not load images.</p>}
      <div className="grid">
        {visible.map((i) => (
          <Link key={i.id} to={`/images/${i.id}`} className="tile glass">
            <Thumb imageId={i.id} alt={i.name} />
            <div className="tile-name" title={i.name}>
              {i.name}
            </div>
            <div className="muted small">
              {i.width}×{i.height}
              {i.frames > 1 ? ` · ${i.frames} frames` : ""}
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
