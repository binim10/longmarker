# Architecture review of the pilot decisions

Review date: November 17, 2026. This records proposals submitted for Simcha’s approval. The [decision log](decisions.md) records subsequent implementation choices.

The lab’s goals and workflow supported decisions 1–7. Preloaded cases changed the server trade-off in decisions 10 and 13. The viewer and difficult-case strategy needed concrete choices. Other open issues included reference series thickness, optimistic same-day matching and an unconfirmed submission date.

## ADR-1. Precompute and serve static files

The initial proposal used a small live service for registration and detection. All inputs were already known. Running Python ahead of time and storing transforms and candidates alongside scans removes the API, queues, cold starts and ongoing server operation. A live service would ease later API reuse but add complexity and demo risk. Keep interaction in the browser and report offline runtime separately. User-supplied scans would require a new ingestion path. Update decisions 10 and 29.

## ADR-2. Use NiiVue

NiiVue reads NIfTI natively and provides basic drawing with a smaller learning curve. Cornerstone3D/OHIF offers richer segmentation and native DICOM at a higher integration cost within three weeks. Extract patient ID, date, series and thickness to JSON. Direct hospital DICOM support may later require conversion or a different viewer.

## ADR-3. Give the researcher segmentation controls

Compare plain region growing, region growing with controls, and a click-based model such as MedSAM. The first struggles with ground-glass, attached and spiculated lesions. The second adds an adjustable threshold, a precomputed lung mask and an add/erase brush. The third takes longer to integrate, and fully precomputed inference limits free click placement. Adopt the controls and propose a one-day ground-glass model trial in week two. Charge for manual corrections and report outcomes by case type.

## ADR-4. Test Base44 integration before selecting a platform

The proposal was a half-day trial of embedding NiiVue and loading a public volume. A successful trial would support a Base44 implementation. Otherwise, document the integration limit and use a dedicated static app. Simcha subsequently chose React/Vite directly; the trial did not run.

## Follow-up items from the review

- Verify the RIDER-Seg reference series on day one. Five-millimetre slices would make the proposed 1 mm repeatability target difficult to interpret.
- Same-day pairs favour registration. Investigate two or three of the eight longitudinal LIDC patients and document any limitations. J15 records the independent-reference problem.
- Use affine alignment followed by local refinement and snapping for breathing shifts. Defer hospital spreadsheet import until viewer image numbering can be reconciled.
- Export and restore a JSON session, including timing data, so cleared browser storage is recoverable.
- The proposed timing participant built the tool and is not a radiologist. Report ratios, anchor absolute times to Daniel’s estimates and disclose participant bias.
- Add algorithm version and thresholds per CSV row, WebGL2 checks in Chrome and Edge, lung and mediastinum windows, and budgets of five seconds per load and one second per click.
