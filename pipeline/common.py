"""Shared writer for web-ready cases (NIfTI .nii.gz + meta.json)."""
import json, pathlib
import numpy as np
import SimpleITK as sitk

PIPELINE_VERSION = "0.1.0"


def _like(arr, ref_img, dtype):
    im = sitk.GetImageFromArray(arr.astype(dtype))
    im.CopyInformation(ref_img)
    return im


_INF = {}


def unet_lungs(img):
    """lungmask R231 (includes dense pathology) and LTRCLobes labels
    (1 LUL, 2 LLL, 3 RUL, 4 RML, 5 RLL)."""
    from lungmask import LMInferer
    if not _INF:
        _INF["r231"] = LMInferer(modelname="R231", tqdm_disable=True)
        _INF["lobes"] = LMInferer(modelname="LTRCLobes", fillmodel="R231", tqdm_disable=True)
    return _INF["r231"].apply(img), _INF["lobes"].apply(img)


def write_case(out_dir, img, ct, lungs, refs, meta, source, lobes=None):
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    sitk.WriteImage(_like(ct, img, np.int16), str(out / "ct.nii.gz"), useCompression=True)
    sitk.WriteImage(_like(lungs, img, np.uint8), str(out / "lungs.nii.gz"), useCompression=True)
    if lobes is not None:
        sitk.WriteImage(_like(lobes, img, np.uint8), str(out / "lobes.nii.gz"), useCompression=True)
    ref_files = {}
    for name, m in refs.items():
        fn = f"ref_{name}.nii.gz"
        sitk.WriteImage(_like(m, img, np.uint8), str(out / fn), useCompression=True)
        ref_files[name] = fn
    meta = dict(meta)
    meta.update(
        case_id=out.name, source=source, pipeline_version=PIPELINE_VERSION,
        dims=list(img.GetSize()), spacing=list(img.GetSpacing()),
        origin=list(img.GetOrigin()), direction=list(img.GetDirection()),
        files=dict(ct="ct.nii.gz", lungs="lungs.nii.gz", refs=ref_files,
                   lobes="lobes.nii.gz" if lobes is not None else None),
    )
    (out / "meta.json").write_text(json.dumps(meta, indent=1))
    return meta


def build_manifest(cases_dir, extra=None):
    cases_dir = pathlib.Path(cases_dir)
    items = []
    order = {"test": 0, "baseline": 0, "retest": 1}
    def key(m):
        d = json.loads(m.read_text())
        return (d.get("source") != "RIDER", d.get("patient_id"), order.get(d.get("timepoint"), 2))
    for m in sorted(cases_dir.glob("*/meta.json"), key=key):
        d = json.loads(m.read_text())
        items.append({k: d.get(k) for k in (
            "case_id", "source", "patient_id", "timepoint", "scan_date", "series_number",
            "slice_thickness_mm", "teaching_case", "difficulty", "pair", "tags")})
        items[-1]["pair"] = {k: v for k, v in (d.get("pair") or {}).items() if k != "M_to_pair"} or None
    man = dict(pipeline_version=PIPELINE_VERSION, cases=items, **(extra or {}))
    (cases_dir.parent / "manifest.json").write_text(json.dumps(man, indent=1))
    return man
