"""Tag cases with the closest of Daniel's 8 teaching-case types.

RIDER: one label per patient (from the test scan, else whichever exists), from the
expert outline's long axis measured like measure.ts (edge-to-edge, convex hull of
boundary-pixel corners, largest axial slice of the largest expert component) and
chest-wall contact (share of a 2 mm shell around the outline that lies outside the
lungmask R231 mask, which by design includes tumours).
LIDC: label comes from prepare_lidc.SELECT; tags list nodule sizes and reader counts."""
import json, pathlib
import numpy as np, SimpleITK as sitk
from scipy import ndimage as ndi
from scipy.spatial import ConvexHull

OUT = pathlib.Path(__file__).parent.parent / "web" / "app" / "public" / "cases"


def long_axis_mm(mask, sp):
    lab, n = ndi.label(mask)
    if n > 1:
        sizes = ndi.sum(mask, lab, range(1, n + 1))
        mask = lab == (int(np.argmax(sizes)) + 1)
    z = int(mask.sum((1, 2)).argmax())
    sl = mask[z]
    edge = sl & ~ndi.binary_erosion(sl)
    yy, xx = np.nonzero(edge)
    corners = np.concatenate([np.c_[(xx + dx) * sp[0], (yy + dy) * sp[1]] for dx in (-.5, .5) for dy in (-.5, .5)])
    if len(corners) >= 3:
        corners = corners[ConvexHull(corners).vertices]
    d = np.sqrt(((corners[:, None] - corners[None]) ** 2).sum(-1))
    return float(d.max()), mask


def wall_contact(mask, lungs):
    shell = ndi.binary_dilation(mask, structure=np.ones((1, 7, 7))) & ~mask
    return float((shell & ~lungs).sum() / max(1, shell.sum()))


patients = {}
for d in sorted(OUT.glob("RIDER-*")):
    pid, tp = d.name.rsplit("_", 1)
    patients.setdefault(pid, {})[tp] = d

for pid, scans in patients.items():
    src = scans.get("test") or next(iter(scans.values()))
    meta = json.loads((src / "meta.json").read_text())
    ref = sitk.GetArrayFromImage(sitk.ReadImage(str(src / meta["files"]["refs"]["expert"]))) > 0
    lungs = sitk.GetArrayFromImage(sitk.ReadImage(str(src / "lungs.nii.gz"))) > 0
    la, comp = long_axis_mm(ref, meta["spacing"])
    wall = wall_contact(comp, lungs)
    tags = [f"expert {la:.0f} mm"] + (["touches chest wall / mediastinum"] if wall > 0.15 else [])
    if la >= 30 and wall > 0.15:
        tc, diff = "against chest wall / large", "hard"
    elif la >= 20:
        tc, diff = "large tumour", "hard"
    else:
        tc, diff = "follow-up match (small)", "hard" if la < 15 else "medium"
    for d in scans.values():  # same label on test and retest
        m = json.loads((d / "meta.json").read_text())
        m.update(teaching_case=tc, difficulty=diff, tags=tags, expert_long_mm=round(la, 1), wall_contact=round(wall, 2))
        (d / "meta.json").write_text(json.dumps(m, indent=1))
    print(pid, tc, tags, flush=True)

for d in sorted(OUT.glob("LIDC-*")):
    meta = json.loads((d / "meta.json").read_text())
    ns = meta.get("nodules", [])
    tags = []
    if ns:
        tags.append(f"{len(ns)} nodule{'s' if len(ns) != 1 else ''}: " + ", ".join(f"{n['diameter_mm']:.0f} mm" for n in ns))
        lo, hi = min(n["readers"] for n in ns), max(n["readers"] for n in ns)
        tags.append(f"{lo}–{hi} radiologists" if lo != hi else f"{lo} radiologists")
    meta["tags"] = tags
    (d / "meta.json").write_text(json.dumps(meta, indent=1))
    print(d.name, meta.get("teaching_case"), tags, flush=True)
