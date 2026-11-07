from svgkit import *


def system_overview():
    b = text(30, 30, "EXACT-Rust: who talks to whom", "h")
    # clients
    clients = [("Browser", "React · TypeScript · OpenSeadragon", "core"),
               ("exact-sync · notebooks", "Python client, /api/v1 (unchanged)", "box"),
               ("Queue worker", "registration · image analysis (Python)", "ext"),
               ("Segmentation worker", "masks for volumes (Python)", "ext")]
    ys = [70, 160, 250, 340]
    for (t, s, c), y in zip(clients, ys):
        b += box(30, y, 230, 64, t, s, c)
    # server
    b += f'<rect x="340" y="46" width="330" height="436" rx="12" class="core" fill-opacity="0.35"/>'
    b += text(505, 70, "exact-server: one Rust binary", "h c")
    inner = [("Front end", "the built React app (static files)"), ("/api/v2", "the interface of the new UI"),
             ("/api/v1 + legacy", "compatible with EXACT (exact-sync)"), ("Slides and tiles", "readers, DeepZoom, crop, repair"),
             ("Authentication", "passwords, tokens, sessions, passkeys"), ("Job queue", "atomic claim of registration / analysis jobs")]
    for i, (t, s) in enumerate(inner):
        b += box(360, 86 + i * 64, 290, 54, t, s, "box")
    # backends
    b += box(760, 60, 210, 96, "PostgreSQL", "EXACT's own tables", "plus exact_rust_* (additive)", "db")
    b += box(760, 176, 210, 70, "Image store", "IMAGE_PATH: slides, pyramids", "db")
    b += box(760, 266, 210, 70, "Cache", "EXACT_CACHE_DIR: thumbnails", "db")
    b += box(760, 356, 210, 110, "Helper processes", "slideio: CZI, VSI, DICOM", "registration helper (quad trees)", "ext")
    # EXACT django
    b += f'<rect x="340" y="500" width="330" height="62" rx="10" class="ext dash" fill-opacity="0.5"/>'
    b += text(505, 526, "EXACT (Django): optional, unchanged", "h c") + text(505, 546, "the same database and the same image store", "m c")
    # lines + packets
    paths = []
    for i, y in enumerate(ys):
        pid = f"c{i}"
        paths.append((pid, f"M260 {y + 32} L340 {y + 32}", [PAL["blue"], PAL["amber"], PAL["violet"], PAL["violet"]][i]))
    for pid, d, col in paths:
        b += path(pid, d)
    for i, (y, ty) in enumerate([(108, 108), (210, 210), (301, 301), (411, 411)]):
        b += path(f"s{i}", f"M670 {y} L760 {ty}")
    b += path("dj1", "M670 531 L990 531 L990 108 L970 108", "line dash") + path("dj2", "M990 211 L970 211", "line dash")
    for i, (pid, d, col) in enumerate(paths):
        b += packet(pid, 2.2, i * 0.55, col)
    for i in range(4):
        b += packet(f"s{i}", 2.0, 0.3 + i * 0.5, PAL["teal"] if i < 3 else PAL["violet"])
    b += packet("dj1", 4.0, 0.2, PAL["grey"], 4)
    b += text(30, 440, "HTTP + JSON, session cookie, Basic or token", "m")
    b += text(30, 460, "Workers read the image files themselves", "m")
    svg("system-overview.svg", 1010, 580, b, "System overview",
        "Browser, exact-sync and workers talk HTTP to the exact-server binary, which uses PostgreSQL, the image store, a thumbnail cache and helper processes; an unchanged Django EXACT can share the database and the image store.")


def crates():
    b = text(30, 30, "Crates and what depends on what (arrows point to the dependency)", "h")
    rows = [
        (70, [(40, 400, "exact-server", "the binary: configuration, router,", "static files, migrations at start", "core"),
              (460, 400, "exact-cli", "migrate · schema-check · repair-image ·", "precompute-offsets · audit-passkeys", "core")]),
        (170, [(40, 820, "exact-api", "HTTP layer: compat/ (v1 + legacy) · v2/ · slides · upload · repair · job queue", "box")]),
        (270, [(40, 250, "exact-db", "queries · additive migrations", "sessions · invitations · passkeys", "db"),
               (325, 250, "exact-auth", "all Django password hash formats", "tokens · WebAuthn", "db"),
               (610, 250, "exact-wsi", "readers · DeepZoom · TIFF writer", "repair · level registration", "db")]),
        (360, [(40, 820, "exact-core", "configuration with EXACT's environment variable names · error types", "warn")]),
    ]
    ids = []
    for y, items in rows:
        for it in items:
            x, w, t, c = it[0], it[1], it[2], it[-1]
            subs = it[3:-1]
            b += box(x, y, w, 62, t, *subs, c)
    # connectors
    for x in (240, 650):
        b += path(f"a{x}", f"M{x} 132 L{x} 170", marker=False)
    b += path("api1", "M165 226 L165 270") + path("api2", "M450 226 L450 270") + path("api3", "M735 226 L735 270")
    b += path("d1", "M165 326 L165 360") + path("d2", "M450 326 L450 360") + path("d3", "M735 326 L735 360")
    b += text(450, 150, "the cli also uses db, auth and wsi directly", "m", text_anchor="start")
    # pulse from the bottom up: each row lights up in turn
    labels = [(360, 0.0), (270, 1.4), (170, 2.8), (70, 4.2)]
    for y, t0 in labels:
        b += (f'<rect x="32" y="{y - 6}" width="836" height="68" rx="12" fill="none" stroke="{PAL["blue"]}" stroke-width="2" opacity="0" class="anim">'
              + window(t0, t0 + 1.4, 7.0, 0.04) + "</rect>")
    b += text(40, 440, "Threads: tokio's runtime (one worker per core); slide decoding on the blocking pool; 2-4 OpenSlide handles per open slide.", "m")
    svg("crates.svg", 900, 460, b, "Crate layers", "exact-core at the bottom; exact-db, exact-auth and exact-wsi above it; exact-api above those; exact-server and exact-cli on top.")


def tile_pipeline():
    b = text(30, 30, "One tile, from the click to the pixels", "h")
    steps = [("OpenSeadragon", "asks tile_files/", "{level}/{col}_{row}", "core"),
             ("Authenticate", "session, Basic or token", "team check", "box"),
             ("Slide handle", "from the cache, or opened", "(format by magic number)", "box"),
             ("Read region", "best pyramid level,", "on the blocking pool", "db"),
             ("DeepZoom", "scale, crop,", "pad the edge", "db"),
             ("Encode", "JPEG or PNG,", "max-age 24 h, private", "box")]
    x0, w, gap = 20, 148, 16
    xs = [x0 + i * (w + gap) for i in range(6)]
    for x, st in zip(xs, steps):
        b += box(x, 110, w, 92, st[0], *st[1:])
    for i in range(5):
        b += path(f"t{i}", f"M{xs[i] + w} 156 L{xs[i + 1]} 156")
    # return path
    b += path("ret", f"M{xs[5] + w / 2} 202 L{xs[5] + w / 2} 270 L{xs[0] + w / 2} 270 L{xs[0] + w / 2} 202")
    b += text((xs[0] + xs[5]) / 2 + w / 2, 292, "the tile travels back as the response", "m c")
    # cache hit shortcut
    b += path("hit", f"M{xs[2] + w / 2} 110 L{xs[2] + w / 2} 70 L{xs[5] + w / 2} 70 L{xs[5] + w / 2} 110", "line dash")
    b += text((xs[2] + xs[5]) / 2 + w / 2, 62, "the browser already has it (max-age): no request at all", "m c")
    # a moving tile packet along the whole route
    full = "M" + f"{xs[0] + w / 2} 156 " + " ".join(f"L{xs[i] + w / 2} 156" for i in range(1, 6)) + f" L{xs[5] + w / 2} 270 L{xs[0] + w / 2} 270 L{xs[0] + w / 2} 202"
    b += f'<path id="full" d="{full}" fill="none" stroke="none"/>'
    b += (f'<rect width="16" height="16" rx="3" fill="{PAL["amber"]}" class="anim" x="-8" y="-8"><animateMotion dur="7s" repeatCount="indefinite"><mpath xlink:href="#full" href="#full"/></animateMotion></rect>')
    # highlight each step as the tile passes (approximate timing: 7s loop over route length)
    lens = [0] + [xs[i + 1] - xs[i] for i in range(5)]
    total = sum(lens[1:]) + (270 - 156) * 2 + (xs[5] - xs[0]) + 0
    acc = 0
    for i in range(6):
        t = (acc / total) * 7.0
        b += (f'<rect x="{xs[i]}" y="110" width="{w}" height="92" rx="8" fill="none" stroke="{PAL["amber"]}" stroke-width="2.5" opacity="0" class="anim">'
              + window(t, t + 0.9, 7.0, 0.03) + "</rect>")
        acc += lens[i + 1] if i < 5 else 0
    b += text(30, 340, "Every format reader implements the same Slide trait: levels, downsamples, read_region(x, y, level, w, h, frame).", "m")
    b += text(30, 360, "A slide that is damaged or unreadable is not tried again for five minutes; the reason is in Administration → Log.", "m")
    svg("tile-pipeline.svg", 1000, 390, b, "Tile pipeline", "A tile request passes authentication, the slide handle cache, a region read, the DeepZoom generator and an encoder, then returns to the browser.")


def job_queue():
    W, H = 1000, 560
    b = text(30, 30, "A job from the button to the result (registration or image analysis)", "h")
    X = {"u": 140, "s": 500, "w": 860}
    names = {"u": ("Browser / script", "core"), "s": ("exact-server + PostgreSQL", "db"), "w": ("Worker (Python)", "ext")}
    for k, x in X.items():
        t, c = names[k]
        b += box(x - 105, 50, 210, 40, t, None, c)
        b += f'<line x1="{x}" y1="90" x2="{x}" y2="530" stroke="#3a4660" stroke-width="1.5" stroke-dasharray="4 5"/>'
    D = 16.0
    msgs = [
        ("m1", "u", "s", 125, "POST /api/v2/images/{id}/register", "202: queued (a row in processing_pluginjob)", PAL["blue"], 0.6),
        ("m2", "w", "s", 185, "POST /api/v2/jobs/claim  {worker, kinds, plugins}", "polled every few seconds", PAL["violet"], 2.4),
        ("m3", "s", "w", 245, "200 {job, image paths, parameters}", "one UPDATE ... SKIP LOCKED: one worker only", PAL["teal"], 4.2),
        ("m5", "w", "s", 345, "POST /api/v2/plugin-jobs/{id}/progress", "now and then (analysis jobs)", PAL["violet"], 7.0),
        ("m6", "w", "s", 405, "POST .../{id}/complete  {result}", "one transaction: result, entries, annotations", PAL["violet"], 8.8),
        ("m7", "s", "u", 465, "Jobs page: done · overlay or annotations appear", "job status is derived from the rows", PAL["teal"], 10.8),
    ]
    for pid, a, bb, y, lab, sub, col, t0 in msgs:
        b += arrow_msg(pid, X[a], y, X[bb], y, lab, t0, D, col, sub, above=True, hold=D - 0.5)
    # worker is busy: pulsing box on its lifeline
    b += (f'<rect x="{X["w"] - 10}" y="270" width="20" height="62" rx="4" class="ext" opacity="0">' + window(5.0, 7.0, D, 0.03) + "</rect>")
    b += f'<g opacity="0">{window(5.0, 7.0, D, 0.03)}{text(X["w"] - 20, 304, "runs the plugin", "s e")}</g>'
    svg("job-queue.svg", W, H, b, "Job lifecycle", "A client queues a job; a worker claims it atomically, runs the plugin, reports progress and uploads the result in one request; the Jobs page shows it as done.")


def coexistence():
    b = text(30, 30, "Rust and Django side by side on one database and one image store", "h")
    b += box(30, 60, 250, 90, "EXACT (Django)", "unchanged, as before", "ext")
    b += box(620, 60, 250, 90, "EXACT-Rust", "exact-server", "core")
    b += box(330, 60, 240, 90, "Kept separate", "browser sessions, passkey origin", "caches (one per server)", "warn")
    b += '<rect x="250" y="190" width="400" height="140" rx="12" class="db" fill-opacity="0.4"/>'
    b += text(450, 214, "PostgreSQL", "h c")
    b += box(268, 228, 170, 86, "Django's tables", "images_* annotations_*", "users_* processing_*", "box")
    b += box(462, 228, 170, 86, "Rust's own tables", "exact_rust_sessions", "invitations, passkeys, flags", "box")
    b += box(250, 360, 400, 70, "Image store", "IMAGE_PATH + MEDIA_ROOT: the same folders, the same file modes", "db")
    b += path("l1", "M155 150 L155 250 L268 250", marker=False) + path("l2", "M745 150 L745 250 L632 250", marker=False)
    b += path("l3", "M95 150 L95 395 L250 395", marker=False) + path("l4", "M805 150 L805 395 L650 395", marker=False)
    b += packet("l1", 2.4, 0.0, PAL["violet"]) + packet("l1", 2.4, 1.2, PAL["violet"], reverse=True)
    b += packet("l2", 2.4, 0.4, PAL["blue"]) + packet("l2", 2.4, 1.6, PAL["blue"], reverse=True)
    b += packet("l3", 3.4, 0.2, PAL["violet"]) + packet("l3", 3.4, 1.9, PAL["violet"], reverse=True)
    b += packet("l4", 3.4, 0.9, PAL["blue"]) + packet("l4", 3.4, 2.6, PAL["blue"], reverse=True)
    b += text(30, 462, "Additive only: the Rust migration adds tables and columns (IF NOT EXISTS), never changes or drops one of Django's.", "m")
    b += text(30, 482, "Django's own migration adds the same objects with the same DDL, so either may run first. Roll back = stop the Rust server.", "m")
    svg("coexistence.svg", 900, 505, b, "Coexistence with Django", "Django and the Rust server read and write the same database tables and the same image folders; the Rust server adds tables of its own.")


if __name__ == "__main__":
    system_overview(); crates(); tile_pipeline(); job_queue(); coexistence()
