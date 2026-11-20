# LongMarker pilot decisions

These decisions come from the Base44 assignment and conversations with Dr. Naomi Hart and Dr. Daniel Reyes at the simulated Thoracic Oncology Research Lab, Harbor Medical Center. The design discussion considered the perspectives of the director, researcher, radiologist, ML and frontend engineers, FDE, evaluator and data steward. Research use only.

## Goal and scope

1. Aim to halve Daniel’s time per scan while maintaining accuracy. Naomi defined success in terms of manual work saved and measurement quality.
2. Keep Daniel responsible for accepting or correcting every proposed measurement. An unchecked error can propagate through an entire growth analysis.
3. Demonstrate time savings and measurement quality. Malignancy prediction and clinical decisions fall outside the research assignment.
4. Build in order of expected benefit and feasibility: recording, measurement and volume, follow-up matching, then discovery. Most follow-ups involve one or two known nodules.

## Users and workflow

5. Design for Daniel’s daily use and for Naomi to open the demo independently. She asked for something “that I can open and use myself.”
6. Follow Daniel’s sequence: open, locate, measure, match to baseline and record. This also gives the timing comparison a common workflow.
7. Measure on the axial slice with the largest nodule cross-section so the results remain comparable with the existing sheet.

## Platform

8. Deliver a browser link. The lab has no software budget, installation privileges or IT support for this pilot.
9. Use public TCIA cases. Hospital scans stay within the hospital.
10. Precompute lung masks, registration and detection in Python. Run viewing, outlining and measurement in the browser. The pilot corpus is known in advance, so it can be served statically. Report offline computation separately. Supporting arbitrary scan uploads would require additional work.
11. Use NiiVue with compressed NIfTI and extracted DICOM metadata in JSON. The proposal called for a half-day Base44 embedding trial. Simcha chose Claude Code and a dedicated React/Vite app, so the trial did not take place. The deployed viewer uses Vercel and passed the coordinate checks in J6.
12. Keep sessions in the browser without sign-in. Provide JSON save and restore, including timing data, so researchers can recover after clearing browser storage.
13. Prepare a cropped, compressed DICOM subset ahead of the demo. Naomi can open it without running the TCIA downloader.

## Data

14. Use RIDER Lung CT and RIDER-LungCT-Seg for expert outlines and same-day repeat scans, as Naomi requested.
15. Target about ten RIDER patients with paired scans and exact reference series. Verify thickness before setting the repeatability target; a 5 mm series would change the interpretation. Download time limited the shipped subset to seven pairs with 13–68 mm tumours, annotated on 1.25 mm LUNG-kernel series.
16. Supplement RIDER with roughly ten LIDC nodules for small and difficult appearances. The shipped subset contains seven nodules across five scans: two ground-glass, one part-solid, one spiculated, one subtle solid and two easier solid nodules. LIDC-0828 replaced 0590 (J13). Reader texture ratings span 1 (ground-glass) to 5 (solid).
17. Map Daniel’s eight teaching examples by type, size and location. The subtle solid nodule in LIDC-0017 stands in for a vessel-adjacent case because vessel adjacency was unlabelled. A confirmed chest-wall/collapsed-lung example is also missing.
18. Attribute TCIA and the individual collections in the viewer and documentation. The data licences and the research handoff require it.

## Measurement

19. One click starts a 3D outline and yields long axis, short axis and volume. This targets the time spent drawing every slice by hand.
20. Start with classical 3D region growing, an adjustable threshold, a precomputed lung constraint and an add/erase brush. Ground-glass, vessel-adjacent, wall-adjacent and spiculated lesions challenge the algorithm. A one-day MedSAM trial on ground-glass was proposed for week two.
21. Use the largest axial diameter and greatest perpendicular diameter on the same slice. Their average supplies the sheet’s mean diameter.
22. Suggest the dense component of a part-solid nodule with an adjustable HU threshold. Daniel judges the core visually under his SOP. The original plan called for calibration on LIDC part-solid cases.
23. Flag uncertain edges and possible vessel or chest-wall attachment. Daniel already records uncertainty and needs to see where review matters.

## Follow-up matching

24. Use the baseline location to suggest a follow-up target. Matching costs about ten minutes on a typical repeat visit.
25. Map through an affine transform and refine locally to handle breathing shifts. The proposed image-correlation refinement would require loading both scans. The implementation ranks up to four blobs within 15 mm by distance and volume similarity; close competing scores or a twofold volume change flag uncertainty. Registration uses masked rigid then affine alignment with MOMENTS initialization (J7).
26. Start from a baseline measurement saved by the pilot. Defer sheet import until hospital viewer image numbers can be mapped reliably.
27. Record matched or uncertain status and let Daniel confirm. A wrong pairing affects the whole longitudinal comparison.

## Candidate detection

28. Offer candidate locations and confidence as an optional final feature. False candidates consume review time.
29. Evaluate a trained detector only on cases independent of its training. Many detectors use LUNA16, derived from LIDC. Run detection offline.
30. Keep the demo independent of detector performance. The offline Hessian dot filter found 11/21 in the top ten and 0/2 ground-glass cases. Its experimental jump list defaults to off and contributes no assumed time saving.

## Review, recording and export

31. Let the researcher toggle expert and tool outlines independently, as Daniel requested.
32. Support manual additions and erasures and immediately recompute the measurements.
33. Record row provenance as tool, edited or manual. The edit rate also informs the effort estimate.
34. Export Daniel’s spreadsheet columns in their original order with traceability fields appended. Recording currently takes him 3–5 minutes.
35. Populate patient ID, scan date, series, thickness and image number from scan metadata and viewer geometry.
36. Track active minutes per case to support comparison with Daniel’s existing time records.

## Quality evaluation

37. Compare long axis, short axis, volume and mask overlap with expert annotations. Daniel’s own measurements of the public cases are unavailable.
38. Compare long-axis results with the spread among LIDC radiologists. The evaluation uses the reader range with a 0.5 mm allowance.
39. Target roughly 1 mm test–retest variation on RIDER. The proposed 2–3 longitudinal LIDC cases could not provide independent validation: all eight candidate patients had 2.5–3 mm slices and lacked cross-timepoint nodule IDs independent of registration (J15). Matching evidence is from same-day pairs.
40. Report outcomes by teaching-case type. An overall average can conceal ground-glass failures.
41. Set evaluation thresholds before scoring. Document tuning on evaluation cases separately.

## Time savings

42. Combine a time model with a proposed timed human study. The simulated client cannot operate the tool.
43. Plan approximately ten cases in alternating manual-first/tool-first order to reduce familiarity bias. Study mode supplies separate timers, brush-only manual work and a study export; the case list is in [the study schedule](eval/timed-study-cases.md). Human timing is pending. A separate agent-run KLM estimate counted clicks, reviews and slices requiring brush correction (>20% area difference), using Card, Moran and Newell (1980). Estimated follow-up savings were 50–64%, or 32% without a search benefit; baseline savings were 23–28%. Large central tumours could take longer to correct than to trace.
44. Model each stage using Daniel’s baseline times and estimated reductions. Report baseline and follow-up separately because their proportions in the backlog are unknown.
45. Charge for reviewing false candidates so detection does not inflate the estimate.

## Delivery

46. Plan three increments: viewer/data/measurement/export, then follow-up matching and quality evaluation, then detection, timing and demo polish. Deliver a usable tool at each stage.
47. Share the decision summary with Naomi and Daniel before implementation so they can correct assumptions early. Simcha owns that communication.
48. Report progress, failures and measurements in the assignment’s internal update channel. Simcha owns posting.
49. Deliver the running link, source and run instructions, results, failures and the time-estimation method.

## Boundaries and architecture-review additions

50. Display “Research use only” in the interface and exports.
51. Defer hospital deployment to a discussion after the public-data pilot. IT approval could take months.
52. Give failures comparable prominence to successes, particularly for ground-glass nodules and baseline discovery.
53. Include algorithm version and parameters on every exported row to support comparisons and reproduction months later.
54. Target case loading under five seconds and interactive response under one second. Early production loads were 3.3–3.6 seconds. Main-thread processing on a 120 mm cube took 0.1–1.1 seconds in the initial check, so the planned Web Worker was deferred. Cold loading of the 67 MB LIDC-0590 took 7.3–7.5 seconds; LIDC-0828 replaced it (56 MB), bringing shipped cases under 60 MB. See the evaluation for wider timing variation.
55. Target current Chrome and Edge with WebGL2 and show a clear message if WebGL2 is unavailable.
56. Provide one-click lung and mediastinum windows. Daniel reviews the solid component in the lung window.
