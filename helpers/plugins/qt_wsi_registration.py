"""Registration plugin: `qt-wsi-registration` (SIFT features on a quad tree of tiles), the algorithm of EXACT's
`ImageRegistration.perform_registration`. It is the worked example of a registration plugin: parameters, availability check,
and `register`, which returns the matrix and the pickled quad tree."""
import pickle
import sys

sys.path.insert(0, __file__.rsplit("/", 2)[0])  # helpers/, for queue_plugin when run from anywhere
from queue_plugin import RegistrationPlugin, RegistrationResult, param  # noqa: E402


def open_slide(path, exact_dir):
    if exact_dir:
        if exact_dir not in sys.path:
            sys.path.insert(0, exact_dir)
        from util.slide_server import getSlideHandler  # EXACT's own reader selection: reads every format EXACT does

        return getSlideHandler(path)
    import openslide

    return openslide.OpenSlide(path)


class QtWsiRegistration(RegistrationPlugin):
    name = "Quad-tree SIFT registration"
    author = "DeepMicroscopy"
    package = "qt_wsi_reg"
    abouturl = "https://github.com/DeepMicroscopy/WsiRegistration"
    parameters = [
        param("maxFeatures", "int", 512, "Features per tile", "SIFT keypoints kept per tile; more is slower and finds more matches.", min=32, max=4096),
        param("ratio", "float", 0.7, "Match ratio", "Lowe's ratio test: lower keeps only unambiguous matches.", min=0.1, max=1, step=0.05),
        param("crossCheck", "bool", False, "Cross check", "Keep only matches found in both directions."),
        param("flann", "bool", False, "FLANN matcher", "Approximate nearest neighbours instead of brute force."),
        param("use_gray", "bool", False, "Grayscale", "Match on grayscale instead of colour channels."),
        param("homography", "bool", True, "Homography", "Fit a homography (otherwise an affine transform)."),
        param("filter_outliner", "bool", False, "Filter outliers", "Drop matches far from the fitted transform."),
        param("target_depth", "int", 0, "Quad-tree depth", "Levels of tile refinement; 0 registers the whole slide with one transform.", min=0, max=8),
        param("thumbnail_size", "int", 2048, "Thumbnail size", "Edge length in pixels of the overview the first estimate is made on.", min=256, max=8192),
    ]

    def unavailable(self):
        try:
            import qt_wsi_reg.registration_tree  # noqa: F401
        except Exception as e:  # noqa: BLE001
            return f"qt-wsi-registration is not installed in this Python ({e.__class__.__name__}: {e})"
        return None

    def register(self, source_path, target_path, params, ctx):
        import qt_wsi_reg.registration_tree as registration

        size = params["thumbnail_size"]  # an edge length, or (width, height) as exact-sync sends it
        size = tuple(int(v) for v in size) if isinstance(size, (list, tuple)) else (int(size), int(size))
        qtree = registration.RegistrationQuadTree(
            source_slide=open_slide(source_path, ctx.exact_dir),
            target_slide=open_slide(target_path, ctx.exact_dir),
            point_extractor="sift",
            maxFeatures=int(params["maxFeatures"]),
            crossCheck=bool(params["crossCheck"]),
            flann=bool(params["flann"]),
            ratio=float(params["ratio"]),
            use_gray=bool(params["use_gray"]),
            homography=bool(params["homography"]),
            filter_outliner=bool(params["filter_outliner"]),
            debug=False,
            target_depth=int(params["target_depth"]),
            run_async=True,
            num_workers=4,
            thumbnail_size=size,
        )
        h = qtree.get_homography
        matrix = {f"t_{i}{j}": float(h[i][j]) for i in range(3) for j in range(3)}
        return RegistrationResult(matrix=matrix, error=float(qtree.mean_reg_error), runtime=int(qtree.run_time), file=pickle.dumps(qtree))


PLUGINS = [QtWsiRegistration()]
