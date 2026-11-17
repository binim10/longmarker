"""Replace lungs.nii.gz with the lungmask R231 mask (dilated 2 voxels in-plane),
dropping the per-lung convex hull, which swallowed the hilum and let small
nodules leak into the mediastinum. Records the new expert coverage in meta.json."""
import sys, json, pathlib
import numpy as np, SimpleITK as sitk
from scipy import ndimage as ndi
from common import unet_lungs

OUT = pathlib.Path(__file__).parent.parent / "web" / "app" / "public" / "cases"
for cid in sys.argv[1:]:
    d = OUT / cid
    img = sitk.ReadImage(str(d / "ct.nii.gz"))
    unet, _ = unet_lungs(img)
    lungs = ndi.binary_dilation(unet > 0, structure=np.ones((1, 5, 5)))
    meta = json.loads((d / "meta.json").read_text())
    refs = [sitk.GetArrayFromImage(sitk.ReadImage(str(d / f))) > 0 for f in meta["files"]["refs"].values()]
    allref = np.any(refs, axis=0)
    cover = float((allref & lungs).sum() / max(1, allref.sum()))
    out = sitk.GetImageFromArray(lungs.astype(np.uint8)); out.CopyInformation(img)
    sitk.WriteImage(out, str(d / "lungs.nii.gz"), useCompression=True)
    meta["gtv_lung_coverage"] = round(cover, 4); meta["lung_constraint"] = "lungmask R231, dilated 2 px in-plane"
    (d / "meta.json").write_text(json.dumps(meta, indent=1))
    print(cid, "coverage", round(cover, 4), flush=True)
