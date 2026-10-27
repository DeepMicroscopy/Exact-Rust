import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { listAll } from "../api/client";
import type { ImageSet, Team } from "../api/types";
import { Thumb } from "../components/Thumb";

export function Index() {
  const [teamId, setTeamId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const teams = useQuery({ queryKey: ["teams"], queryFn: () => listAll<Team>("/api/v2/teams", { fields: "id,name" }) });
  const sets = useQuery({
    queryKey: ["image-sets"],
    queryFn: () => listAll<ImageSet>("/api/v2/image-sets", { fields: "id,name,description,team,images" }),
  });

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (sets.data ?? []).filter((s) => (teamId === null || s.team === teamId) && (!q || s.name.toLowerCase().includes(q)));
  }, [sets.data, teamId, search]);
  const teamName = (id: number) => teams.data?.find((t) => t.id === id)?.name ?? "";

  return (
    <div className="two-col">
      <aside className="sidebar">
        <div className="sidebar-title">Teams</div>
        <button className={`side-item ${teamId === null ? "active" : ""}`} onClick={() => setTeamId(null)}>
          All image sets
        </button>
        {teams.data?.map((t) => (
          <button key={t.id} className={`side-item ${teamId === t.id ? "active" : ""}`} onClick={() => setTeamId(t.id)}>
            {t.name}
          </button>
        ))}
      </aside>
      <section className="main">
        <div className="toolbar">
          <h2>Image sets</h2>
          <input className="search" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {sets.isLoading && <p className="muted">Loading…</p>}
        {sets.error && <p className="error">Could not load image sets.</p>}
        <div className="cards">
          {visible.map((s) => (
            <Link key={s.id} to={`/sets/${s.id}`} className="card glass">
              <Thumb imageId={s.images[0]} alt={s.name} />
              <div className="card-body">
                <div className="card-title">{s.name}</div>
                <div className="muted small">
                  {s.images.length} image{s.images.length === 1 ? "" : "s"} · {teamName(s.team)}
                </div>
              </div>
            </Link>
          ))}
        </div>
        {sets.data && visible.length === 0 && <p className="muted">No image sets found.</p>}
      </section>
    </div>
  );
}
