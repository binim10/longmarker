# LongMarker system design

This is the original pilot design, with implementation notes where the shipped system differs. See the [56 decisions](decisions.md) for rationale and the [README](README.md) for current build instructions. Research use only.

## Requirements

| ID | Researcher task | Decisions |
|---|---|---|
| F1 | Open a prepared RIDER or LIDC case in an axial viewer with lung and mediastinum window presets. | 13, 56 |
| F2 | Click to obtain a 3D outline, long and short axes and volume. | 19–21 |
| F3 | Adjust the threshold, paint or erase, and recalculate. | 20, 32 |
| F4 | Review and confirm the suggested dense component. | 22 |
| F5 | Flag uncertain measurements. | 23, 27 |
| F6 | Jump from a baseline nodule to a proposed follow-up match and confirm it. | 24–27 |
| F7 | Toggle the expert and tool outlines independently. | 31 |
| F8 | Inspect an optional ranked candidate list. | 28, 30 |
| F9 | Export the lab’s columns, provenance, parameters and version. | 33–35, 53 |
| F10 | Record active minutes and save or restore a session. | 12, 36 |

The design assumed one developer, one week to a working Part 1 and three weeks to Naomi’s demo. Targets included static hosting, current Chrome/Edge with WebGL2, zero installation and lab hosting cost, public data, case load under five seconds and click/threshold response under one second. The original storage estimate was about 20 cases at 10–20 MB each. Actual file sizes and timings appear in [the brief](BRIEF.md).

## Components and data flow

1. **Offline preparation.** Python 3.11, pydicom and SimpleITK convert DICOM series into compressed int16 NIfTI and extract geometry and metadata. The design proposed cropping to the lung box plus a 10 mm margin and resampling to 1.25 mm. The implementation preserves native slice numbering. Lungmask supplies lung and lobe constraints; thresholding and connected components were considered as a fallback. RIDER expert RTSTRUCT and LIDC reader annotations supply the reference masks.
2. **Registration and detection.** SimpleITK computes the baseline-to-follow-up transform. The design proposed affine alignment with Mattes mutual information and a separate matrix file. The implementation uses masked rigid-to-affine registration and stores the transform in case metadata. MONAI was considered; the optional precomputed candidate list uses a classical Hessian filter.
3. **Static delivery.** A manifest indexes files under `web/app/public/cases/`. The original hosting alternatives were Vercel and Cloudflare Pages, with public object storage and CORS as a fallback. Vercel hosts the pilot. The preparation goals were deterministic runs, versioned products and de-identified public inputs.
4. **Browser interaction.** React lists cases, and NiiVue draws axial CT plus overlays. The proposal included a small MPR view, a Web Worker for measurement and IndexedDB. The shipped measurement engine runs on the main thread and sessions use localStorage plus JSON export. Edits recompute measurements. The per-case timer excludes hidden, loading and idle periods and load errors.
5. **Evaluation.** The original plan sketched a Python evaluation pipeline and results CSV. The shipped Node evaluator imports the browser’s TypeScript engine, writes JSON and feeds a Python report generator.

## Proposed data contracts

The following sketches record the design-stage field names. Consult the shipped manifest, individual case metadata and `web/app/src/lib/session.ts` for the actual schemas.

```json
{
  "pipeline_version": "0.1.0",
  "cases": [{
    "case_id": "RIDER-1129164940_test",
    "source": "RIDER", "patient_id": "RIDER-1129164940",
    "timepoint": "test", "pair_id": "RIDER-1129164940_retest",
    "series_uid": "…", "slice_thickness_mm": 1.25, "scan_date": "…",
    "teaching_case": "large_tumour", "difficulty": "hard",
    "files": { "ct": "ct.nii.gz", "lungs": "lungs.nii.gz",
               "refs": ["ref_r1.nii.gz"], "reg_to_pair": "reg.json",
               "candidates": "candidates.json" },
    "attribution": "RIDER Lung CT, TCIA, CC BY 4.0"
  }]
}
```

```ts
type Measurement = {
  caseId: string; noduleId: string; lobe?: string;
  seed: [number, number, number];          // voxel
  axialSlice: number;                      // image number
  longMm: number; shortMm: number; meanMm: number;
  solidMm?: number; volumeMm3: number;
  type: 'solid'|'part-solid'|'ggo';
  matchStatus?: 'matched'|'uncertain'|'new';
  provenance: 'tool'|'edited'|'manual';
  params: { lo: number; hi: number; solidHu?: number };
  algoVersion: string; uncertain: boolean; notes?: string;
  editEvents: number; minutes: number; initials?: string;
};
```

CSV field order: `patient_id, scan_date, timepoint, series, slice_thickness, nodule_id, lobe, image_number, type, long_axis_mm, short_axis_mm, mean_diameter_mm, solid_component_mm, volume_mm3, match_status, minutes, initials, notes, provenance, algo_version, params`.

## Algorithms

- **Outline.** The initial sketch estimated the lower threshold from a 5×5×5 neighbourhood using max(−800, μ − 2σ), with an upper limit of 400 HU. Six-connected flood filling inside the lung mask, a one-voxel morphological opening and seed-component retention were intended to isolate the lesion. The sketch proposed an 80 mm work cube and a 60 mm leak criterion. Shipped thresholds, retry rules and the 120 mm work cube are documented in [the decision log](junctions.md).
- **Axes and volume.** Multiply the voxel count by the physical voxel volume. On the largest axial cross-section, measure the maximum contour separation on the convex hull and the largest perpendicular width. Draw the calipers and report their arithmetic mean.
- **Solid core.** Apply a user-adjustable HU threshold within the lesion and measure the longest diameter of the dense region. Daniel reviews it in the lung window. A manual correction changes row provenance to edited.
- **Follow-up.** Transform the baseline seed into follow-up coordinates and search within 15 mm. The design proposed local normalized cross-correlation followed by snapping and region growing. The implementation ranks nearby candidates by distance and volume and flags ambiguous matches.

## Evaluation plan

Compare both axes, Dice overlap and volume against RIDER manual annotations and LIDC readers, grouped by teaching-case type. Target approximately 1 mm repeatability on RIDER. Count false candidates and charge for their review. Compare baseline and follow-up time separately, targeting roughly half the manual follow-up time. Thresholds were recorded before scoring in [the thresholds file](eval/thresholds.yaml). The proposed 2–3 longitudinal LIDC cases lacked independent matching labels.

## Delivery plan and constraints

Week one milestones were reference-series verification and a platform trial on day one, a public case with an expert overlay on day two, click measurement on day three, and brush, session, timer and CSV on day four. Day five targeted expansion to roughly ten RIDER cases and a deployed link. Week two covered matching, LIDC cases, evaluation and a proposed one-day MedSAM trial. Week three covered detection, human timing, reporting and demo preparation. The [implementation decisions](decisions.md) distinguish delivered work from proposed trials.

A second outline suggestion was considered for faint ground-glass nodules. Public object storage is an option if static hosting limits are reached. Real hospital scans would need local DICOM decoding and browser-side processing such as ONNX Web or an approved local service. Shared multi-user sessions would require a backend.
