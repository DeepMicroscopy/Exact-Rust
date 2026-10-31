#!/usr/bin/env python3
"""Runs one DeeperHistReg registration in a process of its own (the DeeperHistReg plugin starts it).

    dhr_run.py <folder>      reads <folder>/params.json and <folder>/source.png, target.png; writes field.npy and padding.json

A separate process because PyTorch hangs when it shares a process with the libraries of qt-wsi-registration (two OpenMP
runtimes), and so that the memory of a large registration is returned to the system afterwards.
"""
import json
import pathlib
import sys


def configuration(p, device):
    import deeperhistreg

    deformable = p["mode"] == "deformable"
    cfg = deeperhistreg.configs.default_nonrigid_fast() if deformable else deeperhistreg.configs.default_initial()
    cfg["device"] = device
    cfg["echo"] = False
    cfg["logging_path"] = None
    cfg["save_final_images"] = False
    cfg["save_final_displacement_field"] = False
    cfg["loading_params"].update(loader="pil", source_resample_ratio=1.0, target_resample_ratio=1.0)
    cfg["saving_params"].update(final_saver="pil", final_extension=".jpg")
    cfg["preprocessing_params"]["initial_resolution"] = int(p["registration_size"])
    cfg["preprocessing_params"]["save_results"] = False
    initial = deeperhistreg.configs.default_initial()["initial_registration_params"]  # the feature based alignment, in both modes
    initial.update(save_results=False, device=device, cuda=device != "cpu", transform_type=p["transform_type"],
                   angle_step=int(p["angle_step"]), run_sift_ransac=bool(p["sift"]), run_superpoint_superglue=bool(p["superglue"]),
                   registration_size=int(p["registration_size"]))
    cfg["run_initial_registration"] = True
    cfg["initial_registration_params"] = initial
    cfg["run_nonrigid_registration"] = deformable
    cfg["nonrigid_registration_params"]["save_results"] = False
    if deformable:
        cfg["nonrigid_registration_params"]["device"] = device
        cfg["nonrigid_registration_params"]["registration_size"] = int(p["registration_size"])
    cfg["case_name"] = "exact"
    return cfg


def main(folder):
    import numpy as np
    import torch
    from deeperhistreg.dhr_pipeline import full_resolution
    from deeperhistreg.dhr_utils import utils as dhr_utils

    folder = pathlib.Path(folder)
    params = json.loads((folder / "params.json").read_text())
    device = params["device"]
    if device == "auto":
        device = "cuda:0" if torch.cuda.is_available() else "cpu"
    print(f"device {device}", flush=True)
    pipeline = full_resolution.DeeperHistReg_FullResolution(configuration(params, device))
    pipeline.run_registration(str(folder / "source.png"), str(folder / "target.png"), str(folder))
    np.save(folder / "field.npy", dhr_utils.tc_df_to_np_df(pipeline.current_displacement_field))
    pads = pipeline.padding_params
    (folder / "padding.json").write_text(json.dumps({
        "pad_source": pads["pad_1"], "pad_target": pads["pad_2"],
        "ratio": pads["initial_resample_ratio"] if pads.get("initial_resampling") else 1.0}))


if __name__ == "__main__":
    main(sys.argv[1])
