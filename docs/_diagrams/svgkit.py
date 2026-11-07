"""Tiny helpers to write the animated diagrams of the documentation (plain SVG with SMIL, so they also move inside <img>)."""
import html, math, pathlib

OUT = pathlib.Path(__file__).resolve().parents[1] / "assets" / "diagrams"
OUT.mkdir(parents=True, exist_ok=True)

STYLE = """<style>
text{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;fill:#e6e9ef;font-size:14px}
.m{fill:#9aa4b2;font-size:12px}.h{font-weight:600;font-size:15px}.s{font-size:12px}.c{text-anchor:middle}.e{text-anchor:end}
.bg{fill:#11151f}.box{fill:#1b2231;stroke:#3a4660;stroke-width:1.5}.core{fill:#12304c;stroke:#5aa2ff;stroke-width:1.5}
.db{fill:#12372f;stroke:#2dd4bf;stroke-width:1.5}.ext{fill:#2a2340;stroke:#a78bfa;stroke-width:1.5}.warn{fill:#3a2e12;stroke:#fbbf24;stroke-width:1.5}
.rose{fill:#3b1d27;stroke:#fb7185;stroke-width:1.5}
.line{stroke:#5b6a88;stroke-width:1.6;fill:none}.dash{stroke-dasharray:5 5}
@media (prefers-reduced-motion: reduce){.anim{display:none}}
</style>"""

PAL = dict(blue="#5aa2ff", teal="#2dd4bf", amber="#fbbf24", rose="#fb7185", violet="#a78bfa", grey="#9aa4b2", text="#e6e9ef")


def esc(t):
    return html.escape(str(t), quote=False)


def svg(name, w, h, body, title, desc):
    s = (f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-labelledby="t d">'
         f'<title id="t">{esc(title)}</title><desc id="d">{esc(desc)}</desc>{STYLE}<defs>'
         '<marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#5b6a88"/></marker>'
         '</defs>'
         f'<rect class="bg" width="{w}" height="{h}" rx="12"/>{body}</svg>')
    (OUT / name).write_text(s)
    print(name, len(s))


def text(x, y, t, cls="", **kw):
    extra = "".join(f' {k.replace("_", "-")}="{v}"' for k, v in kw.items())
    return f'<text x="{x}" y="{y}" class="{cls}"{extra}>{esc(t)}</text>'


CLASSES = {"box", "core", "db", "ext", "warn", "rose"}


def box(x, y, w, h, title, *args, rx=8, tcls="h"):
    """box(x, y, w, h, title, sub, sub2, cls): trailing strings that name a style are the style, the others are lines of grey text."""
    args = list(args)
    cls = "box"
    if args and args[-1] in CLASSES:
        cls = args.pop()
    lines = [t for t in args if t]
    out = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" class="{cls}"/>'
    cy = y + h / 2
    ty = cy + 5 - 9 * len(lines)
    out += text(x + w / 2, ty, title, f"{tcls} c")
    for i, t in enumerate(lines):
        out += text(x + w / 2, ty + 19 + 16 * i, t, "m c")
    return out


def path(pid, d, cls="line", marker=True):
    m = ' marker-end="url(#ar)"' if marker else ""
    return f'<path id="{pid}" d="{d}" class="{cls}"{m}/>'


def packet(pid, dur=3.0, begin=0.0, color=PAL["blue"], r=5, reverse=False):
    kp = 'keyPoints="1;0" keyTimes="0;1" calcMode="linear" ' if reverse else ""
    return (f'<circle r="{r}" fill="{color}" class="anim" opacity="0.95"><animateMotion dur="{dur}s" begin="{begin}s" repeatCount="indefinite" {kp}>'
            f'<mpath xlink:href="#{pid}" href="#{pid}"/></animateMotion></circle>')


def timeline(values, times, attr="opacity", dur=12.0, extra=""):
    """An <animate> with discrete-looking steps: values at keyTimes (linear unless extra says otherwise)."""
    return (f'<animate attributeName="{attr}" values="{";".join(str(v) for v in values)}" keyTimes="{";".join(f"{t:.4f}" for t in times)}" '
            f'dur="{dur}s" repeatCount="indefinite" {extra}/>')


def window(t0, t1, dur=12.0, fade=0.02, lo=0.0, hi=1.0, attr="opacity"):
    """An animate that is `hi` between t0 and t1 (seconds in the loop) and `lo` otherwise."""
    a, b = t0 / dur, t1 / dur
    pts = [(0, lo)]
    if a > 0:
        pts += [(max(a - fade, 0.0001), lo)]
    pts += [(a, hi), (b, hi)]
    if b < 1:
        pts += [(min(b + fade, 0.9999), lo), (1, lo)]
    else:
        pts += [(1, hi)]
    # keyTimes must be strictly non-decreasing
    cleaned, last = [], -1
    for t, v in pts:
        t = max(t, last)
        cleaned.append((t, v)); last = t
    if cleaned[0][0] != 0:
        cleaned.insert(0, (0, lo))
    if cleaned[-1][0] != 1:
        cleaned.append((1, cleaned[-1][1]))
    return timeline([v for _, v in cleaned], [t for t, _ in cleaned], attr, dur)


def arrow_msg(pid, x1, y1, x2, y2, label, t0, dur=14.0, color=PAL["blue"], sub=None, above=True, label_dx=0, hold=None):
    """A message between two lifelines that appears at t0 (s) and stays until the loop ends; a dot travels along it once."""
    hold = hold if hold is not None else dur - 0.4
    a, b = t0 / dur, min(hold / dur, 0.97)
    vis = timeline([0, 0, 1, 1, 0, 0], [0, a, min(a + 0.02, b), b, min(b + 0.02, 0.995), 1], dur=dur)
    d = f"M{x1} {y1} L{x2} {y2}"
    ln = f'<path id="{pid}" d="{d}" class="line" marker-end="url(#ar)" stroke="{color}" opacity="0">{vis}</path>'
    mx, my = (x1 + x2) / 2 + label_dx, (y1 + y2) / 2 + (-8 if above else 18)
    lab = f'<g opacity="0">{vis}{text(mx, my, label, "s c")}' + (text(mx, my + 15, sub, "m c") if sub else "") + "</g>"
    kt = f"0;{a:.4f};{min(a + 0.05, b):.4f};1"
    dot = (f'<circle r="5" fill="{color}" class="anim" opacity="0"><animate attributeName="opacity" values="0;0;1;0;0" keyTimes="0;{a:.4f};{a:.4f};{min(a + 0.05, 1):.4f};1" dur="{dur}s" repeatCount="indefinite"/>'
           f'<animateMotion dur="{dur}s" repeatCount="indefinite" keyPoints="0;0;1;1" keyTimes="{kt}" calcMode="linear"><mpath xlink:href="#{pid}" href="#{pid}"/></animateMotion></circle>')
    return ln + lab + dot
