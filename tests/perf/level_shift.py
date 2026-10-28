"""How far apart do two zoom levels of the viewer draw the same detail?

Fetches the same region as seen at DeepZoom level L and at the level above (one level more zoomed out, scaled up by 2) and
measures the sub-pixel shift between them by phase correlation. A shift of ~0.5 viewer pixels or more is what shows as
"wobble" when zooming. Usage: level_shift.py <image id> [base url]   (env EXACT_USER / EXACT_PW)"""
import io
import math
import os
import re
import sys

import httpx
import numpy as np
from PIL import Image

img = int(sys.argv[1])
base = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8002"
c = httpx.Client(base_url=base, timeout=120)
r = c.post("/api/v2/auth/login", json={"username": os.environ.get("EXACT_USER", "rt_teamadmin"), "password": os.environ.get("EXACT_PW", "rust-test-pw")})
assert r.status_code == 200, r.text
dzi = c.get(f"/api/v2/images/{img}/1/0/tile").text
W, H = (int(x) for x in re.search(r'Width="(\d+)"', dzi).group(1, 1)), 0
W = int(re.search(r'Width="(\d+)"', dzi).group(1))
H = int(re.search(r'Height="(\d+)"', dzi).group(1))
TS = int(re.search(r'TileSize="(\d+)"', dzi).group(1))
max_level = math.ceil(math.log2(max(W, H)))


def region(level, x0, y0, size):
    """size x size pixels at (x0, y0) of the given DeepZoom level (assembled from tiles)."""
    out = np.zeros((size, size, 3), np.float32)
    for ty in range(y0 // TS, (y0 + size - 1) // TS + 1):
        for tx in range(x0 // TS, (x0 + size - 1) // TS + 1):
            t = c.get(f"/api/v2/images/{img}/1/0/tile_files/{level}/{tx}_{ty}.jpeg")
            if t.status_code != 200:
                return None
            a = np.asarray(Image.open(io.BytesIO(t.content)).convert("RGB"), np.float32)
            # tiles carry an overlap of 1 pixel on the inner sides
            ox, oy = (1 if tx > 0 else 0), (1 if ty > 0 else 0)
            a = a[oy:, ox:]
            gx, gy = tx * TS, ty * TS
            sx0, sy0 = max(x0, gx), max(y0, gy)
            sx1, sy1 = min(x0 + size, gx + a.shape[1]), min(y0 + size, gy + a.shape[0])
            out[sy0 - y0:sy1 - y0, sx0 - x0:sx1 - x0] = a[sy0 - gy:sy1 - gy, sx0 - gx:sx1 - gx]
    return out


def highpass(g):
    """Difference of Gaussians (detail only): removes the smooth tissue background that makes phase correlation drift."""
    from scipy.ndimage import gaussian_filter
    return gaussian_filter(g, 1.0) - gaussian_filter(g, 4.0)


def shift(a, b):
    """Sub-pixel shift (dx, dy) of b relative to a: normalised cross-correlation of the detail, parabolic peak refinement."""
    ga, gb = highpass(a.mean(axis=2)), highpass(b.mean(axis=2))
    win = np.outer(np.hanning(ga.shape[0]), np.hanning(ga.shape[1]))
    fa, fb = np.fft.fft2(ga * win), np.fft.fft2(gb * win)
    corr = np.fft.ifft2(fa * np.conj(fb)).real
    iy, ix = np.unravel_index(np.argmax(corr), corr.shape)
    n0, n1 = corr.shape

    def refine(m1, m0, p1, i, n):
        d = m1 - 2 * m0 + p1
        return (i + (0.5 * (m1 - p1) / d if d else 0)) % n

    fx = refine(corr[iy, (ix - 1) % n1], corr[iy, ix], corr[iy, (ix + 1) % n1], ix, n1)
    fy = refine(corr[(iy - 1) % n0, ix], corr[iy, ix], corr[(iy + 1) % n0, ix], iy, n0)
    return ((fx + n1 / 2) % n1 - n1 / 2, (fy + n0 / 2) % n0 - n0 / 2), float(corr.max() / (np.linalg.norm(ga * win) * np.linalg.norm(gb * win) + 1e-9))


def detail(a):
    return float(highpass(a.mean(axis=2)).std())


# candidate spots on a grid; the ones with the most detail are measured (flat tissue or background tells nothing)
spots = [(fx, fy) for fx in (0.2, 0.35, 0.5, 0.65, 0.8) for fy in (0.25, 0.5, 0.75)]
print(f"image {img}: {W} x {H}, DeepZoom levels 0..{max_level}")
results = []
for L in range(max_level - 1, max(max_level - 7, 3), -1):
    cands = []
    lw, lh = math.ceil(W / 2 ** (max_level - L)), math.ceil(H / 2 ** (max_level - L))
    size = 128
    for fx, fy in spots:
        x0, y0 = int(lw * fx) // 2 * 2, int(lh * fy) // 2 * 2
        if x0 + size > lw or y0 + size > lh:
            continue
        a = region(L, x0, y0, size)
        up = region(L - 1, x0 // 2, y0 // 2, size // 2)
        if a is None or up is None:
            continue
        up2 = np.asarray(Image.fromarray(up.astype(np.uint8)).resize((size, size), Image.BICUBIC), np.float32)
        cands.append((detail(a), a, up2))
    cands.sort(key=lambda c: -c[0])
    shifts = []
    for _, a, up2 in cands[:5]:
        (dx, dy), q = shift(a, up2)
        if q > 0.25:  # a clear match
            shifts.append((dx, dy))
    if len(shifts) >= 2:
        dx, dy = np.median([s[0] for s in shifts]), np.median([s[1] for s in shifts])
        print(f"  level {L} vs {L - 1} (x2): shift ({dx:+.2f}, {dy:+.2f}) px   spread {np.ptp([s[0] for s in shifts]):.2f}/{np.ptp([s[1] for s in shifts]):.2f}   ({len(shifts)} spots)")
        results.append(math.hypot(dx, dy))
print("largest shift between neighbouring levels: %.2f px" % (max(results) if results else float("nan")))
