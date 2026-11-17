"""Prepare LIDC-IDRI scans whose nodules match Daniel's hard teaching cases.

Each selected nodule keeps every reader's outline (ref_r1..r4, reader order is
arbitrary per nodule - LIDC has no stable reader ids) and a 50% consensus
(ref_expert) that the viewer shows. Inter-reader spread is the accuracy bar (decision 38).
"""
import sys, pathlib
import numpy as np
import numpy.ma  # noqa
np.int = int; np.float = float
import pylidc as pl
import SimpleITK as sitk
import pydicom, glob
from scipy import ndimage as ndi
from skimage.draw import polygon as draw_polygon
from tcia import download_series
from common import write_case, unet_lungs
from prepare_rider import read_ct, lung_constraint, crop_box

RAW = pathlib.Path(__file__).parent.parent / "data" / "raw"
OUT = pathlib.Path(__file__).parent.parent / "web" / "app" / "public" / "cases"

# patient -> (teaching case label, difficulty, selector on cluster medians)
SELECT = {
    "LIDC-IDRI-0088": ("faint ground-glass", "hard", lambda t, s, d: t <= 2),
    "LIDC-IDRI-0828": ("part-solid", "medium", lambda t, s, d: t == 3),  # J13: replaces 0590 (0.625 mm overlapping slices, 67 MB)
    "LIDC-IDRI-0915": ("spiculated", "hard", lambda t, s, d: s >= 4),
    "LIDC-IDRI-0017": ("small solid (subtle)", "hard", lambda t, s, d: t == 5 and d <= 9),
    "LIDC-IDRI-0164": ("solid (easy)", "easy", lambda t, s, d: t == 5 and d >= 12),
}


def ann_mask(ann, img, shape):
    m = np.zeros(shape, np.uint8)
    for c in ann.contours:
        ij = c.to_matrix(include_k=False)  # rows (i), cols (j)
        z = float(c.image_z_position)
        # physical -> slice index (direction is axial in LIDC)
        k = int(round(img.TransformPhysicalPointToContinuousIndex((img.GetOrigin()[0], img.GetOrigin()[1], z))[2]))
        if not 0 <= k < shape[0]:
            continue
        rr, cc = draw_polygon(ij[:, 0], ij[:, 1], shape=shape[1:])
        sl = np.zeros(shape[1:], np.uint8)
        sl[rr, cc] = 1
        sl[ij[:, 0].clip(0, shape[1] - 1), ij[:, 1].clip(0, shape[2] - 1)] = 1  # include boundary pixels
        m[k] |= sl
    return m


def process(pid):
    label, diff, sel = SELECT[pid]
    scan = pl.query(pl.Scan).filter(pl.Scan.patient_id == pid, pl.Scan.slice_thickness <= 1.25).first()
    sdir = download_series(scan.series_instance_uid, RAW)
    img, meta = read_ct(sdir)
    ct = sitk.GetArrayFromImage(img).astype(np.int16)
    shape = ct.shape
    readers = [np.zeros(shape, np.uint8) for _ in range(4)]
    nodules = []
    for anns in scan.cluster_annotations(verbose=False):
        if len(anns) < 3:
            continue
        med = lambda f: float(np.median([getattr(a, f) for a in anns]))
        t, s, d = med("texture"), med("spiculation"), med("diameter")
        if not sel(t, s, d):
            continue
        ms = [ann_mask(a, img, shape) for a in anns]
        for i, m in enumerate(ms[:4]):
            readers[i] |= m
        cons = (np.sum(ms, axis=0) >= max(2, int(np.ceil(len(ms) / 2)))).astype(np.uint8)
        z, y, x = np.argwhere(cons).mean(0)
        nodules.append(dict(readers=len(anns), texture=t, spiculation=s, subtlety=med("subtlety"),
                            margin=med("margin"), diameter_mm=round(d, 1), centroid_vox=[float(x), float(y), float(z)],
                            _cons=cons))
    if not nodules:
        print("no nodules selected for", pid); return
    expert = np.zeros(shape, np.uint8)
    for n in nodules:
        expert |= n.pop("_cons")
    unet, lobes = unet_lungs(img)
    lungs = ndi.binary_dilation(unet > 0, structure=np.ones((1, 5, 5)))
    allref = expert.astype(bool) | np.any(readers, axis=0)
    cover = float((allref & lungs).sum() / max(1, allref.sum()))
    lo, hi = crop_box(lungs | allref, img.GetSpacing())
    sl = tuple(slice(a, b) for a, b in zip(lo, hi))
    crop = sitk.RegionOfInterest(img, [int(hi[2] - lo[2]), int(hi[1] - lo[1]), int(hi[0] - lo[0])],
                                 [int(lo[2]), int(lo[1]), int(lo[0])])
    for n in nodules:
        c = n["centroid_vox"]; n["centroid_vox"] = [c[0] - lo[2], c[1] - lo[1], c[2] - lo[0]]
    refs = {"expert": expert[sl]}
    for i, r in enumerate(readers):
        if r.any():
            refs[f"r{i + 1}"] = r[sl]
    meta.update(timepoint="baseline", teaching_case=label, difficulty=diff, nodules=nodules,
                gtv_lung_coverage=round(cover, 4), reference="LIDC-IDRI readers (>=3), consensus = majority")
    write_case(OUT / f"{pid}", crop, ct[sl], lungs[sl].astype(np.uint8), refs, meta, source="LIDC", lobes=lobes[sl])
    print(f"{pid}: {label} nodules={[(n['diameter_mm'], n['texture'], n['readers']) for n in nodules]} cover={cover:.3f} shape={ct[sl].shape}", flush=True)


if __name__ == "__main__":
    for pid in (sys.argv[1:] or SELECT):
        try:
            process(pid)
        except Exception as e:
            import traceback; traceback.print_exc()
            print("FAILED", pid, e, flush=True)
