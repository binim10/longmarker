# LongMarker: anatomy of the system

A full dissection of what was built: every organ, what it does, how they connect, the numbers inside each one, and where each is weak. ~2,100 lines of code in total. Research use only.

```
┌──────────────────────────── OFFLINE: Python 3.11 (pipeline/) ────────────────────────────┐
│                                                                                            │
│  TCIA NBIA REST ──► tcia.py ──► data/raw/<SeriesUID>/*.dcm   (streamed, retries)          │
│        │                                                                                   │
│        ├─► prepare_rider.py   RTSTRUCT GTVp_*_man ─► expert mask                          │
│        │                       CT ─► lungmask R231 (+2px) ─► lung constraint              │
│        │                       CT ─► lungmask LTRCLobes   ─► lobe labels                  │
│        │                       test↔retest ─► rigid→affine registration ─► 4×4 matrix     │
│        ├─► prepare_lidc.py    pylidc DB ─► 3–4 reader outlines ─► r1..r4 + consensus      │
│        ├─► tag_cases.py       expert long axis + wall contact ─► teaching-case label      │
│        ├─► detect.py          Hessian dot filter ─► candidates.json (experimental)        │
│        └─► common.py          write NIfTI + meta.json ; build manifest.json               │
│                                                                                            │
│  OUTPUT  web/app/public/cases/<case_id>/ {ct, lungs, lobes, ref_*}.nii.gz, meta.json,     │
│          candidates.json  +  web/app/public/manifest.json         (19 cases, 814 MB)      │
└────────────────────────────────────────────┬───────────────────────────────────────────────┘
                                             │ vite build → rsync to non-git dir → vercel --prod
┌────────────────────────────────────────────▼───────────────────────────────────────────────┐
│  HOSTING: Vercel static production (no server, no login)  https://longmarker.vercel.app    │
└────────────────────────────────────────────┬───────────────────────────────────────────────┘
                                             │ fetch (gzip NIfTI, 46–59 MB per CT)
┌──────────────────────────── BROWSER: React 19 + NiiVue 0.69 (web/app/src/) ───────────────┐
│  App.tsx ── case list · toolbar · status · right panel · timer · session                   │
│     │                                                                                      │
│     ├─ lib/viewer.ts   NiiVue wrapper: axial view, windows, overlays, drawing bitmap       │
│     │                  (file-order ⇄ RAS LUT), brush/erase, caliper lines, RLE            │
│     ├─ lib/measure.ts  ENGINE: grow · growAuto · metrics · componentNear · lobeAt ·        │
│     │                  findInFollowUp · voxToLps/lpsToVox/applyM                           │
│     ├─ lib/session.ts  localStorage + session.json · CSV (Daniel's columns + 3)            │
│     └─ lib/nifti.ts    NIfTI-1 parser (shared with Node eval)                              │
└────────────────────────────────────────────┬───────────────────────────────────────────────┘
                                             │ same engine, run in Node (tsx)
┌──────────────────────────── EVALUATION (web/app/eval/, eval/) ────────────────────────────┐
│  eval.ts ─► eval/results.json ─► report.py ─► eval/report.md                               │
│  calibrate.ts (threshold, test scans only) · detect.py ─► eval/detection.json              │
│  thresholds.yaml (fixed before running) · timed-study.md (human protocol)                  │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Skeleton: repository layout

| Path | Lines | Role |
|---|---|---|
| `pipeline/tcia.py` | 33 | TCIA client. `get_series()` lists series. `download_series()` streams the zip with a 60 s per-chunk timeout and 8 retries. This replaced a version that hung for 15 minutes with no socket open. |
| `pipeline/prepare_rider.py` | 200 | RIDER pairs: CT, the expert GTV, U-Net lung mask and lobes, crop to the lungs, registration from test to retest. |
| `pipeline/prepare_lidc.py` | 105 | LIDC: chooses scans by teaching type, builds a mask per reader plus a majority consensus. |
| `pipeline/common.py` | 67 | `unet_lungs()` (lungmask R231 and LTRCLobes), `write_case()`, `build_manifest()`. |
| `pipeline/tag_cases.py` | 73 | One teaching-case label per patient, from the expert outline. |
| `pipeline/detect.py` | 111 | Experimental candidate detector and its scoring. |
| `pipeline/lidc_select.py`, `recompute_lungs.py` | 55 | Selection query; one-off migration from hull to U-Net. |
| `web/app/src/lib/measure.ts` | 443 | **The measurement engine.** Pure TypeScript, no DOM. |
| `web/app/src/lib/viewer.ts` | 169 | NiiVue adapter. |
| `web/app/src/lib/session.ts` | 80 | Persistence and CSV. |
| `web/app/src/lib/nifti.ts` | 27 | NIfTI reader. |
| `web/app/src/App.tsx` / `App.css` | 486 | UI. |
| `web/app/eval/eval.ts`, `calibrate.ts` | 146 | Offline evaluation of the same engine. |
| `eval/report.py` | 147 | Report and time model. |
| Docs | — | `decisions.md` (56 decisions), `junctions.md` (J0–J15), `architecture-review.md`, `design.md`, `BRIEF.md`, `README.md`, this file. |

---

## 2. Data organ

### Sources (public, TCIA)
| Set | Licence | What we took | Why |
|---|---|---|---|
| RIDER Lung CT | CC BY 4.0 | 7 patients × test/retest, CT series referenced by the RTSTRUCT (1.25 mm, LUNG kernel) | Naomi named it for the pilot. Same-day repeat scans are the right data for testing repeatability. |
| RIDER-LungCT-Seg | CC BY 3.0 | `GTVp_test_man` / `GTVp_retest_man` only | Manual outlines by one radiation oncologist. `_auto` and the QIN SEGs are algorithm output (J1). |
| LIDC-IDRI | CC BY 3.0 | 5 scans, 7 nodules, each read by 3–4 radiologists | Covers the hard teaching cases RIDER lacks: ground-glass, part-solid, spiculated, small solid. |

**RIDER selection.** By tumour size, weighted to small: 13, 15, 17, 19, 31, 39 and 68 mm (expert long axis).

**LIDC selection** (`SELECT` in prepare_lidc.py), by the median of the reader ratings:

| Patient | Teaching case | Rule | Nodules |
|---|---|---|---|
| 0088 | faint ground-glass | texture ≤ 2 | 7.5 and 6.0 mm |
| 0828 | part-solid | texture = 3 | 8.3 mm (replaced 0590, whose slices overlap; J13) |
| 0915 | spiculated | spiculation ≥ 4 | 10.1 mm |
| 0017 | small solid (subtle) | texture 5, ≤ 9 mm | 7.7 mm |
| 0164 | solid (easy) | texture 5, ≥ 12 mm | 15.5 and 13.2 mm |

### Per-case package (`public/cases/<id>/`)
| File | Type | Content |
|---|---|---|
| `ct.nii.gz` | int16 HU | CT cropped to the lung bounding box + 10 mm, native resolution (≈0.6–0.7 × 0.6–0.7 × 1.25 mm) |
| `lungs.nii.gz` | uint8 | Lung constraint: lungmask R231, which by design includes tumours, dilated 2 px in-plane |
| `lobes.nii.gz` | uint8 | 1 LUL, 2 LLL, 3 RUL, 4 RML, 5 RLL (LTRCLobes) |
| `ref_expert.nii.gz` | uint8 | RIDER: manual GTV. LIDC: majority consensus. |
| `ref_r1..r4.nii.gz` | uint8 | LIDC only: each reader's outline (reader order is arbitrary per nodule) |
| `candidates.json` | JSON | Top 10 detector candidates (experimental) |
| `meta.json` | JSON | Patient ID, date, series, thickness, kernel; SimpleITK geometry (origin, spacing, direction); pair link with the 4×4 baseline→follow-up matrix and centroid error; teaching label, tags, LIDC nodule ratings; expert coverage by the lung mask |

`manifest.json` lists the cases: RIDER first, then by patient, baseline before follow-up.

---

## 3. Offline organs (pipeline)

### 3.1 Expert mask rasterisation
- **RIDER:** each RTSTRUCT contour is mapped from physical space to voxel indices through SimpleITK. The slice is the rounded mean z, the polygon is filled with `skimage.draw.polygon`, and holes are handled by XOR. POINT contours are skipped.
- **LIDC:** `contour.to_matrix()` gives row and column; z is matched through the contour's physical position. Boundary pixels are included. The consensus is a voxel marked by at least ⌈n/2⌉ readers, and never fewer than 2.
- **Validation:** the GTV voxel count matched in the browser (147,321 = 147,321), and the overlay matched NiiVue's own `loadDrawing` voxel for voxel.

### 3.2 Lung constraint (J4)
| Variant | Expert coverage | Problem |
|---|---|---|
| Air threshold with a per-lung convex hull per slice | 70–73% | Clipped large and juxtapleural tumours |
| U-Net ∪ hull | 99.5% | The hull swallowed the hilum: a 12 mm nodule leaked to 164 cm³ |
| **U-Net R231, +2 px (chosen)** | **99.4–100%** | — |

### 3.3 Registration (J7)
SimpleITK, in three steps:
1. **Initialise** with MOMENTS on the lung masks.
2. **Rigid:** Euler3D, Mattes mutual information (48 bins), 10% random sampling, metric restricted to the dilated lung mask, three resolution levels [4, 2, 1], 150 iterations.
3. **Affine**, same settings.

The 4×4 matrix is recovered by sampling 4 points and stored explicitly in the baseline→follow-up direction. **Sanity metric:** the mapped baseline GTV centroid against the follow-up centroid gives **1.0–4.5 mm** across the 7 pairs (19.8–49.7 mm unregistered). The first version, which used a GEOMETRY initialiser, gave 27.6 mm.

### 3.4 Detector (J14, experimental)
- **Method:** volume downsampled 2× in-plane; Hessian at σ = 1.5, 2.5, 4 and 6 mm, scale-normalised; dot response |λ3|²/|λ1| when all eigenvalues are negative; maximum over scales; masked to the lungs with HU > −750; non-maximum suppression over 6 mm; top 10 kept.
- **Parameters** were fixed before scoring.
- **Result:** sensitivity 7/21 at 5 candidates and 11/21 at 10; about 9.4 false candidates per scan; 0/2 ground-glass. It ships **off by default**.

---

## 4. The engine: `measure.ts`

### 4.1 `grow()`: seeded 3D region growing
1. **Seed snap:** move the click to the nearest in-range voxel within 3 mm.
2. **Automatic threshold (`suggestLo`):** take a 5×5×3 box around the seed. If its mean is above −300 HU, use **−450 HU** (solid). Otherwise use **max(−750, mean − 1.5 sd)** (ground-glass). The upper threshold is +400.
3. **Flood fill** with 6-connectivity, inside the lung constraint, inside a ±60 mm box.
4. **Opening** to detach vessels: erode then dilate by k pixels (default k = 2, in-plane; 3D on retries, with z on alternate iterations because the slices are about 2× the pixel size). Keep the component that contains the seed, then reconstruct it geodesically by k pixels inside the raw region so edges and spicules survive.
5. **Flags:**
   - `leaked`: the mask touches the box edge, or the opening erased the nodule.
   - `touchesWall`: more than 15% of the boundary faces lie outside the lungs.

### 4.2 `growAuto()`: automatic retries (J9)
- **The test:** a result is accepted if it does not leak, has more than 10 voxels and long/short < 2.5.
- **Retry order** until a result passes:

| Order | Ground-glass only | All nodules |
|---|---|---|
| 1 | lo − 50 with a 3D k=3 opening | — |
| 2 | lo − 100 with a 3D k=3 opening | — |
| 3 | lo − 100 with a 3D k=4 opening | — |
| 4 | — | 3D k=3 |
| 5 | — | 3D k=4 |
| 6 | — | lo + 100 |
| 7 | — | lo + 150 |
| 8 | — | lo + 150 with 3D k=3 |

- **If nothing passes:** return the first result with `vesselLike` set.

### 4.3 `metrics()`: what goes into Daniel's sheet
- **Measurement slice:** the axial slice with the largest mask area. This becomes `image_number`.
- **Long axis:** the maximum distance between hull points. The hull is built from the pixel *corners* of the boundary pixels, so the measurement runs edge to edge like calipers.
- **Short axis:** the longest chord perpendicular to the long axis, marched in half-pixel steps, capped at the long axis.
- **Mean diameter** = (long + short) / 2. **Volume** = voxel count × voxel volume.
- **Solid part:** voxels at or above `solidHu` (default −300, adjustable); the long axis of that part on its own largest slice. It is a suggestion that Daniel confirms by eye (decision 22).
- **Type suggestion:** solid fraction ≥ 0.8 → solid; ≤ 0.05 → ground-glass; otherwise part-solid.
- **Lobe:** majority vote of lobe labels in a 3-voxel shell around the nodule. A shell is used because the lobe mask excludes the tumour itself.

### 4.4 `findInFollowUp()`: matching (decisions 24–27)
1. **Map** the baseline seed to the follow-up scan: voxel → LPS (baseline geometry) → 4×4 matrix → LPS → voxel (follow-up geometry).
2. **Search** within 15 mm, sampling every 2nd voxel in-plane, for voxels at or above `lo`. Grow up to 4 distinct blobs.
3. **Score** each blob: distance / 15 + |ln(volume ratio)| + 1 if it leaked. The lowest score wins.
4. **Uncertain** if the volume ratio is outside 0.5–2, the distance is over 10 mm, the blob leaked, or the runner-up scores within 0.3.

### 4.5 Geometry helpers
`voxToLps` and `lpsToVox` use the SimpleITK convention: the direction matrix is orthonormal, so its inverse is its transpose. `applyM` applies the 4×4 matrix.

### 4.6 Version stamp
`ALGO_VERSION = 'lm-measure-0.2.0'`. It is written into every CSV row together with the parameters (decision 53).

---

## 5. The browser: viewer, UI, session

### 5.1 `viewer.ts`
- **Loading:** NiiVue loads the CT (gray), the expert outline (warm, 35% opacity), the lungs and the lobes (both hidden, used only as data).
- **Coordinate test (J6):** the voxel NiiVue reports for a click equals the voxel in file order.
- **Drawing layer:** NiiVue's drawing bitmap is stored in **RAS order**. A lookup table built from `permRAS` (copied from NiiVue's own `calculateLoadDrawingTransform`) maps between file order and RAS. Labels: 2 = tool outline (green), 3 = caliper lines (blue).
- **Brush and erase:** NiiVue's pen, with values 2 and 0. A pointerup event triggers `readMask()`, then the numbers are recomputed and provenance becomes `edited` (or `manual` if there was no seed).
- **Windows:** lung (−1350/150) and mediastinum (−160/240).
- **Saved outlines:** stored as RLE inside the session.

### 5.2 `App.tsx`
- **Layout:** case list (left) · viewer (centre) · panel (right) · header and footer.
- **Panel:** follow-up "Find" list · experimental candidates · tool-vs-expert table · Uncertain reasons · type, lobe and match selectors · threshold and solid-part sliders · notes · Save.
- **Uncertain reasons:** leak, wall contact, vessel-like shape, < 4 mm, > 30 mm, a doubtful match.
- **Timer (decision 36):** counts 1 s ticks only while a case is open and loaded, the tab is visible, and there was activity in the last 60 s. Load time is excluded.
- **Prefetch:** fetches the next case's CT in the background.
- **Stale-closure guard:** `activeRef`, `metaRef`, `sessionRef`, `solidRef` and a `handlers` ref. This fixed a real bug where Find read the previous case's arrays.
- **WebGL2 check:** shows a clear message on unsupported browsers (decision 55).

### 5.3 `session.ts`
- **Storage:** `localStorage` key `longmarker.session.v1`, plus Save and Load of `session.json` (decision 12).
- **CSV:** a header line "Research use only…", then Daniel's 18 columns in his order, plus `provenance, algo_version, params`.
  - `minutes` comes from the timer.
  - `notes` is prefixed with "Uncertain" when the measurement is flagged.

---

## 6. Evaluation organ

| Piece | What it does |
|---|---|
| `eval.ts` | Runs the browser engine in Node. The seed is an expert-outlined voxel near the nodule centre, simulating Daniel's click. Outputs tool and expert metrics, LIDC reader metrics, Dice, flags, timing, and the full follow-up flow. |
| `calibrate.ts` | Sweeps the starting threshold through `growAuto` on **test scans only**. −450 and −300 tie at 19.5% median error, so the default stays −450. |
| `thresholds.yaml` | Pass bars, fixed before the run. |
| `report.py` | Builds report.md: per-nodule table, LIDC reader range, RIDER repeatability, matching, detection, silent errors, time model with sensitivity. |
| `timed-study.md` | The protocol only a person can run. |

**Headline numbers.** All are optimistic: the retry heuristics were developed on these same 21 nodules, and there is no unseen test set.

| Measure | Result |
|---|---|
| Follow-up match lands on the right nodule | 7/7 |
| LIDC long axis inside the readers' range ±0.5 mm | 5/7 |
| RIDER repeatability, median |Δ long| | tool 1.3 mm, expert 1.4 mm |
| Long axis within max(1.5 mm, 10%) of the expert | 8/21 |
| Flagged Uncertain | 38% |
| Silent errors (off and not flagged) | 5/21, each 1.9–3.4 mm |
| Time per click (median / max) | 0.4 s / 1.7 s |
| Cold load | 3.3–4.9 s in the browser; 4.5–5.0 s raw download for 46–59 MB files at ~10 MB/s |
| Time model, follow-up scan | 33.5 → 14.2 min (−57%); −40% without the Find-search assumption |
| Time model, baseline scan | 23.5 → 18.1 min (−23%) |
| **Timed study** | **not run; it needs a person** |

---

## 7. Deployment and source

- **Build:** `vite build` produces `dist` (about 850 MB including the cases). `rsync` copies it to a directory outside git, and `vercel deploy --prod` publishes it.
  - The copy outside git is needed because Vercel blocks a deploy whose commit author is not a team member (J11).
- **Verified:** with `curl` returning 200 and no login, and through a full flow in the browser on production.
- **Source:** private GitHub repo `binim10/longmarker`.
  - Case data and `.venv` are git-ignored. The README rebuilds them.
  - `torch` (through lungmask) is used offline only.

---

## 8. Known weaknesses, by organ

| Organ | Weakness | Mitigation in place |
|---|---|---|
| Lung constraint | The R231 mask can still include hilar soft tissue next to large central tumours | Flag for tumours over 30 mm, brush correction |
| `grow` | Region growing cannot separate a tumour from the mediastinum or vessels of the same density; large tumours come out 1.4–2.3× too big | Uncertain reasons, threshold slider, brush |
| Ground-glass | The haze is continuous with the lung, so the result is threshold-sensitive (8.0 vs 8.5 mm good; 10.6 vs 6.8 mm flagged) | Ground-glass retry order, flag |
| LIDC bias | The tool runs about 2 mm tighter than readers, who draw on the outer edge | Reported openly; not retuned, because that would fit the evaluation set |
| Matching | Tested only on same-day pairs; a months-apart test was not possible without circular ground truth (J15) | Documented |
| Detector | 11/21 at 10 candidates, misses ground-glass | Off by default |
| Load | Bound by the network for 46–59 MB files | Next-case prefetch |
| Evaluation | Heuristics developed on the evaluation nodules; the timed study is pending | Caveats in the report and the brief |
| Real-scan path | Needs local DICOM parsing and a browser lung mask (ONNX-web) | The engine already runs in the browser; documented as phase 2 |
