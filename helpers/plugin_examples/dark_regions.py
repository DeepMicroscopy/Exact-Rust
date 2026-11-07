"""Example image analysis plugin: finds dark regions (pen marks, dense tissue, debris) and stores them as boxes.

It is the smallest useful analysis plugin: it opens the slide, looks at a small overview, finds connected dark areas with OpenCV and
returns them as detections in the pixels of the full-resolution image. Copy it, rename it, replace `analyze`.

Run a worker with it (the worker announces it to the server and takes the jobs of this plugin):

    python helpers/queue_worker.py --url http://localhost:8002 --user worker --password ... --plugins helpers/plugin_examples --only dark

The example folder is not loaded by the normal worker (it reads `helpers/plugins/` only).
"""
import sys

sys.path.insert(0, __file__.rsplit("/", 2)[0])  # helpers/, for queue_plugin and plugins_common when run from anywhere
from plugins_common import open_slide  # noqa: E402
from queue_plugin import AnalysisResult, ImageAnalysisPlugin, param  # noqa: E402


class DarkRegions(ImageAnalysisPlugin):
    name = "Example: dark regions"
    author = "EXACT-Rust documentation"
    package = "org.example.dark-regions"       # unique: tells this plugin from others of the same name
    abouturl = "https://deepmicroscopy.github.io/Exact-Rust/howto-plugin"
    parameters = [                              # the web UI builds a form from this; the job's values come in `params`
        param("darkness", "int", 90, "Darkness", "Grey values below this (0 black, 255 white) count as dark.", min=1, max=254),
        param("min_area", "int", 50, "Smallest region", "Regions with fewer pixels than this (on the overview) are ignored.", min=1, max=100000),
        param("annotation_type", "text", "annotation", "Annotation type", "Detections are stored as the type of the image set whose name contains this."),
    ]

    def unavailable(self):
        """Why the plugin cannot run on this machine, or None. The worker then says so and does not announce it."""
        try:
            import cv2  # noqa: F401
            import numpy  # noqa: F401
        except ImportError as e:
            return f"OpenCV and numpy are required ({e})"
        return None

    def analyze(self, image_path, params, ctx):
        import cv2
        import numpy as np

        slide = open_slide(image_path, ctx.exact_dir)          # EXACT's readers when the worker has --exact-dir, else OpenSlide
        width, height = slide.dimensions
        # a level of about 1/16 resolution is plenty for dark regions
        level = max((i for i, d in enumerate(slide.level_downsamples) if d <= 16.5), key=lambda i: slide.level_downsamples[i])
        w, h = slide.level_dimensions[level]
        ds = slide.level_downsamples[level]
        overview = np.array(slide.read_region((0, 0), level, (w, h)).convert("RGB"))
        ctx.progress(30)                                       # shown on the Jobs page

        grey = cv2.cvtColor(overview, cv2.COLOR_RGB2GRAY)
        mask = (grey < params["darkness"]).astype(np.uint8)
        count, _, stats, _ = cv2.connectedComponentsWithStats(mask)
        found = []
        for x, y, bw, bh, area in stats[1:]:                   # row 0 is the background
            if area >= params["min_area"]:
                found.append({"vector": {"x1": round(x * ds), "y1": round(y * ds),
                                         "x2": min(width, round((x + bw) * ds)), "y2": min(height, round((y + bh) * ds))},
                              "score": min(1.0, float(area) / (w * h) * 20)})   # any number in 0..1; the UI can threshold on it
        ctx.log(f"{len(found)} regions")
        return AnalysisResult(found, params["annotation_type"], "Dark regions", default_threshold=0.0)


PLUGINS = [DarkRegions()]
