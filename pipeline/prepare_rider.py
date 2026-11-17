"""Prepare RIDER Lung CT test/retest cases for LongMarker.

For each patient: download the CT series referenced by the manual GTV RTSTRUCT
(TEST and RETEST), rasterize GTVp_*_man, build a lung constraint mask, crop,
register baseline(TEST)->follow-up(RETEST), and write web-ready files.

Usage: .venv/bin/python prepare_rider.py RIDER-1129164940 [more ids...]
"""
import glob, json, sys, pathlib
import numpy as np
import pydicom
import SimpleITK as sitk
from scipy import ndimage as ndi
from skimage.draw import polygon as draw_polygon
from skimage.morphology import convex_hull_image
from tcia import get_series, download_series
from common import write_case, unet_lungs, PIPELINE_VERSION

RAW = pathlib.Path(__file__).parent.parent / "data" / "raw"
OUT = pathlib.Path(__file__).parent.parent / "web" / "app" / "public" / "cases"


def read_ct(series_dir):
    r = sitk.ImageSeriesReader()
    files = r.GetGDCMSeriesFileNames(str(series_dir))
    r.SetFileNames(files)
    img = r.Execute()
    ds = pydicom.dcmread(files[0], stop_before_pixels=True)
    meta = dict(
        patient_id=str(ds.PatientID),
        scan_date=str(ds.get("StudyDate", "")),
        series_uid=str(ds.SeriesInstanceUID),
        series_number=int(ds.get("SeriesNumber") or 0),
        slice_thickness_mm=float(ds.get("SliceThickness", 0)),
        kernel=str(ds.get("ConvolutionKernel", "")),
    )
    return img, meta


def rasterize_rtstruct(rt_path, img, roi_suffix="_man"):
    ds = pydicom.dcmread(rt_path)
    names = {r.ROINumber: r.ROIName for r in ds.StructureSetROISequence}
    size = img.GetSize()  # x, y, z
    mask = np.zeros(size[::-1], np.uint8)  # z, y, x
    used = []
    for rc in ds.ROIContourSequence:
        name = names.get(rc.ReferencedROINumber, "")
        if not name.endswith(roi_suffix):
            continue
        used.append(name)
        for c in getattr(rc, "ContourSequence", []):
            if c.ContourGeometricType == "POINT":
                continue
            pts = np.array(c.ContourData, float).reshape(-1, 3)
            idx = np.array([img.TransformPhysicalPointToContinuousIndex(p.tolist()) for p in pts])
            k = int(round(idx[:, 2].mean()))
            if not 0 <= k < size[2]:
                continue
            rr, cc = draw_polygon(idx[:, 1], idx[:, 0], shape=(size[1], size[0]))
            sl = np.zeros((size[1], size[0]), np.uint8)
            sl[rr, cc] = 1
            mask[k] ^= sl  # XOR handles holes
    return mask, used


def lung_constraint(ct):
    """Aerated lung, then per-lung per-slice convex hull, so juxtapleural and
    central tumours stay inside while the chest wall stays outside."""
    air = ct < -400
    lab, n = ndi.label(air)
    border = np.unique(np.concatenate([lab[:, 0].ravel(), lab[:, -1].ravel(), lab[:, :, 0].ravel(),
                                       lab[:, :, -1].ravel()]))
    sizes = ndi.sum(np.ones_like(lab), lab, index=range(n + 1))
    sizes[border] = 0
    sizes[0] = 0
    keep = np.argsort(sizes)[::-1][:2]
    keep = [k for k in keep if sizes[k] > 0.05 * sizes.max()]
    lungs = np.isin(lab, keep)
    out = np.zeros_like(lungs)
    for z in range(lungs.shape[0]):
        sl = lungs[z]
        if not sl.any():
            continue
        lab2, n2 = ndi.label(sl)
        for i in range(1, n2 + 1):
            comp = lab2 == i
            if comp.sum() < 50:
                continue
            out[z] |= convex_hull_image(comp)
    return out


def crop_box(lungs, spacing, margin_mm=10):
    zz, yy, xx = np.where(lungs)
    m = [int(np.ceil(margin_mm / s)) for s in spacing[::-1]]
    lo = [max(0, a.min() - mm) for a, mm in zip((zz, yy, xx), m)]
    hi = [min(d, a.max() + mm + 1) for a, mm, d in zip((zz, yy, xx), m, lungs.shape)]
    return lo, hi


def register(fixed, moving, fixed_mask, moving_mask):
    """Rigid then affine, identity init (same scanner, same day), metric limited
    to the dilated lung mask. Returns transform mapping fixed points -> moving."""
    f = sitk.Cast(sitk.Clamp(fixed, lowerBound=-1000, upperBound=400), sitk.sitkFloat32)
    m = sitk.Cast(sitk.Clamp(moving, lowerBound=-1000, upperBound=400), sitk.sitkFloat32)
    fm = sitk.BinaryDilate(fixed_mask, [5, 5, 3])
    init = sitk.CenteredTransformInitializer(sitk.Cast(fixed_mask, sitk.sitkFloat32),
                                             sitk.Cast(moving_mask, sitk.sitkFloat32),
                                             sitk.Euler3DTransform(),
                                             sitk.CenteredTransformInitializerFilter.MOMENTS)
    def run(tx, iters):
        R = sitk.ImageRegistrationMethod()
        R.SetMetricAsMattesMutualInformation(48)
        R.SetMetricFixedMask(fm)
        R.SetMetricSamplingStrategy(R.RANDOM)
        R.SetMetricSamplingPercentage(0.1, seed=42)
        R.SetInterpolator(sitk.sitkLinear)
        R.SetOptimizerAsRegularStepGradientDescent(1.0, 1e-4, iters)
        R.SetOptimizerScalesFromPhysicalShift()
        R.SetShrinkFactorsPerLevel([4, 2, 1])
        R.SetSmoothingSigmasPerLevel([2, 1, 0])
        R.SetInitialTransform(tx, inPlace=False)
        return R.Execute(f, m)
    rigid = run(init, 150)
    aff = sitk.AffineTransform(3)
    rig = sitk.Euler3DTransform(rigid.GetNthTransform(0) if hasattr(rigid, "GetNthTransform") else rigid)
    aff.SetMatrix(rig.GetMatrix()); aff.SetTranslation(rig.GetTranslation()); aff.SetCenter(rig.GetCenter())
    return run(aff, 150)


def affine_to_matrix(t):
    """4x4 matrix of a SimpleITK affine/composite transform via point sampling."""
    P = np.array([[0, 0, 0], [100, 0, 0], [0, 100, 0], [0, 0, 100]], float)
    Q = np.array([t.TransformPoint(p.tolist()) for p in P])
    A = np.linalg.solve(np.c_[P, np.ones(4)], Q).T  # 3x4
    return np.vstack([A, [0, 0, 0, 1]])


def process_patient(pid, all_series):
    ct_by_uid = {s["SeriesInstanceUID"]: s for s in all_series if s["Modality"] == "CT"}
    rts = [s for s in all_series if s["Modality"] == "RTSTRUCT" and s["PatientID"] == pid]
    cases = {}
    for rt in rts:
        tp = rt["SeriesDescription"].lower()  # test / retest
        rdir = download_series(rt["SeriesInstanceUID"], RAW)
        rpath = glob.glob(f"{rdir}/*.dcm")[0]
        ds = pydicom.dcmread(rpath)
        ref = ds.ReferencedFrameOfReferenceSequence[0].RTReferencedStudySequence[0] \
            .RTReferencedSeriesSequence[0].SeriesInstanceUID
        cdir = download_series(ref, RAW)
        img, meta = read_ct(cdir)
        gtv, used = rasterize_rtstruct(rpath, img)
        ct = sitk.GetArrayFromImage(img).astype(np.int16)
        unet, lobes = unet_lungs(img)
        # J4: U-Net R231 only (the per-lung hull swallowed the hilum -> mediastinal leaks)
        lungs = ndi.binary_dilation(unet > 0, structure=np.ones((1, 5, 5)))
        cover = float((gtv & lungs).sum() / max(1, gtv.sum()))
        # union so the constraint never clips the expert tumour region's neighbourhood
        lo, hi = crop_box(lungs | gtv.astype(bool), img.GetSpacing())
        sl = tuple(slice(a, b) for a, b in zip(lo, hi))
        # crop image keeping geometry
        crop = sitk.RegionOfInterest(img, [int(hi[2] - lo[2]), int(hi[1] - lo[1]), int(hi[0] - lo[0])], [int(lo[2]), int(lo[1]), int(lo[0])])
        case_id = f"{pid}_{tp}"
        meta.update(timepoint=tp, rois=used, gtv_lung_coverage=round(cover, 4),
                    gtv_voxels=int(gtv.sum()))
        cases[tp] = dict(case_id=case_id, img=crop, ct=ct[sl], lungs=lungs[sl].astype(np.uint8),
                         lobes=lobes[sl], refs={"expert": gtv[sl]}, meta=meta, full=img,
                         full_mask=sitk.GetImageFromArray((unet > 0).astype(np.uint8)))
        cases[tp]["full_mask"].CopyInformation(img)
        print(f"{case_id}: shape={ct[sl].shape} cover={cover:.3f} gtv={gtv.sum()} rois={used}")
    if "test" in cases and "retest" in cases:
        b, f = cases["test"], cases["retest"]
        t = register(f["full"], b["full"], f["full_mask"], b["full_mask"])  # maps follow-up(retest) point -> baseline(test) point
        M_fu_to_base = affine_to_matrix(t)
        M_base_to_fu = np.linalg.inv(M_fu_to_base)
        b["meta"]["pair"] = dict(case_id=f["case_id"], role="baseline", M_to_pair=M_base_to_fu.tolist())
        f["meta"]["pair"] = dict(case_id=b["case_id"], role="follow-up", M_to_pair=M_fu_to_base.tolist())
        # sanity: map baseline GTV centroid into follow-up and compare
        def centroid_phys(c):
            z, y, x = np.argwhere(c["refs"]["expert"]).mean(0)
            return np.array(c["img"].TransformContinuousIndexToPhysicalPoint([float(x), float(y), float(z)]))
        cb, cf = centroid_phys(b), centroid_phys(f)
        mapped = (M_base_to_fu @ np.r_[cb, 1])[:3]
        err = float(np.linalg.norm(mapped - cf))
        raw = float(np.linalg.norm(cb - cf))
        print(f"  registration: centroid error {err:.1f} mm (unregistered {raw:.1f} mm)")
        b["meta"]["pair"]["centroid_err_mm"] = f["meta"]["pair"]["centroid_err_mm"] = round(err, 2)
    for c in cases.values():
        write_case(OUT / c["case_id"], c["img"], c["ct"], c["lungs"], c["refs"], c["meta"], source="RIDER",
                   lobes=c["lobes"])
    return [c["case_id"] for c in cases.values()]


if __name__ == "__main__":
    series = get_series("RIDER Lung CT")
    for pid in sys.argv[1:]:
        try:
            process_patient(pid, series)
        except Exception as e:
            print(f"FAILED {pid}: {e}", flush=True)
