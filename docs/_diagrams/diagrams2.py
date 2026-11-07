from svgkit import *
import math, random


def spline(points):
    """Closed Catmull-Rom spline through points as a cubic Bezier path."""
    n = len(points)
    d = f"M{points[0][0]:.1f} {points[0][1]:.1f}"
    for i in range(n):
        p0, p1, p2, p3 = points[(i - 1) % n], points[i], points[(i + 1) % n], points[(i + 2) % n]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        d += f" C{c1[0]:.1f} {c1[1]:.1f} {c2[0]:.1f} {c2[1]:.1f} {p2[0]:.1f} {p2[1]:.1f}"
    return d + " Z"


def blob(seed, n=11, r=105):
    rnd = random.Random(seed)
    pts = []
    for i in range(n):
        a = 2 * math.pi * i / n
        rr = r * (0.78 + 0.32 * math.sin(3 * a + 0.7) * 0.5 + 0.18 * rnd.random()) * (1.0 + 0.25 * math.cos(a))
        pts.append((rr * math.cos(a) * 1.25, rr * math.sin(a)))
    return pts


def registration_concept():
    D = 14.0
    cx, cy = 300, 215  # centre of the stage
    base = blob(3)
    rnd = random.Random(8)
    nuclei = []
    while len(nuclei) < 22:
        x, y = rnd.uniform(-120, 120), rnd.uniform(-85, 85)
        # keep inside the blob (rough ellipse test)
        if (x / 128) ** 2 + (y / 88) ** 2 < 0.8:
            nuclei.append((x, y))
    marks = [nuclei[2], nuclei[9], nuclei[15]]
    # transformation of the second section at u=0: rotation, scale, shift
    th0, s0, t0 = math.radians(16), 1.08, (62, 34)

    def tf(p, u):
        th, s = th0 * u, 1 + (s0 - 1) * u
        x, y = p[0] * s, p[1] * s
        c, sn = math.cos(th), math.sin(th)
        return (cx + t0[0] * u + c * x - sn * y, cy + t0[1] * u + sn * x + c * y)

    # u = 1 (displaced) -> 0 (aligned): displacement amount d(t)
    def disp(t):
        def sm(a, b, t):
            k = min(max((t - a) / (b - a), 0), 1)
            return k * k * (3 - 2 * k)
        if t < 2.0:
            return 1.0
        if t < 6.0:
            return 1 - sm(2.0, 6.0, t)
        if t < 10.0:
            return 0.0
        return sm(10.0, 12.5, t)
    N = 56
    ts = [D * i / N for i in range(N + 1)]
    kt = ";".join(f"{i / N:.4f}" for i in range(N + 1))
    us = [disp(t) for t in ts]

    b = text(30, 30, "What registration does: finding the map from one image onto another", "h")
    b += '<rect x="20" y="46" width="580" height="340" rx="10" fill="#0d111a" stroke="#2a3348"/>'
    # section 1 (fixed): H&E
    b += f'<g transform="translate({cx} {cy})"><path d="{spline(base)}" fill="#a78bfa" fill-opacity="0.22" stroke="#a78bfa" stroke-width="2"/>'
    for (x, y) in nuclei:
        b += f'<circle cx="{x:.1f}" cy="{y:.1f}" r="4" fill="#7c5cd6"/>'
    b += "</g>"
    b += text(36, 70, "Section 1 · H&E (target)", "s", fill="#c4b5fd")
    b += text(36, 88, "fixed", "m")
    # markers on section 1
    for i, m in enumerate(marks):
        x, y = cx + m[0], cy + m[1]
        b += f'<g opacity="0">{window(0.6, 12.0, D, 0.02)}<circle cx="{x:.1f}" cy="{y:.1f}" r="9" fill="none" stroke="#a78bfa" stroke-width="2.5"/>{text(x + 12, y - 8, i + 1, "s", fill="#c4b5fd")}</g>'
    # section 2 (moves): composite transform animated hierarchically
    tr = ";".join(f"{cx + t0[0] * u:.2f} {cy + t0[1] * u:.2f}" for u in us)
    ro = ";".join(f"{math.degrees(th0) * u:.3f}" for u in us)
    sc = ";".join(f"{1 + (s0 - 1) * u:.4f}" for u in us)
    b += (f'<g><animateTransform attributeName="transform" type="translate" values="{tr}" keyTimes="{kt}" dur="{D}s" repeatCount="indefinite"/>'
          f'<g><animateTransform attributeName="transform" type="rotate" values="{ro}" keyTimes="{kt}" dur="{D}s" repeatCount="indefinite"/>'
          f'<g><animateTransform attributeName="transform" type="scale" values="{sc}" keyTimes="{kt}" dur="{D}s" repeatCount="indefinite"/>')
    rnd2 = random.Random(5)
    b2 = [(x + rnd2.uniform(-3, 3), y + rnd2.uniform(-3, 3)) for x, y in base]
    b += (f'<g>{timeline([1, 1, 0.4, 1, 1], [0, 6.6 / D, 7.8 / D, 9.0 / D, 1], dur=D)}<path d="{spline(b2)}" fill="#fbbf24" fill-opacity="0.2" stroke="#fbbf24" stroke-width="2"/>')
    for (x, y) in nuclei:
        b += f'<circle cx="{x + rnd2.uniform(-2.5, 2.5):.1f}" cy="{y + rnd2.uniform(-2.5, 2.5):.1f}" r="3.6" fill="#b45309"/>'
    for i, m in enumerate(marks):
        b += f'<g opacity="0">{window(0.6, 12.0, D, 0.02)}<circle cx="{m[0]:.1f}" cy="{m[1]:.1f}" r="9" fill="none" stroke="#fbbf24" stroke-width="2.5"/>{text(m[0] + 12, m[1] - 8, i + 1, "s", fill="#fde68a")}</g>'
    b += "</g></g></g></g>"
    # pair lines from fixed marks to moving marks
    for i, m in enumerate(marks):
        x1, y1 = cx + m[0], cy + m[1]
        xs = ";".join(f"{tf(m, u)[0]:.2f}" for u in us)
        ys = ";".join(f"{tf(m, u)[1]:.2f}" for u in us)
        b += (f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{tf(m, 1)[0]:.1f}" y2="{tf(m, 1)[1]:.1f}" stroke="#e6e9ef" stroke-width="1.5" stroke-dasharray="4 4" opacity="0">'
              f'<animate attributeName="x2" values="{xs}" keyTimes="{kt}" dur="{D}s" repeatCount="indefinite"/>'
              f'<animate attributeName="y2" values="{ys}" keyTimes="{kt}" dur="{D}s" repeatCount="indefinite"/>' + window(0.6, 12.0, D, 0.02) + "</line>")
    b += text(36, 372, "Section 2 · IHC, the next slice (source) moves; section 1 stays", "m")
    # right: steps
    x0 = 625
    steps = [("1", "Find matching points", "the same nucleus, vessel or edge in both images", 0.0, 4.0),
             ("2", "Fit a transformation M", "rotation, scale, shift: the points meet", 4.0, 7.0),
             ("3", "Use it", "overlay the image, carry annotations over", 7.0, 12.0)]
    for i, (n, t, s, a, bb) in enumerate(steps):
        y = 70 + i * 74
        b += f'<rect x="{x0}" y="{y}" width="340" height="62" rx="8" class="box"/>'
        b += (f'<rect x="{x0}" y="{y}" width="340" height="62" rx="8" fill="none" stroke="#fbbf24" stroke-width="2.5" opacity="0">' + window(a, bb, D, 0.03) + "</rect>")
        b += f'<circle cx="{x0 + 28}" cy="{y + 31}" r="14" fill="#fbbf24"/>' + text(x0 + 28, y + 36, n, "h c", fill="#11151f")
        b += text(x0 + 54, y + 27, t, "h") + text(x0 + 54, y + 46, s, "m")
    # equation
    mono = 'font-family:monospace;white-space:pre'
    b += text(x0, 322, "x' = M · x", "h")
    b += text(x0, 342, "[x']   [a b tx] [x]", "m", style=mono) + text(x0, 358, "[y'] = [c d ty] [y]", "m", style=mono) + text(x0, 374, "[1 ]   [0 0  1] [1]", "m", style=mono)
    # distance bar
    b += text(x0 + 150, 322, "mean distance of the point pairs", "m")
    b += f'<rect x="{x0 + 150}" y="332" width="190" height="12" rx="6" fill="#222a3b"/>'
    ws = ";".join(f"{190 * u:.1f}" for u in us)
    b += f'<rect x="{x0 + 150}" y="332" width="190" height="12" rx="6" fill="#fbbf24"><animate attributeName="width" values="{ws}" keyTimes="{kt}" dur="{D}s" repeatCount="indefinite"/></rect>'
    b += text(30, 410, "With M known, any point or annotation of the source maps to the target: x' = M · x. Automatic plugins find M themselves; by hand you give the pairs.", "m")
    svg("registration-concept.svg", 1000, 430, b, "What image registration does",
        "Animation: a neighbouring tissue section (amber) is displaced and rotated against the first section (violet). Three matching point pairs are found, a transformation is fitted, and the sections overlay.")


def registration_flow():
    b = text(30, 30, "Two ways to a registration", "h")
    w, gap, x0 = 150, 16, 36
    lanes = [
        ("Automatic", 90, "db", ["Select two images", "Register…", "Plugin + settings", "Job queued", "Worker computes", "Stored"],
         ["in the image set", "Method: Automatic", "parameters are optional", "see Jobs", "matrix, error in px", "overlay, copy annotations"]),
        ("Manual", 250, "warn", ["Register…", "Method: Manual", "Click point pairs", "Fit", "Review", "Stored"],
         ["or the Registration tab", "source and target image", "left image, then right", "1 pair: shift · 3+: affine", "slider: source over target", "together with its points"]),
    ]
    D = 12.0
    for name, y, cls, titles, subs in lanes:
        b += text(36, y - 14, name, "h", fill=PAL["teal"] if name == "Automatic" else PAL["amber"])
        for i, (t, s) in enumerate(zip(titles, subs)):
            x = x0 + i * (w + gap)
            b += box(x, y, w, 72, t, s, "box")
            a = 0.4 + i * 1.7
            b += (f'<rect x="{x}" y="{y}" width="{w}" height="72" rx="8" fill="none" stroke="{PAL["teal"] if name == "Automatic" else PAL["amber"]}" stroke-width="3" opacity="0">'
                  + window(a, a + 1.7, D, 0.02) + "</rect>")
            if i < 5:
                b += path(f"{name}{i}", f"M{x + w} {y + 36} L{x + w + gap} {y + 36}")
        total = "M" + f"{x0 + w / 2} {y + 36} " + " ".join(f"L{x0 + i * (w + gap) + w / 2} {y + 36}" for i in range(1, 6))
        b += f'<path id="route{name}" d="{total}" fill="none" stroke="none"/>'
        b += (f'<circle r="7" fill="{PAL["teal"] if name == "Automatic" else PAL["amber"]}" class="anim"><animateMotion dur="{D}s" begin="0.4s" repeatCount="indefinite" keyPoints="0;0;1;1" keyTimes="0;0.02;0.92;1" calcMode="linear">'
              f'<mpath xlink:href="#route{name}" href="#route{name}"/></animateMotion></circle>')
    b += text(36, 360, "Both end in the same record (an ImageRegistration: a 3×3 matrix, an error, optionally the points or a deformation).", "m")
    b += text(36, 380, "A registration of A onto B can be inverted to B onto A with one click (\"Create inverse\").", "m")
    svg("registration-flow.svg", 1060, 405, b, "The two registration routes", "Automatic: select, choose a plugin, a worker computes. Manual: click point pairs, fit, review. Both store a registration.")


def data_model():
    b = text(30, 30, "The data model in one picture (arrows read: belongs to)", "h")
    E = {}

    def ent(name, x, y, w, lines, cls="box"):
        E[name] = (x, y, w, 28 + 17 * len(lines))
        r = f'<rect x="{x}" y="{y}" width="{w}" height="{28 + 17 * len(lines)}" rx="8" class="{cls}"/>' + text(x + 10, y + 19, name, "h")
        for i, l in enumerate(lines):
            r += text(x + 10, y + 38 + 17 * i, l, "m")
        return r

    b += ent("Team", 30, 70, 170, ["name", "members (admin or not)"], "core")
    b += ent("User", 30, 200, 170, ["login, passkeys", "teams via membership"], "core")
    b += ent("ImageSet", 270, 70, 190, ["name, path, team", "products, tags"], "box")
    b += ent("Image", 540, 70, 180, ["file, size, mpp", "frames (z, time)"], "box")
    b += ent("Annotation", 540, 200, 180, ["vector, verified, flags", "type, user, history"], "box")
    b += ent("Product", 270, 200, 190, ["groups types", "belongs to a team"], "box")
    b += ent("AnnotationType", 270, 330, 190, ["name, colour, vector type", "size, key 1-9"], "box")
    b += ent("ImageRegistration", 800, 70, 190, ["source image, target image", "3×3 matrix, error, points"], "warn")
    b += ent("PluginJob", 800, 200, 190, ["plugin, image(s), worker", "progress, error"], "ext")
    b += ent("Plugin", 800, 330, 190, ["name, package, type", "1 analysis · 2 registration"], "ext")
    b += ent("PluginResult", 540, 330, 180, ["job, plugin, image", "entries"], "ext")
    b += ent("ResultEntry → Annotations", 540, 450, 220, ["name, default threshold", "result annotations (score)"], "ext")

    def link(a, b_, pid, color="#5b6a88", dash=False, side=None):
        ax, ay, aw, ah = E[a]
        bx, by, bw, bh = E[b_]
        x1, y1 = ax + aw / 2, ay + ah / 2
        x2, y2 = bx + bw / 2, by + bh / 2
        # attach on the facing edges
        if abs(x2 - x1) > abs(y2 - y1):
            p1 = (ax + aw if x2 > x1 else ax, y1)
            p2 = (bx if x2 > x1 else bx + bw, y2)
        else:
            p1 = (x1, ay + ah if y2 > y1 else ay)
            p2 = (x2, by if y2 > y1 else by + bh)
        return path(pid, f"M{p1[0]} {p1[1]} L{p2[0]} {p2[1]}", "line" + (" dash" if dash else ""))
    rel = [("ImageSet", "Team", "r1"), ("Image", "ImageSet", "r2"), ("Annotation", "Image", "r3"), ("Annotation", "AnnotationType", "r4"),
           ("AnnotationType", "Product", "r5"), ("Product", "ImageSet", "r6"), ("PluginJob", "Plugin", "r7"), ("PluginJob", "Image", "r8"),
           ("PluginResult", "PluginJob", "r9"), ("ResultEntry → Annotations", "PluginResult", "r10"), ("ImageRegistration", "Image", "r11"), ("User", "Team", "r12")]
    for a, c, pid in rel:
        b += link(a, c, pid)
    b += text(372, 176, "many to many", "m", font_size=11)
    # a highlight pulse that walks the chain Team → ImageSet → Image → Annotation
    chain = ["Team", "ImageSet", "Image", "Annotation"]
    for i, name in enumerate(chain):
        x, y, w, h = E[name]
        b += (f'<rect x="{x - 2}" y="{y - 2}" width="{w + 4}" height="{h + 4}" rx="10" fill="none" stroke="{PAL["amber"]}" stroke-width="3" opacity="0" class="anim">'
              + window(i * 1.3, i * 1.3 + 1.3, 8.0, 0.03) + "</rect>")
    b += text(30, 535, "Visibility follows the teams: you see an image if its image set belongs to a team you are a member of.", "m")
    svg("data-model.svg", 1020, 560, b, "Data model", "Teams own image sets, which hold images; annotations belong to an image and an annotation type; products group annotation types; plugins have jobs, jobs have results.")


def plugin_lifecycle():
    b = text(30, 30, "The life of a worker (helpers/queue_worker.py)", "h")
    steps = [(60, 100, "Start", "log in with the worker account", "core"), (290, 100, "Announce", "POST /api/v2/plugins/register", "box"),
             (520, 100, "Claim", "POST /api/v2/jobs/claim", "ext"), (750, 100, "Run the plugin", "plugin.run(job, ctx)", "ext"),
             (750, 250, "Report", "progress · complete · fail", "db"), (520, 250, "Idle", "sleep a few seconds", "box")]
    for x, y, t, s, c in steps:
        b += box(x, y, 190, 70, t, s, c)
    b += path("p1", "M250 135 L290 135") + path("p2", "M480 135 L520 135") + path("p3", "M710 135 L750 135")
    b += path("p4", "M845 170 L845 250") + path("p5", "M750 285 L710 285", ) + path("p6", "M520 285 L430 285 L430 235 L615 235 L615 170", "line")
    b += path("p7", "M615 100 L615 70 L385 70 L385 100", "line dash")
    b += text(500, 62, "announce again every 10 minutes", "m c")
    b += text(480, 230, "", "m")
    route = "M155 135 L385 135 L615 135 L845 135 L845 285 L615 285 L430 285 L430 235 L615 235 L615 135"
    b += f'<path id="loop" d="{route}" fill="none" stroke="none"/>'
    b += f'<circle r="7" fill="{PAL["amber"]}" class="anim"><animateMotion dur="9s" repeatCount="indefinite"><mpath xlink:href="#loop" href="#loop"/></animateMotion></circle>'
    b += text(60, 340, "204 from the claim means nothing is waiting: the worker sleeps and asks again. A job whose worker disappears is offered again after 30 minutes.", "m")
    b += text(60, 360, "A plugin that cannot run here (missing library, missing model file) says why in the log and is not announced; the others carry on.", "m")
    svg("plugin-lifecycle.svg", 980, 385, b, "Worker lifecycle", "A worker logs in, announces its plugins, claims jobs, runs a plugin, reports and waits.")


def team_workflow():
    D = 14.0
    b = text(30, 30, "From an empty server to annotated images", "h")
    steps = [("1", "Create a team", "Administration → Teams"), ("2", "Add people", "members, team admins, invitations"),
             ("3", "Annotation types", "Administration → Products"), ("4", "Create an image set", "pick the team and products"),
             ("5", "Upload images", "drag files onto the page"), ("6", "Annotate", "viewer, toolbox, shortcuts"), ("7", "Export", "formats of the image set")]
    w, gap = 118, 14
    x0 = 24
    for i, (n, t, s) in enumerate(steps):
        x = x0 + i * (w + gap)
        y = 80
        b += f'<rect x="{x}" y="{y}" width="{w}" height="160" rx="10" class="box"/>'
        b += (f'<rect x="{x}" y="{y}" width="{w}" height="160" rx="10" fill="none" stroke="{PAL["blue"]}" stroke-width="3" opacity="0">' + window(0.5 + i * 1.8, 0.5 + (i + 1) * 1.8, D, 0.02) + "</rect>")
        b += f'<circle cx="{x + w / 2}" cy="{y + 30}" r="15" fill="{PAL["blue"]}"/>' + text(x + w / 2, y + 36, n, "h c", fill="#11151f")
        # wrap title on two lines
        words = t.split(" ")
        half = (len(words) + 1) // 2
        l1, l2 = " ".join(words[:half]), " ".join(words[half:])
        b += text(x + w / 2, y + 70, l1, "h c") + text(x + w / 2, y + 88, l2, "h c")
        sw = s.split(" · ")[0]
        # wrap sub at ~16 chars
        parts, cur = [], ""
        for wd in s.split(" "):
            if len(cur) + len(wd) > 17:
                parts.append(cur); cur = wd
            else:
                cur = (cur + " " + wd).strip()
        parts.append(cur)
        for j, p in enumerate(parts[:3]):
            b += text(x + w / 2, y + 112 + 15 * j, p, "m c")
        if i < len(steps) - 1:
            b += path(f"w{i}", f"M{x + w} {y + 70} L{x + w + gap} {y + 70}")
    total = "M" + f"{x0 + w / 2} 320 " + " ".join(f"L{x0 + i * (w + gap) + w / 2} 320" for i in range(1, 7))
    b += f'<path d="{total}" stroke="#2a3348" stroke-width="3" fill="none"/><path id="walk" d="{total}" fill="none" stroke="none"/>'
    b += (f'<circle r="8" fill="{PAL["amber"]}" class="anim"><animateMotion dur="{D}s" begin="0s" repeatCount="indefinite" keyPoints="0;0;1;1" keyTimes="0;0.04;0.96;1" calcMode="linear">'
          f'<mpath xlink:href="#walk" href="#walk"/></animateMotion></circle>')
    b += text(30, 370, "Steps 1-4 are done once per project (by a team admin); 5-7 are daily work. Everything a member sees follows from the team.", "m")
    svg("team-workflow.svg", 1000, 395, b, "Team workflow", "Seven steps: create a team, add people, define annotation types, create an image set, upload images, annotate, export.")


def ui_map():
    D = 16.0
    b = text(30, 30, "The screens and how you get from one to the next", "h")
    nodes = {
        "login": (30, 150, 130, 60, "Login", "password or passkey", "box"),
        "invite": (30, 40, 130, 60, "Invitation", "link from a team admin", "box"),
        "home": (210, 150, 150, 60, "Image sets", "your teams, search", "core"),
        "set": (410, 150, 150, 60, "Image set", "thumbnails, upload", "core"),
        "viewer": (610, 150, 150, 60, "Viewer", "annotate, overlay", "core"),
        "planes": (810, 150, 150, 60, "Three planes", "volumes (NIfTI, DICOM)", "core"),
        "reg": (410, 250, 150, 60, "Registration tab", "pairs, manual, review", "warn"),
        "jobs": (210, 350, 150, 60, "Jobs", "queue, progress, restart", "ext"),
        "admin": (410, 350, 150, 60, "Administration", "teams, products, users", "ext"),
        "prefs": (610, 350, 150, 60, "Preferences", "navigation, zoom, passkeys", "box"),
        "help": (810, 350, 150, 60, "Keyboard help", "? on any screen", "box"),
    }
    b += '<rect x="190" y="320" width="790" height="110" rx="12" fill="none" stroke="#3a4660" stroke-dasharray="6 6"/>' + text(204, 340, "Top bar: reachable from every screen", "m")
    for k, (x, y, w, h, t, s, c) in nodes.items():
        b += box(x, y, w, h, t, s, c)
    L = [("invite", "login", "M95 100 L95 150", "l0"), ("login", "home", "M160 180 L210 180", "l1"), ("home", "set", "M360 180 L410 180", "l2"),
         ("set", "viewer", "M560 180 L610 180", "l3"), ("viewer", "planes", "M760 180 L810 180", "l4"), ("set", "reg", "M485 210 L485 250", "l5")]
    for a, c, d, pid in L:
        b += path(pid, d)
    route = "M95 70 L95 180 L160 180 L210 180 L360 180 L410 180 L560 180 L610 180 L760 180"
    b += f'<path id="walk" d="{route}" fill="none" stroke="none"/>'
    b += (f'<circle r="8" fill="{PAL["amber"]}" class="anim"><animateMotion dur="{D}s" repeatCount="indefinite" keyPoints="0;1;1" keyTimes="0;0.7;1" calcMode="linear"><mpath xlink:href="#walk" href="#walk"/></animateMotion></circle>')
    for i, k in enumerate(["invite", "login", "home", "set", "viewer"]):
        x, y, w, h = nodes[k][:4]
        t0 = i * 2.4
        b += f'<rect x="{x - 2}" y="{y - 2}" width="{w + 4}" height="{h + 4}" rx="10" fill="none" stroke="{PAL["amber"]}" stroke-width="3" opacity="0" class="anim">' + window(t0, t0 + 2.4, D, 0.02) + "</rect>"
    b += text(30, 455, "In the viewer the round icon opens image adjustments; site admins see a pulse icon for system health.", "m")
    svg("ui-map.svg", 1000, 470, b, "Screens of the web interface", "From invitation or login to the list of image sets, an image set, and the viewer; jobs, administration and preferences are reachable from the top bar.")


def detection_pipeline():
    D = 12.0
    b = text(30, 30, "The MIDOG 2025 detector as a worker plugin", "h")
    # slide
    b += '<rect x="30" y="60" width="300" height="240" rx="6" fill="#0d111a" stroke="#2a3348"/>'
    pts = [(80, 120), (140, 85), (230, 95), (300, 150), (290, 235), (210, 275), (120, 265), (65, 200)]
    b += f'<path d="{spline(pts)}" fill="#f0abfc" fill-opacity="0.25" stroke="#e879f9" stroke-width="1.5"/>'
    b += text(36, 316, "slide: tissue mask at 1/32 resolution (Otsu)", "m")
    # patch grid
    cell = 62
    k = 0
    for gy in range(4):
        for gx in range(5):
            x, y = 45 + gx * 55, 72 + gy * 55
            inside = (60 < x + 30 < 310) and (75 < y + 30 < 285)
            if not inside:
                continue
            t = 1.0 + k * 0.22
            b += (f'<rect x="{x}" y="{y}" width="{cell}" height="{cell}" fill="{PAL["blue"]}" fill-opacity="0.08" stroke="{PAL["blue"]}" stroke-width="1.5" opacity="0">' + window(t, 9.5, D, 0.01) + "</rect>")
            k += 1
    # detections popping
    rnd = random.Random(2)
    for i in range(7):
        x, y = rnd.randint(100, 270), rnd.randint(110, 250)
        t = 4.0 + i * 0.5
        b += (f'<rect x="{x}" y="{y}" width="12" height="12" fill="none" stroke="{PAL["rose"]}" stroke-width="2" opacity="0">' + window(t, 11.5, D, 0.02) + "</rect>")
    # pipeline boxes
    steps = [("Tissue mask", "skip empty glass"), ("1024 px patches", "30 % overlap, read ahead"), ("FCOS ResNeXt-50", "batch on the GPU"),
             ("One NMS", "across all patches"), ("Complete", "one request: result + annotations")]
    for i, (t, s) in enumerate(steps):
        x, y = 380 + (i % 2) * 290, 70 + (i // 2) * 80
        if i == 4:
            x, y = 380, 70 + 2 * 80
        b += box(x, y, 270, 60, t, s, "ext" if i in (1, 2) else "box")
        a = 0.5 + i * 2.2
        b += f'<rect x="{x}" y="{y}" width="270" height="60" rx="8" fill="none" stroke="{PAL["amber"]}" stroke-width="3" opacity="0">' + window(a, a + 2.2, D, 0.02) + "</rect>"
    b += text(380, 322, "Result: Mitotic Figures, default threshold 0.548 (the reference's); read via API or Django's UI.", "m")
    b += text(380, 342, "Reads the file directly; the model stays loaded between jobs.", "m")
    svg("detection-pipeline.svg", 990, 360, b, "Detection plugin pipeline", "A tissue mask selects patches, a detector runs on each, detections are merged by one non-maximum suppression and stored as one result.")


if __name__ == "__main__":
    registration_concept(); registration_flow(); data_model(); plugin_lifecycle(); team_workflow(); ui_map(); detection_pipeline()


def api_layers():
    b = text(30, 30, "Three doors, one engine", "h")
    clients = [("exact-sync · notebooks", "Basic or token", 70, "box"), ("Web interface", "session cookie + CSRF header", 160, "core"), ("Workers", "Basic or token, v2 job endpoints", 250, "ext")]
    for t, s, y, c in clients:
        b += box(30, y, 230, 64, t, s, c)
    doors = [("/api/v1 + legacy paths", "byte-compatible with EXACT", 70, "box"), ("/api/v2", "JSON, snake_case, cursor paging", 160, "core"), ("/api/v2 jobs", "claim · progress · complete · fail", 250, "ext")]
    for t, s, y, c in doors:
        b += box(340, y, 250, 64, t, s, c)
    b += box(670, 70, 280, 244, "Shared engine", "authentication and permissions", "team scope on every list", "filters, ordering, expansion", "transactions", "warn")
    b += box(670, 340, 280, 60, "PostgreSQL", "EXACT's schema", "db")
    for i, y in enumerate([102, 192, 282]):
        b += path(f"a{i}", f"M260 {y} L340 {y}") + path(f"b{i}", f"M590 {y} L670 {y}")
        b += packet(f"a{i}", 1.6, i * 0.5, [PAL["amber"], PAL["blue"], PAL["violet"]][i]) + packet(f"b{i}", 1.6, 0.8 + i * 0.5, [PAL["amber"], PAL["blue"], PAL["violet"]][i])
    b += path("c", "M810 314 L810 340") + packet("c", 1.0, 0.0, PAL["teal"], 4)
    b += text(30, 440, "v1 answers exactly as Django did (flat ids, DRF pagination) so exact-sync keeps working; v2 is free to be cleaner.", "m")
    b += text(30, 460, "Both read the same rows through the same code: a change made through one door is visible through the others at once.", "m")
    svg("api-layers.svg", 990, 485, b, "API layers", "Clients reach the compatible v1 API, the v2 API or the v2 job endpoints; all use the same engine and database.")


if __name__ == "__main__":
    api_layers()
