import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, listAll } from "../api/client";
import type { Page } from "../api/client";
import { NewSetDialog } from "../components/SetDialogs";
import type { ImageSet, Team } from "../api/types";
import { StatisticsDialog } from "../components/StatisticsDialog";
import { Thumb } from "../components/Thumb";

export function Index() {
  const [teamId, setTeamId] = useState<number | null>(null);
  const [stats, setStats] = useState(false);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const teams = useQuery({ queryKey: ["teams"], queryFn: () => listAll<Team>("/api/v2/teams", { fields: "id,name" }) });
  const sets = useQuery({
    queryKey: ["image-sets"],
    queryFn: () => listAll<ImageSet>("/api/v2/image-sets", { fields: "id,name,description,team,images" }),
  });

  const q = search.trim();
  // the search covers images as well (after a pause in typing)
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const found = useQuery({
    queryKey: ["search-images", debounced],
    enabled: debounced.length >= 2,
    queryFn: () => api<Page<{ id: number; name: string; image_set: number }>>(`/api/v2/images?name__icontains=${encodeURIComponent(debounced)}&fields=id,name,image_set&limit=60`),
  });
  const visible = useMemo(() => {
    const lq = q.toLowerCase();
    return (sets.data ?? []).filter((s) => (teamId === null || s.team === teamId) && (!lq || s.name.toLowerCase().includes(lq) || (s.description ?? "").toLowerCase().includes(lq)));
  }, [sets.data, teamId, q]);
  const setName = (id: number) => sets.data?.find((s) => s.id === id)?.name ?? `set ${id}`;
  const hits = q.length >= 2 ? (found.data?.items ?? []).filter((i) => teamId === null || sets.data?.find((s) => s.id === i.image_set)?.team === teamId) : [];
  const teamName = (id: number) => teams.data?.find((t) => t.id === id)?.name ?? "";

  return (
    <div className="two-col">
      <aside className="sidebar">
        <div className="sidebar-title">Teams</div>
        {teams.data?.map((t) => (
          <button key={t.id} className={`side-item ${teamId === t.id ? "active" : ""}`} onClick={() => setTeamId(teamId === t.id ? null : t.id)} aria-pressed={teamId === t.id} title={teamId === t.id ? "Show the image sets of all teams" : undefined}>
            {t.name}
          </button>
        ))}
      </aside>
      <section className="main">
        <div className="toolbar">
          <h2>Image sets</h2>
          <span className="spacer" />
          <input className="search" placeholder="Search image sets and images…" aria-label="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
          {teamId !== null && (
            <button className="btn" onClick={() => setStats(true)}>
              Statistics
            </button>
          )}
          <button className="btn primary" onClick={() => setCreating(true)} disabled={!teams.data?.length}>
            New image set
          </button>
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
        {sets.data && visible.length === 0 && hits.length === 0 && !found.isFetching && <p className="muted">Nothing found.</p>}
        {q.length >= 2 && hits.length > 0 && (
          <>
            <h3>Images</h3>
            <div className="cards" data-testid="image-hits">
              {hits.map((i) => (
                <Link key={i.id} to={`/images/${i.id}`} className="card glass">
                  <Thumb imageId={i.id} alt={i.name} />
                  <div className="card-body">
                    <div className="card-title">{i.name}</div>
                    <div className="muted small">{setName(i.image_set)}</div>
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
      </section>
      {stats && teamId !== null && <StatisticsDialog teamId={teamId} teamName={teamName(teamId)} onClose={() => setStats(false)} />}
      {creating && teams.data && <NewSetDialog teams={teams.data} defaultTeam={teamId} onClose={() => setCreating(false)} onCreated={(id) => navigate(`/sets/${id}`)} />}
    </div>
  );
}
