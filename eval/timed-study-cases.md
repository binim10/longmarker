# Timed study: case list and order (decision 43)

How to run it:
1. **Header → Study = `manual` or `tool`.** The timer runs separately for each condition. In `manual` the tool's help (click-to-measure, Find) is switched off and you work with the brush only.
2. **Initials.** Enter your initials in the header.
3. **Order:** go through the cases in the order below. On odd rows do **manual** first, on even rows **tool** first. Then do the same case in the other condition.
   - In **manual:** outline the nodule with the brush on every slice where it appears, read the numbers, and note them as you would in the sheet.
   - In **tool:** click, correct if needed, and Save. On a follow-up scan press **Find**.
4. **Baseline before follow-up:** do each baseline case before its follow-up, because **Find** needs a nodule saved on the baseline.
5. **At the end:** **Export study** writes `longmarker_timed_study.csv`, and **Export CSV** writes the measurements. Send both. Also fill in `corrections` and `match_ok` in `timed-study.csv`.

| # | Case (as shown in the list) | Teaching type | First condition |
|---|---|---|---|
| 1 | R-1801720707 · baseline (test) | follow-up match (small), 13 mm | manual |
| 2 | R-1801720707 · follow-up (retest) | follow-up match (small) | tool |
| 3 | R-2669524182 · baseline (test) | large tumour, 39 mm | manual |
| 4 | R-2669524182 · follow-up (retest) | large tumour, follow-up | tool |
| 5 | R-1867199702 · baseline (test) | follow-up match (small), 17 mm | manual |
| 6 | R-1867199702 · follow-up (retest) | follow-up match (small) | tool |
| 7 | LIDC-IDRI-0088 | faint ground-glass (2 nodules) | manual |
| 8 | LIDC-IDRI-0828 | part-solid | tool |
| 9 | LIDC-IDRI-0915 | spiculated | manual |
| 10 | LIDC-IDRI-0164 | solid, easy (2 nodules) | tool |
| 11 | LIDC-IDRI-0017 | small solid (subtle) | manual |

Caveats to report with the results:
- **The second pass on the same case is faster,** because the tester already knows where the nodule is. The alternating order spreads this bias evenly between the two conditions.
- **The tester is not a radiologist and built the tool.** So report the **tool/manual ratio**, not absolute minutes, and anchor absolute times on Daniel's 25–40 minutes.
