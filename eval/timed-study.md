# Timed study protocol (decision 43)

Run by a person; the agent that built the tool cannot time a human. Results go in `eval/timed-study.csv`.

1. Pick 10 cases covering Daniel's 8 teaching types (the case list tags each one). Include at least 3 follow-up scans.
2. For each case, in **alternating order** (odd cases manual first, even cases tool first), do the work twice:
   - **Manual:** in the same viewer, use only the brush (Brush mode) to outline the nodule on every slice, read the numbers, and type them into the sheet.
   - **Tool:** click the nodule, correct if needed, Save, and on follow-ups press *Find in this scan*.
3. The tool's per-case timer (only counts while you're active, pauses after 60 s idle) fills the `minutes` column in the CSV export. For the manual run, use the same timer and note the minutes.
4. Record: case, type, manual minutes, tool minutes, number of corrections (`provenance = edited`), and whether the follow-up match was right.
5. Report the median reduction per scan, separately for baseline and follow-up scans, next to the model in `report.md`.

Caveat to write into the results: the tester built the tool and is not a radiologist, so report the **ratio** (tool/manual), not absolute minutes; anchor absolute minutes on Daniel's own numbers (25–40 min).
