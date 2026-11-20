# LongMarker: a lung nodule measurement assistant (pilot)

**Live:** https://longmarker.vercel.app · **Research use only, not for clinical decisions.**

A web tool built for the Thoracic Oncology Research Lab (Harbor Medical Center, simulated) as part of the Base44 FDE take-home. The pilot targets time spent outlining, matching and recording lung nodules. The time model estimates a 57% reduction for follow-ups if visual search falls from 15 to 9 minutes. Human timing is pending. Daniel stays in control of every number.

## What it does
- **Click to measure.** One click inside a nodule produces a 3D outline. The tool reports the long and short axis (edge to edge, on the axial slice with the largest area), mean diameter, volume, a suggested solid component and the lobe, with a median outline time of about 0.4 seconds in the offline evaluation.
- **Trust.** On the public data, the tool's outline is shown next to the expert outline, and their numbers sit side by side.
- **Correct.** You can fix the result with the edge-threshold slider, the brush, erase, or undo. Each saved row records its provenance: `tool`, `edited` or `manual`.
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
ANATOMY.md            full dissection of every component, parameter and weakness
```

## Run the shipped pilot

From the repository root, use Python 3.9+ and Node 22.22.3 with npm. The default demo uses the same 19 public scans as the hosted pilot. Allow about 2 GB for the scan files and their built copy, plus dependencies.

```bash
python3 scripts/restore-cases.py
cd web/app
npm ci
npm run dev
```

The restore command reads the file list in `scripts/cases.sha256`, downloads missing or changed assets from the public pilot, checks every SHA-256 digest and replaces each completed file atomically. A new checkout needs network access or a local copy of the matching data. Keep a copy of prepared cases when changing hosting or datasets.

## Tests and deployment

From `web/app`, run `npm test` for deterministic checks of volume, physical coordinates, CSV output and concurrent fetch retries. They use synthetic inputs and require no downloads. Run `npm run lint` and `npm run build` for static checks, TypeScript and production bundling. Lint currently reports warnings.

GitHub Actions runs these commands on pushes and pull requests. The Vercel Git integration builds the repository from its root using `vercel.json`. Its own build gate repeats the tests and lint, verifies the complete demo dataset, then type-checks and builds the app. Successful production-branch builds update [the pilot](https://longmarker.vercel.app/). For recovery, promote a previously verified deployment in Vercel. The separate [submission portal](https://longmarker-portal.vercel.app/) has its own deployment.

## Research evaluation

After restoring the cases, run the commands below from `web/app`. Review the JSON diff before replacing a stored baseline. The browser and evaluation share the measurement engine. Find overlapped the expert mask by at least one voxel in 7 of 7 same-day pairs. Four matches needed confirmation. Eight of 21 long axes met the expert tolerance. Five out-of-tolerance results went unflagged. See [the evaluation report](eval/report.md) for the denominators, exceptions and timing model.

```bash
npx tsx eval/eval.ts > /tmp/longmarker-results.json
# To regenerate the report from the committed results:
python3 ../../eval/report.py
```

## Regenerate the public data from TCIA

The offline Python pipeline uses the TCIA API, lungmask and registration. For a matching copy of the shipped benchmark use the checksum-verified restore command above. For experiments, run the preparation steps below from the repository root.

```bash
cd pipeline
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python pydicom SimpleITK numpy scipy scikit-image requests nibabel pandas pylidc "setuptools<70" lungmask
.venv/bin/python prepare_rider.py RIDER-1129164940 RIDER-1801720707 RIDER-1225316081 RIDER-1867199702 RIDER-2541949645 RIDER-2655999012 RIDER-2669524182
.venv/bin/python prepare_lidc.py
.venv/bin/python tag_cases.py
.venv/bin/python -c "from common import build_manifest; build_manifest('../web/app/public/cases')"
```
