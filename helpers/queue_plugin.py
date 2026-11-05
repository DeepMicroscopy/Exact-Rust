"""The plugin interface of the queue worker (helpers/queue_worker.py).

A plugin is a class with a name, the parameters a job accepts and a `run` method. The worker announces every plugin it
can run to the server (`POST /api/v2/plugins/register`), so that it shows up in the administration overview and, for
registration plugins, in the "register" dialog of the web UI with a form for its parameters.

To write a registration plugin: derive from `RegistrationPlugin`, set `name` and `parameters`, implement `register`
(see helpers/plugins/qt_wsi_registration.py), and put the file in helpers/plugins/ with `PLUGINS = [MyPlugin()]`.

An image analysis plugin (a detector, ...) derives from `ImageAnalysisPlugin` and implements `analyze`: it gets the path of
the image file on the server and returns detections (see helpers/plugins/midog2025_fcos.py).
"""
from dataclasses import dataclass, field

IMAGE_ANALYSIS, REGISTRATION = 1, 2


def param(name, type, default=None, label=None, help=None, **extra):
    """One parameter of a plugin. `type` is int, float, bool, text or choice (then `choices=[...]`); `min`, `max` and
    `step` bound numbers. The web UI builds the form from these."""
    p = {"name": name, "type": type, "label": label or name, "default": default}
    if help:
        p["help"] = help
    p.update(extra)
    return p


@dataclass
class Context:
    """What a plugin may need besides the job."""
    exact_dir: str | None = None  # an EXACT checkout (its `exact` folder): its slide readers handle formats OpenSlide does not
    log: callable = print
    progress: callable = lambda percent: None  # an analysis plugin reports 0..99 while it works


class Plugin:
    name = "unnamed plugin"
    author = ""
    package = ""  # the Python package the plugin needs; also tells two plugins of the same name apart
    contact = ""
    abouturl = ""
    plugin_type = IMAGE_ANALYSIS
    parameters: list = []

    def unavailable(self) -> str | None:
        """Why the plugin cannot run here (a missing library, ...), or None."""
        return None

    def describe(self) -> dict:
        return {"name": self.name, "author": self.author, "package": self.package, "contact": self.contact,
                "abouturl": self.abouturl, "plugin_type": self.plugin_type, "parameters_schema": self.parameters}

    def defaults(self) -> dict:
        return {p["name"]: p.get("default") for p in self.parameters}

    def run(self, job: dict, ctx: Context):
        raise NotImplementedError


@dataclass
class RegistrationResult:
    """The outcome of a registration. `matrix` maps source pixels onto target pixels (t_00 .. t_22, row major);
    `file` is whatever the plugin needs to convert coordinates exactly later (qt-wsi-registration: its pickled quad tree)."""
    matrix: dict
    error: float = 0.0  # mean registration error, in target pixels
    runtime: int = 0  # seconds
    file: bytes | None = None
    notes: dict = field(default_factory=dict)


class RegistrationPlugin(Plugin):
    plugin_type = REGISTRATION

    def register(self, source_path: str, target_path: str, params: dict, ctx: Context) -> RegistrationResult:
        """Registers the source image onto the target image; `params` are the job's values merged over the defaults."""
        raise NotImplementedError

    def run(self, job, ctx):
        params = {**self.defaults(), **(job.get("params") or {})}
        return self.register(job["source_path"], job["target_path"], params, ctx)


@dataclass
class AnalysisResult:
    """What an image analysis plugin found. `detections` are `{"vector": {...}, "score": float}`; they are stored as annotations
    of the annotation type of the image's set whose name contains `annotation_type` (case-insensitive)."""
    detections: list
    annotation_type: str
    name: str = "Result"  # the title of the result entry
    default_threshold: float = 0.0  # the score above which the UI shows detections at first


class ImageAnalysisPlugin(Plugin):
    plugin_type = IMAGE_ANALYSIS

    def analyze(self, image_path: str, params: dict, ctx: Context) -> AnalysisResult:
        """Analyzes the image file; `params` are the job's values merged over the defaults. Report progress with `ctx.progress`."""
        raise NotImplementedError

    def run(self, job, ctx):
        params = {**self.defaults(), **(job.get("params") or {})}
        return self.analyze(job["image_path"], params, ctx)
