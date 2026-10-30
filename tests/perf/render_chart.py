#!/usr/bin/env python3
"""Draws the comparison of two servers (the report of compare_servers.py) as an SVG for the README, in a light and a dark version.

  tests/perf/render_chart.py --report tests/perf/reports/local/compare-XXXX.json --save-summary tests/perf/reports/prod-vs-beta.json --out docs/assets
  tests/perf/render_chart.py --summary tests/perf/reports/prod-vs-beta.json --out docs/assets

--report reads the full report (it names images and is not committed) and reduces it to a summary of medians (--save-summary, committed: no image
names); --summary draws from such a summary. Form: one system is the point, so it is the emphasis form: exact-rust in the accent blue, the other
in neutral gray, bars from one baseline on one shared millisecond axis, the value at every bar tip (twenty bars: the numbers are the content), the
factor in a column of its own. Colors are the data-viz palette (blue slot 1 and the muted gray; contrast and colour-vision separation validated for
both surfaces).
"""
import argparse
import json
import pathlib
import statistics
from xml.sax.saxutils import escape

LIST_ROWS = [  # (label, scenario name, mode)
    ("Image sets · Basic auth", "image sets (limit 100)", "basic"),
    ("Teams · Basic auth", "teams", "basic"),
    ("Images, 100 · Basic auth", "images (limit 100, no annotations)", "basic"),
    ("Image sets · session", "image sets (limit 100)", "session"),
    ("Teams · session", "teams", "session"),
    ("Images, 100 · session", "images (limit 100, no annotations)", "session"),
]
SLIDE_ROWS = [  # (label, scenario name prefix)
    ("Slide information (DeepZoom)", "slide info (DZI)"),
    ("Full-resolution tile", "tile full-res"),
    ("Low-resolution tile", "tile low-res"),
    ("Thumbnail", "thumbnail"),
]

THEMES = {
    "light": dict(surface="#fcfcfb", ink="#0b0b0b", ink2="#52514e", muted="#898781", grid="#e1e0d9", base="#c3c2b7", accent="#2a78d6", other="#898781"),
    "dark": dict(surface="#1a1a19", ink="#f0efec", ink2="#c3c2b7", muted="#898781", grid="#2c2c2a", base="#383835", accent="#3987e5", other="#898781"),
}


def reduce_report(report: dict, a="prod", b="beta") -> dict:
    """Medians of the warm timings: the lists one by one, the slide requests over all images of the report."""
    rows = {(n, m): c for n, m, c in report["summary"]}
    lists = []
    for label, name, mode in LIST_ROWS:
        c = rows[(name, mode)]
        lists.append({"label": label, a: c[a]["warm"], b: c[b]["warm"]})
    slides = []
    for label, prefix in SLIDE_ROWS:
        cells = [c for (n, m), c in rows.items() if n.startswith(prefix + " ")]
        cells = [c for c in cells if c[a]["warm"] and c[b]["warm"]]
        slides.append({"label": label, "images": len(cells), a: statistics.median(c[a]["warm"] for c in cells), b: statistics.median(c[b]["warm"] for c in cells)})
    return {"a": "EXACT (Django), production", "b": "exact-rust, beta", "lists": lists, "slides": slides}


def factor(x: float, y: float) -> str:
    f = x / y
    return f"{f:.0f}×" if f >= 10 else f"{f:.1f}×"


def bar(x: float, y: float, w: float, h: float, color: str) -> str:
    """A bar from a square baseline to a data end rounded by 4 px."""
    r = min(4.0, w / 2, h / 2)
    return f'<path d="M{x:.1f},{y:.1f}H{x + w - r:.1f}a{r},{r} 0 0 1 {r},{r}V{y + h - r:.1f}a{r},{r} 0 0 1 -{r},{r}H{x:.1f}Z" fill="{color}"/>'


def render(summary: dict, mode: str) -> str:
    t = THEMES[mode]
    W, LEFT, AXIS_W, RIGHT = 960, 236, 590, 100
    BAR_H, GAP, GROUP = 14, 4, 46
    top = 92
    max_ms = 800
    sx = AXIS_W / max_ms  # one axis for both panels
    ink, ink2, muted = t["ink"], t["ink2"], t["muted"]
    out = []
    a_name, b_name = summary["a"], summary["b"]
    n_rows = len(summary["lists"]) + len(summary["slides"])
    H = top + 30 + len(summary["lists"]) * GROUP + 62 + len(summary["slides"]) * GROUP + 62 + 56
    out.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-labelledby="t d" font-family="system-ui, -apple-system, \'Segoe UI\', Roboto, sans-serif">')
    out.append(f'<title id="t">exact-rust compared with EXACT (Django): median response times</title>')
    alt = "; ".join(f"{r['label']}: {r['prod']:.0f} ms against {r['beta']:.0f} ms" for r in summary["lists"] + summary["slides"])
    out.append(f'<desc id="d">Median response time in milliseconds, lower is better. {escape(alt)}.</desc>')
    out.append(f'<rect width="{W}" height="{H}" rx="14" fill="{t["surface"]}"/>')
    out.append(f'<text x="32" y="44" font-size="22" font-weight="600" fill="{ink}">exact-rust answers faster, on the same data</text>')
    out.append(f'<text x="32" y="68" font-size="13.5" fill="{ink2}">Median response time in milliseconds, lower is better · one request at a time · production-size data (24,169 images, 1.4 million annotations)</text>')
    # legend
    lx = W - 32 - 360
    out.append(f'<rect x="{lx}" y="22" width="12" height="12" rx="3" fill="{t["other"]}"/><text x="{lx + 18}" y="33" font-size="13" fill="{ink}">{escape(a_name)}</text>')
    lx2 = lx + 18 + 7.2 * len(a_name) + 22
    out.append(f'<rect x="{lx2:.0f}" y="22" width="12" height="12" rx="3" fill="{t["accent"]}"/><text x="{lx2 + 18:.0f}" y="33" font-size="13" fill="{ink}">{escape(b_name)}</text>')

    def panel(y0: float, title: str, sub: str, rows: list, label_of) -> float:
        out.append(f'<text x="32" y="{y0}" font-size="15" font-weight="600" fill="{ink}">{escape(title)}</text>')
        out.append(f'<text x="{32 + 7.9 * len(title) + 12:.0f}" y="{y0}" font-size="13" fill="{muted}">{escape(sub)}</text>')
        y = y0 + 22
        # gridlines and ticks
        gy0, gy1 = y - 6, y + len(rows) * GROUP - 8
        for v in range(0, max_ms + 1, 200):
            gx = LEFT + v * sx
            out.append(f'<line x1="{gx:.1f}" y1="{gy0}" x2="{gx:.1f}" y2="{gy1}" stroke="{t["base"] if v == 0 else t["grid"]}" stroke-width="1"/>')
        out.append(f'<text x="{W - RIGHT + 8}" y="{y - 10}" font-size="12" fill="{muted}">× faster</text>')
        for r in rows:
            va, vb = r["prod"], r["beta"]
            out.append(f'<text x="32" y="{y + 15}" font-size="13.5" fill="{ink2}">{escape(label_of(r))}</text>')
            for k, (v, col, lab_col, weight) in enumerate(((va, t["other"], ink2, 400), (vb, t["accent"], ink, 600))):
                by = y + k * (BAR_H + GAP)
                w = max(v * sx, 3)
                out.append(bar(LEFT, by, w, BAR_H, col))
                out.append(f'<text x="{LEFT + w + 8:.1f}" y="{by + 11.5}" font-size="12.5" font-weight="{weight}" fill="{lab_col}">{v:,.0f}</text>')
            out.append(f'<text x="{W - RIGHT + 8}" y="{y + 20}" font-size="15" font-weight="600" fill="{ink}">{factor(va, vb)}</text>')
            y += GROUP
        return y

    y = panel(top + 8, "Lists", "Basic auth: exact-sync and workers · session: the browser", summary["lists"], lambda r: r["label"])
    # axis labels once per panel, at the foot of each
    for v in range(0, max_ms + 1, 200):
        out.append(f'<text x="{LEFT + v * sx:.1f}" y="{y + 10}" font-size="12" text-anchor="middle" fill="{muted}">{v}</text>')
    out.append(f'<text x="{LEFT + AXIS_W / 2}" y="{y + 28}" font-size="12" text-anchor="middle" fill="{muted}">milliseconds</text>')
    y2 = panel(y + 58, "Slides", "median over 11 images in 6 formats (SVS, MRXS, NDPI, TIFF, VSI)", summary["slides"], lambda r: r["label"])
    for v in range(0, max_ms + 1, 200):
        out.append(f'<text x="{LEFT + v * sx:.1f}" y="{y2 + 10}" font-size="12" text-anchor="middle" fill="{muted}">{v}</text>')
    out.append(f'<text x="{LEFT + AXIS_W / 2}" y="{y2 + 28}" font-size="12" text-anchor="middle" fill="{muted}">milliseconds</text>')
    out.append(f'<text x="32" y="{H - 34}" font-size="11.5" fill="{muted}">Medians of the repeats after the first request. Old EXACT on its production server, exact-rust on a copy of the same data (its account sees one more team).</text>')
    out.append(f'<text x="32" y="{H - 17}" font-size="11.5" fill="{muted}">Measured over wifi: differences below about 50 ms are noise.</text>')
    out.append("</svg>")
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--report")
    ap.add_argument("--summary")
    ap.add_argument("--save-summary")
    ap.add_argument("--out", default="docs/assets")
    a = ap.parse_args()
    if a.report:
        summary = reduce_report(json.loads(pathlib.Path(a.report).read_text()))
        if a.save_summary:
            pathlib.Path(a.save_summary).write_text(json.dumps(summary, indent=1))
    elif a.summary:
        summary = json.loads(pathlib.Path(a.summary).read_text())
    else:
        ap.error("--report or --summary")
    out = pathlib.Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for mode in ("light", "dark"):
        (out / f"performance-{mode}.svg").write_text(render(summary, mode))
        print("written", out / f"performance-{mode}.svg")


if __name__ == "__main__":
    main()
