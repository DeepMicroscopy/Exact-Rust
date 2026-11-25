#!/usr/bin/env python3
"""Runs one VALIS registration in a process of its own (the VALIS plugin starts it, with the Python that has `valis-wsi`).

    valis_run.py <folder>   reads <folder>/params.json and <folder>/slides/source.png, target.png;
                            writes <folder>/mapped.npy (the grid of source overview points sent through the registration: (H, W, 2)
                            target overview pixels), <folder>/grid.json (the source overview pixels of the grid) and <folder>/stats.json

A separate process: VALIS starts a JVM and loads its own native libraries (libvips, OpenCV), which must not meet those of the worker.
"""
import json
import pathlib
import sys


def main(folder):
    import numpy as np
    from valis import non_rigid_registrars, registration

    folder = pathlib.Path(folder)
    p = json.loads((folder / "params.json").read_text())
    kw = dict(
        name="exact",
        imgs_ordered=True,
        reference_img_f="target.png",
        align_to_reference=True,
        max_processed_image_dim_px=int(p["processed_size"]),
        max_non_rigid_registration_dim_px=int(p["non_rigid_size"]),
        create_masks=bool(p["masks"]),
        crop_for_rigid_reg=True,
        non_rigid_registrar_cls=None if p["mode"] == "rigid" else non_rigid_registrars.OpticalFlowWarper,
    )
    if p["image_type"] != "auto":
        kw["image_type"] = p["image_type"]
    if p["feature_detector"] != "default":
        from valis import feature_detectors

        kw["feature_detector_cls"] = {"vgg": feature_detectors.VggFD, "orb_vgg": feature_detectors.OrbVggFD, "superpoint": feature_detectors.SuperPointFD}[p["feature_detector"]]
    try:
        # files are named so that VALIS keeps the order: the source is moved onto the target (the reference)
        registrar = registration.Valis(str(folder / "slides"), str(folder / "out"), **kw)
        _, _, summary = registrar.register()
        src, tgt = registrar.get_slide("source.png"), registrar.get_slide("target.png")
        w, h = (int(v) for v in p["overview"])
        n = int(p["grid"])
        xs = np.linspace(0, w, n)
        ys = np.linspace(0, h, n)
        gx, gy = np.meshgrid(xs, ys)
        xy = np.stack([gx.ravel(), gy.ravel()], axis=1)
        mapped = src.warp_xy_from_to(xy, tgt, non_rigid=p["mode"] != "rigid")
        np.save(folder / "mapped.npy", np.asarray(mapped, dtype=np.float64).reshape(n, n, 2))
        (folder / "grid.json").write_text(json.dumps({"xs": xs.tolist(), "ys": ys.tolist()}))
        stats = {}
        try:
            row = summary[summary["from"].astype(str).str.contains("source")].iloc[0]
            stats = {k: (None if v != v else float(v)) for k, v in row.items() if isinstance(v, (int, float)) and k.endswith(("_D", "_rTRE", "TRE", "_time_minutes"))}
            stats["resolution"] = float(row["resolution"])  # the distances ("D") are in pixels times this
            stats["columns"] = [str(c) for c in summary.columns]
        except Exception as e:  # noqa: BLE001 - the numbers are for the log, the registration is what matters
            stats = {"summary_error": f"{type(e).__name__}: {e}"}
        (folder / "stats.json").write_text(json.dumps(stats))
    finally:
        registration.kill_jvm()


if __name__ == "__main__":
    main(sys.argv[1])
