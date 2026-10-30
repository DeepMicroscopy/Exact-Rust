import { useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { Modal } from "./Modal";

/** Opened from the top bar: "What's new" shows the greeting again. */
export const OPEN_WELCOME = "exact:whatsnew";

interface Welcome {
  show: boolean;
  notice: string | null;
}

// ---- pictograms: one line weight, one rounded style, drawn on a 48 x 48 grid ----------------------------------------------------------------
function Pictogram({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <svg className="wp-icon" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {children}
    </svg>
  );
}
const Laptop = () => (
  <Pictogram label="Computer">
    <rect x="9" y="10" width="30" height="21" rx="2.5" />
    <path d="M4 37h40l-3 -6H7z" />
  </Pictogram>
);
const Tablet = () => (
  <Pictogram label="Tablet">
    <rect x="6" y="9" width="36" height="30" rx="4" />
    <circle cx="39" cy="24" r="1.3" fill="currentColor" />
  </Pictogram>
);
const Phone = () => (
  <Pictogram label="Phone">
    <rect x="17" y="6" width="14" height="36" rx="3.5" />
    <path d="M22 37h4" />
  </Pictogram>
);
const Pencil = () => (
  <Pictogram label="Apple Pencil">
    <path d="M10 38l2-8L33 9l6 6-21 21z" />
    <path d="M28 14l6 6" />
    <path d="M10 38l8-2" />
  </Pictogram>
);
const Select = () => (
  <Pictogram>
    <path d="M13 8v27l7-6 5 11 5-2-5-11h9z" />
  </Pictogram>
);
const Brush = () => (
  <Pictogram>
    <path d="M10 30l4-16 14 4 10 8-6 12-16 2z" strokeDasharray="3 4" />
    <circle cx="30" cy="22" r="7" />
  </Pictogram>
);
const OneClick = () => (
  <Pictogram>
    <rect x="9" y="12" width="20" height="20" rx="2" strokeDasharray="3 4" />
    <path d="M27 24v16l4-3 3 6 3-1.5-3-6h5z" />
  </Pictogram>
);
const Planes = () => (
  <Pictogram>
    <rect x="6" y="6" width="17" height="17" rx="2" />
    <rect x="25" y="6" width="17" height="17" rx="2" />
    <rect x="6" y="25" width="17" height="17" rx="2" />
    <path d="M33.5 28v11M28 33.5h11" />
  </Pictogram>
);

// ---- the pages -------------------------------------------------------------------------------------------------------------------------------

/** How much shorter the waits are, measured on a copy of the production data (old EXACT against this server): each pair of bars is one request. */
function SpeedBars() {
  const rows: { label: string; fast: number; times: string }[] = [
    { label: "Lists for scripts and exact-sync", fast: 6, times: "up to 16×" },
    { label: "Lists in the browser", fast: 30, times: "2–5×" },
    { label: "Slides and tiles", fast: 45, times: "about 2×" },
  ];
  return (
    <div className="wp-bars" aria-label="Waiting times, old EXACT against the new one">
      {rows.map((r) => (
        <div key={r.label} className="wp-bar-row">
          <div className="wp-bar-label">{r.label}</div>
          <div className="wp-bar-pair" aria-hidden>
            <span className="wp-bar old" />
            <span className="wp-bar new" style={{ width: `${r.fast}%` }} />
          </div>
          <div className="wp-times">{r.times}</div>
        </div>
      ))}
      <div className="wp-legend">
        <span><i className="wp-dot old" /> before</span>
        <span><i className="wp-dot new" /> now</span>
      </div>
    </div>
  );
}

const PAGES: { id: string; title: string; text: ReactNode; art: ReactNode }[] = [
  {
    id: "speed",
    title: "Much faster",
    text: "Lists, images and slides open in a fraction of the time. Same account, same data.",
    art: <SpeedBars />,
  },
  {
    id: "devices",
    title: "On every device",
    text: "Annotate on a computer or an iPad, look at slides on your phone: one account, the same annotations everywhere.",
    art: (
      <div className="wp-art-row">
        <Laptop />
        <Tablet />
        <Phone />
      </div>
    ),
  },
  {
    id: "pencil",
    title: "Made for the Apple Pencil",
    text: "Paint polygons like with a brush. One tap switches between adding and subtracting; your finger moves and zooms the image.",
    art: (
      <div className="wp-art-row">
        <Tablet />
        <Pencil />
        <div className="wp-round-buttons" aria-hidden>
          <span className="add">+</span>
          <span className="sub">−</span>
        </div>
      </div>
    ),
  },
  {
    id: "annotate",
    title: "Annotating, made easy",
    text: (
      <div className="wp-tiles">
        <div><Select /><span>Click to select and edit</span></div>
        <div><Brush /><span>Brush polygons</span></div>
        <div><OneClick /><span>One click, one box</span></div>
        <div><Planes /><span>CT and MRI in three planes</span></div>
      </div>
    ),
    art: null,
  },
];

function Greeting({ notice, onClose }: { notice: string | null; onClose: () => void }) {
  const [page, setPage] = useState(0);
  const last = page === PAGES.length - 1;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setPage((p) => Math.min(p + 1, PAGES.length - 1));
      else if (e.key === "ArrowLeft") setPage((p) => Math.max(p - 1, 0));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const p = PAGES[page];
  return (
    <Modal title="Welcome to the new EXACT" onClose={onClose} className="welcome-modal">
      <div data-testid="welcome" data-page={p.id}>
        {notice && page === 0 && (
          <p className="welcome-notice" role="note" data-testid="welcome-notice">
            {notice}
          </p>
        )}
        <div className="wp-page" key={p.id}>
          {p.art && <div className="wp-art">{p.art}</div>}
          <h3 className="wp-title">{p.title}</h3>
          {typeof p.text === "string" ? <p className="wp-text">{p.text}</p> : p.text}
        </div>
        <div className="wp-footer">
          <div className="wp-dots" role="tablist" aria-label="Pages">
            {PAGES.map((q, i) => (
              <button key={q.id} role="tab" aria-selected={i === page} aria-label={`Page ${i + 1}: ${q.title}`} className={`wp-dot-btn ${i === page ? "on" : ""}`} onClick={() => setPage(i)} data-testid={`welcome-dot-${i}`} />
            ))}
          </div>
          <div className="wp-nav">
            {page > 0 && (
              <button className="btn ghost" onClick={() => setPage(page - 1)} data-testid="welcome-back">
                Back
              </button>
            )}
            {!last && (
              <button className="btn ghost" onClick={onClose} data-testid="welcome-close" title="Close; What's new in the top bar shows this again">
                Skip
              </button>
            )}
            {last ? (
              <button className="btn primary" onClick={onClose} data-testid="welcome-close">
                Got it
              </button>
            ) : (
              <button className="btn primary" onClick={() => setPage(page + 1)} data-testid="welcome-next">
                Next
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The greeting for people who have not been on this server before: a few short pages on what is better than the EXACT they know. It appears
 * once after the first login (the server remembers per user that it was shown); "What's new" in the top bar opens it again. Closing it, in any
 * way, counts as seen.
 */
export function WelcomeGate() {
  const qc = useQueryClient();
  const welcome = useQuery({ queryKey: ["welcome"], queryFn: () => api<Welcome>("/api/v2/welcome"), staleTime: Infinity, retry: false });
  const [open, setOpen] = useState(false);
  const [shownOnce, setShownOnce] = useState(false);
  useEffect(() => {
    if (welcome.data?.show && !shownOnce) {
      setShownOnce(true);
      setOpen(true);
    }
  }, [welcome.data, shownOnce]);
  useEffect(() => {
    const again = () => setOpen(true);
    window.addEventListener(OPEN_WELCOME, again);
    return () => window.removeEventListener(OPEN_WELCOME, again);
  }, []);
  if (!open) return null;
  const close = () => {
    setOpen(false);
    if (welcome.data?.show) {
      void api("/api/v2/welcome/seen", { method: "POST" }).catch(() => undefined);
      qc.setQueryData<Welcome>(["welcome"], { ...welcome.data, show: false });
    }
  };
  return <Greeting notice={welcome.data?.notice ?? null} onClose={close} />;
}
