# LongMarker: a lung nodule measurement assistant (pilot)

**Live:** https://longmarker.vercel.app · **Research use only, not for clinical decisions.**

A web tool built for the Thoracic Oncology Research Lab (Harbor Medical Center, simulated) as part of the Base44 FDE take-home. It cuts the manual time spent finding, outlining, measuring, matching and recording lung nodules on CT. Daniel stays in control of every number.

## What it does
- **Click to measure.** One click inside a nodule produces a 3D outline. The tool reports the long and short axis (edge to edge, on the axial slice with the largest area), mean diameter, volume, a suggested solid component and the lobe, in under a second.
- **Trust.** On the public data, the tool's outline is shown next to the expert outline, and their numbers sit side by side.
- **Correct.** You can fix the result with the edge-threshold slider, the brush, erase, or undo. Every saved value records its provenance: `tool`, `edited` or `manual`.
- **Uncertain flag.** Raised for leaks, vessel-shaped outlines, chest-wall contact and very small nodules.
- **Follow-up.** On a follow-up scan, *Find in this scan* maps each baseline nodule through the precomputed registration, snaps it to the most plausible blob within 15 mm, and marks the result as matched or uncertain.
- **Export.** CSV in Daniel's exact sheet columns, plus `provenance, algo_version, params`. The per-case timer fills the `minutes` column.
- **Session file.** Save and load the session, so work survives a cleared browser.

## Data (public, TCIA)
- **RIDER Lung CT** (CC BY 4.0) and **RIDER-LungCT-Seg** (CC BY 3.0): same-day test/retest CT of NSCLC patients with manual GTV outlines (`GTVp_*_man` only).
- **LIDC-IDRI** (CC BY 3.0): nodules chosen to match Daniel's hard cases (ground-glass, part-solid, spiculated, small solid, easy solid), each read by 3–4 radiologists. The viewer shows the majority consensus; each reader's outline is kept for the inter-reader spread.
- Lung and lobe masks come from [lungmask](https://github.com/JoHof/lungmask) (R231, LTRCLobes).

## Repository layout
```
decisions.md          all product/design decisions (DDD), numbered
architecture-review.md, design.md, junctions.md   why each fork was taken (3 options + test each)
pipeline/             Python: download from TCIA, masks, crop, registration → web-ready NIfTI
web/app/              React + Vite + NiiVue app; src/lib/measure.ts is the measurement engine
web/app/eval/eval.ts  runs the same engine offline against the expert outlines
eval/                 results.json, report.md, thresholds.yaml, timed-study.md
BRIEF.md              technical brief: how it is built and why
```

## Run it
```bash
# 1) build the case data (needs ~3 GB free disk and network access to TCIA)
cd pipeline
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python pydicom SimpleITK numpy scipy scikit-image requests nibabel pandas pylidc "setuptools<70" lungmask
.venv/bin/python prepare_rider.py RIDER-1129164940 RIDER-1801720707 RIDER-1225316081 RIDER-1867199702 RIDER-2541949645 RIDER-2655999012 RIDER-2669524182
.venv/bin/python prepare_lidc.py
.venv/bin/python -c "from common import build_manifest; build_manifest('../web/app/public/cases')"

# 2) run the app
cd ../web/app && npm install && npm run dev

# 3) evaluate (writes eval/results.json), then build the report
npx tsx eval/eval.ts > ../../eval/results.json && python3 ../../eval/report.py

# 4) deploy (static)
npx vite build && cd dist && npx vercel deploy --prod
```
Case data is not committed, because it is regenerable and large. `torch` (through lungmask) is needed only in the offline pipeline, never in the browser.
