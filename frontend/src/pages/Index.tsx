import { useEffect, useMemo, useRef, useState } from "react";
import { SearchInput } from "../components/SearchInput";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, listAll } from "../api/client";
import type { Page } from "../api/client";
import { NewSetDialog } from "../components/SetDialogs";
import type { ImageSet, Team } from "../api/types";
import { StatisticsDialog } from "../components/StatisticsDialog";
import { Thumb } from "../components/Thumb";
import { useAuth } from "../auth/AuthContext";

const LAST_TEAM = "exact.team";
/** An empty strip below the list: when it scrolls into view the next cards are asked for (like the endless feeds of social media). */
function ScrollEnd({ onReach }: { onReach(): void }) {
  const el = useRef<HTMLDivElement>(null);
  const reach = useRef(onReach);
  reach.current = onReach;
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && reach.current(), { rootMargin: "600px" });
    io.observe(node);
    return () => io.disconnect();
  }, []);
  return <div ref={el} className="scroll-end" data-testid="scroll-end" aria-hidden="true" />;
}

const PAGE = 48; // cards drawn at first (each is a thumbnail that may have to be rendered); scrolling to the end of the list adds this many

/** A team is always selected (the last one used, else the first): only its image sets are loaded and drawn. The search covers all teams. */
export function Index() {
  const [teamId, setTeamId] = useState<number | null>(null);
  const [stats, setStats] = useState(false);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const navigate = useNavigate();
  const { user } = useAuth();
  const teams = useQuery({ queryKey: ["teams"], queryFn: () => listAll<Team>("/api/v2/teams", { fields: "id,name" }) });
  useEffect(() => {
    if (!teams.data?.length || (teamId !== null && teams.data.some((t) => t.id === teamId))) return;
    let last = NaN;
    try {
      last = Number(localStorage.getItem(LAST_TEAM));
    } catch {
      /* no storage: the first team */
    }
    setTeamId((teams.data.find((t) => t.id === last) ?? teams.data[0]).id);
  }, [teams.data, teamId]);
  const pickTeam = (id: number) => {
    setTeamId(id);
    setShown(PAGE);
    try {
      localStorage.setItem(LAST_TEAM, String(id));
    } catch {
      /* remembering is a convenience */
    }
  };
  // names only, for all teams: enough for the search and for naming the sets of image hits
  const index = useQuery({
    queryKey: ["image-sets", "index"],
    queryFn: () => listAll<Pick<ImageSet, "id" | "name" | "description" | "team">>("/api/v2/image-sets", { fields: "id,name,description,team" }),
  });

  const q = search.trim();
  useEffect(() => setShown(PAGE), [q]);
  // the search covers images as well (after a pause in typing)
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const found = useQuery({
    queryKey: ["search-images", debounced],
    enabled: debounced.length >= 2,
    queryFn: () => api<Page<{ id: number; name: string; image_set: number }>>(`/api/v2/images?name__icontains=${encodeURIComponent(debounced)}&fields=id,name,image_set&limit=60&count=true`),
  });
  const matches = useMemo(() => {
    const lq = q.toLowerCase();
    return lq ? (index.data ?? []).filter((s) => s.name.toLowerCase().includes(lq) || (s.description ?? "").toLowerCase().includes(lq)) : [];
  }, [index.data, q]);
  const shownIds = matches.slice(0, shown).map((s) => s.id);
  // the cards (with the image lists for the thumbnails): the selected team's sets, or what the search found
  const cardsKey = q ? ["image-sets", "found", q, shownIds.join(",")] : ["image-sets", "team", teamId];
  const cards = useQuery({
    queryKey: cardsKey,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[1] === cardsKey[1] && prevQuery?.queryKey[2] === cardsKey[2] ? prev : undefined), // more cards load as the list is scrolled: the ones shown stay meanwhile
    enabled: q ? index.data !== undefined : teamId !== null,
    queryFn: () =>
      listAll<ImageSet>("/api/v2/image-sets", {
        fields: "id,name,description,team,images",
        // `__in` takes one comma-separated value (a repeated parameter would keep only the last id: one card for any number of matches)
        ...(q ? { id__in: shownIds.join(",") } : { team: teamId! }),
      }),
  });
  const visible = q && shownIds.length === 0 ? [] : (cards.data ?? []);
  const setName = (id: number) => index.data?.find((s) => s.id === id)?.name ?? `set ${id}`;
  const hits = q.length >= 2 ? (found.data?.items ?? []) : [];
  const teamName = (id: number) => teams.data?.find((t) => t.id === id)?.name ?? "";

  return (
    <div className="two-col">
      <aside className="sidebar teams-aside">
        <div className="sidebar-title">Teams</div>
        {teams.data?.map((t) => (
          <button key={t.id} className={`side-item ${teamId === t.id ? "active" : ""}`} onClick={() => pickTeam(t.id)} aria-pressed={teamId === t.id}>
            {t.name}
          </button>
        ))}
      </aside>
      <section className="main">
        <select className="team-select" value={teamId ?? ""} onChange={(e) => pickTeam(Number(e.target.value))} aria-label="Team">
          {teams.data?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <div className="toolbar pinned">
          <span className="spacer" />
          <SearchInput history="index" className="search" placeholder="Search all teams…" aria-label="Search" value={search} onChange={setSearch} />
          {teamId !== null && (
            <button className="btn" onClick={() => setStats(true)}>
              Statistics
            </button>
          )}
          <button className="btn primary" onClick={() => setCreating(true)} disabled={!teams.data?.length || !!user?.read_only} title={user?.read_only ? "This account is read only" : undefined}>
            New image set
          </button>
        </div>
        {(cards.isLoading || index.isLoading) && <p className="muted">Loading…</p>}
        {(cards.error || index.error) && <p className="error">Could not load image sets.</p>}
        <div className="cards">
          {visible.slice(0, shown).map((s) => (
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
        {(q ? matches.length : visible.length) > shown && <ScrollEnd key={shown} onReach={() => setShown((n) => n + PAGE)} />}
        {cards.data && !cards.isFetching && visible.length === 0 && hits.length === 0 && !found.isFetching && <p className="muted">{q ? "Nothing found." : "This team has no image sets yet."}</p>}
        {q.length >= 2 && hits.length > 0 && (
          <>
            <h3>Images</h3>
            {(found.data?.count ?? 0) > hits.length && (
              <p className="muted small" data-testid="image-hits-more">
                Showing the first {hits.length} of {found.data?.count?.toLocaleString("en-US")} images: a longer part of the name narrows it down.
              </p>
            )}
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
