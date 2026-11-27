#!/usr/bin/env python3
"""Queue worker for the EXACT Rust server: hosts plugins and works off the common job queue.

On start it announces the plugins it can run (`POST /api/v2/plugins/register`), then claims jobs from
`POST /api/v2/jobs/claim` and runs them with the plugin the job names. Registration plugins and image analysis plugins (helpers/plugins/*.py, interface in
helpers/queue_plugin.py) are served; an analysis plugin finds the image file on the server, as a registration plugin does. Several workers can run side by side; a job whose worker disappears is claimed again after its lease (30 minutes).

    queue_worker.py --url http://localhost:8000 --user worker --password ... [--name w1] [--once] [--only quad]

The worker runs on a machine that sees the image files under the same paths as the server (it receives absolute paths). The
user needs the Django permissions `processing.add_plugin` and `images.change_imageregistration`. With
`--exact-dir <EXACT checkout>/exact` (or EXACT_DIR) EXACT's own slide readers are used, which also read the formats OpenSlide
does not.
"""
import argparse
import base64
import contextlib
import importlib.util
import json
import multiprocessing
import os
import pathlib
import signal
import socket
import sys
import threading
import time
import traceback
import urllib.error
import urllib.request
import uuid

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from queue_plugin import IMAGE_ANALYSIS, REGISTRATION, Context  # noqa: E402


class Api:
    def __init__(self, url, user, password):
        self.url = url.rstrip("/")
        self.auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()

    def call(self, path, body=None, files=None):
        headers = {"Authorization": self.auth}
        if files:
            boundary = uuid.uuid4().hex
            parts = []
            for k, v in (body or {}).items():
                parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
            for k, (name, data) in files.items():
                parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{name}"\r\n'
                             f"Content-Type: application/octet-stream\r\n\r\n".encode() + data + b"\r\n")
            parts.append(f"--{boundary}--\r\n".encode())
            data = b"".join(parts)
            headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
        else:
            data = json.dumps(body or {}).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.url + path, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode(errors="replace")


# ---------------------------------------------------------------------------------------------------------------------------------
# a job runs in a process of its own
# ---------------------------------------------------------------------------------------------------------------------------------

class JobFailed(RuntimeError):
    """The job's process failed in a way a plugin cannot report itself (no memory left, killed, crashed)."""


def memory_limit():
    """Bytes the processes of one job may use together: EXACT_WORKER_MAX_GB, else 45 % of the memory of the machine; None when neither is
    known. A runaway job (a slide read whole at full resolution is tens of gigabytes) is stopped at this, and fails, before the system
    kills the worker."""
    gb = os.environ.get("EXACT_WORKER_MAX_GB")
    if gb:
        return float(gb) * 2**30
    try:
        return 0.45 * os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (ValueError, OSError, AttributeError):
        return None


def tree_rss(pid):
    """Resident memory in bytes of the process and all that it started (Linux: /proc); None where that cannot be read."""
    try:
        page = os.sysconf("SC_PAGE_SIZE")
        parent_of, resident = {}, {}
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            try:
                with open(f"/proc/{entry}/stat") as f:
                    stat = f.read()
                parent_of[int(entry)] = int(stat[stat.rindex(")") + 2 :].split()[1])
                with open(f"/proc/{entry}/statm") as f:
                    resident[int(entry)] = int(f.read().split()[1]) * page
            except (OSError, ValueError):
                continue  # gone meanwhile
        family, grew = {pid}, True
        while grew:
            grew = False
            for child, parent in parent_of.items():
                if parent in family and child not in family:
                    family.add(child)
                    grew = True
        return sum(resident.get(p, 0) for p in family)
    except (OSError, ValueError):
        return None


def _child(conn, fn):
    try:
        os.setsid()  # its own process group: the whole group can be stopped, with whatever the plugin started
    except OSError:
        pass
    try:
        conn.send(("ok", fn()))
    except BaseException:  # noqa: BLE001 - everything is reported to the worker
        conn.send(("error", traceback.format_exc()))


def run_isolated(fn, limit=None, poll=1.0):
    """Runs `fn()` in a child process and returns its result (or raises what failed there). A job that runs out of memory, is killed by
    the system or crashes in a C library (libjpeg ends the process on a damaged tile) then fails the job only, and the worker lives on.
    The memory of the child and what it started is watched; above `limit` bytes it is stopped. Without fork (Windows) `fn` runs here."""
    try:
        ctx = multiprocessing.get_context("fork")
    except ValueError:
        return fn()
    receive, send = ctx.Pipe(duplex=False)
    child = ctx.Process(target=_child, args=(send, fn), daemon=True)
    child.start()
    send.close()

    def stop():
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            child.kill()
        child.join()

    message = None
    while message is None:
        if receive.poll(poll):
            try:
                message = receive.recv()
            except EOFError:
                break
            continue
        if not child.is_alive():
            if receive.poll(0.2):
                continue
            break
        used = tree_rss(child.pid) if limit else None
        if used is not None and used > limit:
            stop()
            raise JobFailed(f"The job needed more than {limit / 2**30:.0f} GB of memory and was stopped (worker limit EXACT_WORKER_MAX_GB). "
                            f"It had reached {used / 2**30:.0f} GB: the images are probably too large for this plugin's settings.")
    child.join(5)
    if child.is_alive():
        stop()
    if message is None:
        code = child.exitcode
        how = f"was killed by signal {-code} ({signal.Signals(-code).name})" if code is not None and code < 0 else f"ended with exit code {code}"
        raise JobFailed(f"The process that ran the job {how} without a result: most likely it ran out of memory (killed by the system) "
                        "or crashed in a library while reading a damaged image.")
    kind, payload = message
    if kind == "error":
        raise JobFailed(payload)
    return payload


def load_plugins(folder, only=None):
    """Every plugin of the modules in `folder` (each lists them in `PLUGINS`); `only` keeps those whose name contains it."""
    found = []
    for path in sorted(pathlib.Path(folder).glob("*.py")):
        spec = importlib.util.spec_from_file_location(f"exact_plugin_{path.stem}", path)
        module = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(module)
        except Exception:  # noqa: BLE001 - a broken plugin must not stop the others
            print(f"plugin {path.name} cannot be loaded:\n{traceback.format_exc()}", file=sys.stderr, flush=True)
            continue
        found += [p for p in getattr(module, "PLUGINS", []) if not only or only.lower() in p.name.lower() or only.lower() in path.stem]
    return found


def announce(api, plugins):
    """Registers the plugins that can run here; the server answers their ids. {id: plugin}. A plugin the server refuses is reported
    and left out: it must not keep the others from being served."""
    ids = {}
    for p in plugins:
        why = p.unavailable()
        if why:
            print(f"plugin {p.name!r} not served: {why}", file=sys.stderr, flush=True)
            continue
        status, body = api.call("/api/v2/plugins/register", p.describe())
        if status not in (200, 201):
            print(f"plugin {p.name!r} cannot be registered: {status} {body}", file=sys.stderr, flush=True)
            continue
        ids[body["id"]] = p
    return ids


@contextlib.contextmanager
def heartbeat(api, name, plugins, running=None, every=20.0):
    """Tells the server now and then that this worker is alive. While a long job runs the worker does not claim, and the server
    would otherwise stop listing its plugins as served after a minute or so. `running` (a list that the job handlers keep) names the jobs
    in progress: the server renews their lease, or a job of more than 30 minutes would be taken by another worker."""
    kinds = sorted({"registration" if p.plugin_type == REGISTRATION else "plugin" for p in plugins.values()})
    done = threading.Event()

    def beat():
        while not done.wait(every):
            try:
                api.call("/api/v2/jobs/heartbeat", {"worker": name, "kinds": kinds, "plugins": list(plugins), "jobs": list(running or [])})
            except Exception:  # noqa: BLE001 - a missed beat is not worth stopping the job
                pass

    t = threading.Thread(target=beat, daemon=True)
    t.start()
    try:
        yield
    finally:
        done.set()


def work(api, name, plugins, ctx, running=None):
    """One job, if there is one. Returns whether a job was handled."""
    registration = {i: p for i, p in plugins.items() if p.plugin_type == REGISTRATION}
    analysis = {i: p for i, p in plugins.items() if p.plugin_type == IMAGE_ANALYSIS}
    if registration:
        status, claimed = api.call("/api/v2/jobs/claim", {"worker": name, "kinds": ["registration"], "plugins": list(registration)})
        if status == 200:
            return work_registration(api, name, registration, claimed["job"], ctx, running)
        if status != 204:
            raise RuntimeError(f"claim failed: {status} {claimed}")
    for plugin_id, plugin in analysis.items():  # a claim names one plugin: the jobs of the others wait for their own worker
        status, claimed = api.call("/api/v2/jobs/claim", {"worker": name, "kinds": ["plugin"], "plugin": plugin_id})
        if status == 200:
            return work_analysis(api, name, plugin, claimed["job"], ctx, running)
        if status != 204:
            raise RuntimeError(f"claim failed: {status} {claimed}")
    return False


def work_analysis(api, name, plugin, job, ctx, running=None):
    """An image analysis job: run the plugin, store its detections in one request."""
    path = f"/api/v2/plugin-jobs/{job['id']}"
    print(f"job {job['id']}: {plugin.name}: image {job['image']}", flush=True)
    ctx.progress = lambda percent: api.call(f"{path}/progress", {"worker": name, "progress": percent})
    started = time.time()
    try:
        if running is not None:
            running.append(job["id"])
        result = run_isolated(lambda: plugin.run(job, ctx), memory_limit())
        wanted = result.annotation_type.lower()
        atype = next((t for t in job.get("annotation_types", []) if wanted in t["name"].lower()), None)
        if atype is None:  # as QueueRunner: the type has to exist, and to belong to the product the plugin is applied under
            api.call(f"{path}/fail", {"worker": name, "error": "Error: Missing annotation type",
                                      "detail": f"Annotation class {result.annotation_type!r} is required but the image set has no such type"})
            print(f"job {job['id']}: no annotation type {result.annotation_type!r} in the image set", file=sys.stderr, flush=True)
            return True
    except Exception as e:  # noqa: BLE001 - every failure is reported to the server
        msg = traceback.format_exc()
        print(msg, file=sys.stderr, flush=True)
        api.call(f"{path}/fail", {"worker": name, "error": f"Error: {type(e).__name__}", "detail": msg[-3500:]})
        return True
    status, body = api.call(f"{path}/complete", {"worker": name, "annotation_type": atype["id"], "name": result.name,
                                                "default_threshold": result.default_threshold, "detections": result.detections})
    if status != 201:
        print(f"job {job['id']}: the server refused the result: {status} {body}", file=sys.stderr, flush=True)
        api.call(f"{path}/fail", {"worker": name, "error": "Error: the result was refused", "detail": str(body)[:3500]})
        return True
    print(f"job {job['id']}: done, {len(result.detections)} detections in {time.time() - started:.0f} s", flush=True)
    return True


def work_registration(api, name, registration, job, ctx, running=None):
    named = (job.get("plugin") or {}).get("id")
    plugin = registration.get(named) or next(iter(registration.values()))  # a job without plugin: the first one we serve
    print(f"job {job['id']}: {plugin.name}: registering image {job['source_image']} onto {job['target_image']}", flush=True)
    try:
        if running is not None:
            running.append(job["id"])
        result = run_isolated(lambda: plugin.run(job, ctx), memory_limit())
    except Exception:  # noqa: BLE001 - every failure is reported to the server
        msg = traceback.format_exc()[-3500:]
        print(msg, file=sys.stderr, flush=True)
        api.call(f"/api/v2/registration-jobs/{job['id']}/fail", {"worker": name, "error": msg})
        return True
    fields = {"worker": name, "registration_error": result.error, "runtime": result.runtime}
    if result.file:  # multipart: the matrix as JSON text, the plugin's file as file
        status, body = api.call(f"/api/v2/registration-jobs/{job['id']}/complete", {**fields, "transformation_matrix": json.dumps(result.matrix)},
                                files={"file": (f"{job['id']}.pickle", result.file)})
    else:
        status, body = api.call(f"/api/v2/registration-jobs/{job['id']}/complete", {**fields, "transformation_matrix": result.matrix})
    if status != 200:
        print(f"job {job['id']}: the server refused the result: {status} {body}", file=sys.stderr, flush=True)
    print(f"job {job['id']}: done ({status}), error {result.error:.3f}", flush=True)
    return True


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=os.environ.get("EXACT_URL", "http://127.0.0.1:8000"))
    ap.add_argument("--user", default=os.environ.get("EXACT_USER"))
    ap.add_argument("--password", default=os.environ.get("EXACT_PASSWORD"))
    ap.add_argument("--name", default=f"{socket.gethostname()}-{os.getpid()}")
    ap.add_argument("--exact-dir", default=os.environ.get("EXACT_DIR"))
    ap.add_argument("--plugins", default=str(HERE / "plugins"), help="folder with the plugin modules")
    ap.add_argument("--only", help="serve only the plugins whose name contains this")
    ap.add_argument("--interval", type=float, default=5.0, help="seconds between polls when idle")
    ap.add_argument("--once", action="store_true", help="work off the queue and exit")
    a = ap.parse_args(argv)
    if not a.user or not a.password:
        ap.error("--user and --password (or EXACT_USER / EXACT_PASSWORD) are required")
    api = Api(a.url, a.user, a.password)
    plugins = load_plugins(a.plugins, a.only)
    ctx = Context(exact_dir=a.exact_dir)
    served, announced = {}, 0.0
    print(f"worker {a.name} starting: server {a.url or api.url}, {len(plugins)} plugin(s) loaded from {a.plugins}", flush=True)
    last_served = None
    while True:
        try:
            if not served or time.time() - announced > 600:  # again now and then, so the server sees plugin changes
                served, announced = announce(api, plugins), time.time()
                if sorted(p.name for p in served.values()) != last_served:  # said when it changes: an idle worker is otherwise silent
                    last_served = sorted(p.name for p in served.values())
                    print(f"worker {a.name} serves: {', '.join(last_served) or 'nothing'}", flush=True)
                if not served:
                    print("no plugin can run here", file=sys.stderr, flush=True)
                    if a.once:
                        return 1
                    time.sleep(a.interval)
                    continue
            running = []
            with heartbeat(api, a.name, served, running):
                busy = work(api, a.name, served, ctx, running)
        except Exception as e:  # noqa: BLE001 - keep polling when the server is unreachable
            print(f"worker error: {e}", file=sys.stderr, flush=True)
            busy = False
            if a.once:
                return 1
        if not busy:
            if a.once:
                return 0
            time.sleep(a.interval)


if __name__ == "__main__":
    sys.exit(main())
