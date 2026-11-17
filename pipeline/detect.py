"""Experimental baseline candidate detection (decisions 28-30, junction J14).

Classical multi-scale Hessian "dot" filter (Li, Sone & Doi 2003 style) inside the
lungmask, computed on a 2x in-plane downsampled volume (~1.3 mm voxels).
No training, so no leakage: it can be scored on every case.

PARAMETERS ARE FIXED BEFORE SCORING (do not tune on the results):
  scales (mm)      : 1.5, 2.5, 4, 6     (nodules ~4-30 mm)
  candidate HU     : > -750 at the peak (keeps ground-glass)
  non-max radius   : 6 mm
  output           : top 10 per scan, ranked by dot score
Writes candidates.json per case and eval/detection.json.
"""
import json, pathlib, sys
import numpy as np, SimpleITK as sitk
from scipy import ndimage as ndi

ROOT = pathlib.Path(__file__).parent.parent
CASES = ROOT / "web" / "app" / "public" / "cases"
SCALES_MM = [1.5, 2.5, 4.0, 6.0]
TOPK = 10


def dot_filter(vol, sp):
    best = np.zeros(vol.shape, np.float32)
    best_s = np.zeros(vol.shape, np.float32)
    v = vol.astype(np.float32)
    for s in SCALES_MM:
        sig = [s / sp[2], s / sp[1], s / sp[0]]  # z, y, x in voxels
        H = {}
        for a, b in [(0, 0), (1, 1), (2, 2), (0, 1), (0, 2), (1, 2)]:
            order = [0, 0, 0]; order[a] += 1; order[b] += 1
            H[(a, b)] = ndi.gaussian_filter(v, sig, order=order) * (s ** 2)
        # eigenvalues of symmetric 3x3 per voxel
        M = np.stack([np.stack([H[(0, 0)], H[(0, 1)], H[(0, 2)]], -1),
                      np.stack([H[(0, 1)], H[(1, 1)], H[(1, 2)]], -1),
                      np.stack([H[(0, 2)], H[(1, 2)], H[(2, 2)]], -1)], -2)
        ev = np.linalg.eigvalsh(M)  # ascending: l1 <= l2 <= l3
        l1, l2, l3 = ev[..., 0], ev[..., 1], ev[..., 2]
        # bright blob: all negative; dot = |l3|^2/|l1| (l3 is the smallest magnitude)
        dot = np.where((l3 < 0), (l3 ** 2) / np.maximum(np.abs(l1), 1e-3), 0).astype(np.float32)
        upd = dot > best
        best[upd] = dot[upd]; best_s[upd] = s
        del H, M, ev
    return best, best_s


def detect(case_dir):
    meta = json.loads((case_dir / "meta.json").read_text())
    ct_img = sitk.ReadImage(str(case_dir / "ct.nii.gz"))
    ct = sitk.GetArrayFromImage(ct_img).astype(np.float32)
    lungs = sitk.GetArrayFromImage(sitk.ReadImage(str(case_dir / "lungs.nii.gz"))) > 0
    sp = list(ct_img.GetSpacing())
    f = 2  # in-plane downsample
    ctd = ndi.zoom(ct, (1, 1 / f, 1 / f), order=1)
    lud = ndi.zoom(lungs.astype(np.uint8), (1, 1 / f, 1 / f), order=0) > 0
    spd = [sp[0] * f, sp[1] * f, sp[2]]
    score, scale = dot_filter(np.clip(ctd, -1000, 400), spd)
    score[~lud] = 0
    score[ctd < -750] = 0
    r = [max(1, int(round(6 / spd[2]))), int(round(6 / spd[1])), int(round(6 / spd[0]))]
    mx = ndi.maximum_filter(score, size=[2 * x + 1 for x in r])
    peaks = np.argwhere((score == mx) & (score > 0))
    vals = score[tuple(peaks.T)]
    order = np.argsort(-vals)[:TOPK]
    cands = []
    for rank, i in enumerate(order):
        z, y, x = peaks[i]
        cands.append(dict(rank=rank + 1, vox=[int(x * f + f // 2), int(y * f + f // 2), int(z)],
                          score=float(vals[i]), scale_mm=float(scale[z, y, x]), hu=float(ctd[z, y, x])))
    (case_dir / "candidates.json").write_text(json.dumps(dict(method="hessian-dot v1", params=dict(scales_mm=SCALES_MM, topk=TOPK, min_hu=-750, nms_mm=6), candidates=cands), indent=1))
    meta.setdefault("files", {})["candidates"] = "candidates.json"
    (case_dir / "meta.json").write_text(json.dumps(meta, indent=1))
    return meta, cands, sp


def truths(case_dir, meta, sp):
    """Expert nodules: (centroid voxel, radius mm). RIDER: components of the GTV; LIDC: listed nodules."""
    ref = sitk.GetArrayFromImage(sitk.ReadImage(str(case_dir / meta["files"]["refs"]["expert"]))) > 0
    lab, n = ndi.label(ref)
    out = []
    for k in range(1, n + 1):
        zz, yy, xx = np.nonzero(lab == k)
        if len(zz) < 10:
            continue
        ext = max((xx.max() - xx.min() + 1) * sp[0], (yy.max() - yy.min() + 1) * sp[1])
        out.append(dict(c=[xx.mean(), yy.mean(), zz.mean()], r=ext / 2, mask=(lab == k)))
    return out


if __name__ == "__main__":
    ids = sys.argv[1:] or sorted(d.name for d in CASES.iterdir() if (d / "meta.json").exists())
    rows = []
    for cid in ids:
        d = CASES / cid
        meta, cands, sp = detect(d)
        T = truths(d, meta, sp)
        for t in T:
            hit_rank = None
            for c in cands:
                x, y, z = c["vox"]
                inside = t["mask"][min(z, t["mask"].shape[0] - 1), min(y, t["mask"].shape[1] - 1), min(x, t["mask"].shape[2] - 1)]
                dist = np.sqrt(((x - t["c"][0]) * sp[0]) ** 2 + ((y - t["c"][1]) * sp[1]) ** 2 + ((z - t["c"][2]) * sp[2]) ** 2)
                if inside or dist <= max(5, t["r"]):
                    hit_rank = c["rank"]; break
            rows.append(dict(case_id=cid, source=meta.get("source"), teaching_case=meta.get("teaching_case"),
                             size_mm=round(2 * t["r"], 1), hit_rank=hit_rank))
        hits = {r_["hit_rank"] for r_ in rows if r_["case_id"] == cid and r_["hit_rank"]}
        print(cid, "nodules", len(T), "hit ranks", [r_["hit_rank"] for r_ in rows if r_["case_id"] == cid],
              "FP@10", len(cands) - len(hits), flush=True)
    (ROOT / "eval" / "detection.json").write_text(json.dumps(rows, indent=1))
