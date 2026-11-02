import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";

interface TypeCount {
  id: number;
  name: string;
  color: string;
  count: number;
  images: number;
}

/** The side list of the image-set overview: every annotation type of the set with its number of annotations (its support). */
export function AnnotationCounts({ setId }: { setId: number }) {
  const counts = useQuery({
    queryKey: ["annotation-counts", setId],
    queryFn: () => api<{ items: TypeCount[] }>(`/api/v2/image-sets/${setId}/annotation-counts`),
  });
  const items = [...(counts.data?.items ?? [])].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (counts.isLoading || items.length === 0) return null;
  const total = items.reduce((n, t) => n + t.count, 0);
  return (
    <aside className="anno-counts glass" aria-label="Annotations in this image set" data-testid="annotation-counts">
      <div className="sidebar-title">Annotations</div>
      <ul>
        {items.map((t) => (
          <li key={t.id} className={t.count === 0 ? "none" : ""} title={`${t.count.toLocaleString("en-US")} annotations in ${t.images.toLocaleString("en-US")} images`}>
            <i style={{ background: t.color }} />
            <span className="name">{t.name}</span>
            <span className="n">{t.count.toLocaleString("en-US")}</span>
          </li>
        ))}
      </ul>
      <div className="total">
        <span>Total</span>
        <span className="n">{total.toLocaleString("en-US")}</span>
      </div>
    </aside>
  );
}
