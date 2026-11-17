# LongMarker: תכנון מערכת (פיילוט)

כל ההחלטות מפורטות ב-[decisions.md](decisions.md), והמספרים בסוגריים מפנים אליהן. לשימוש מחקרי בלבד.

## 1. דרישות

### דרישות פונקציונליות
| # | דרישה | החלטות |
|---|---|---|
| F1 | לפתוח מקרה טעון מראש (RIDER או LIDC) ב-viewer צירי, עם חלון ריאה וחלון mediastinum | 13, 56 |
| F2 | קליק על קשרית מחזיר קו מתאר תלת-ממדי, ציר ארוך, ציר קצר ונפח | 19–21 |
| F3 | סרגל ספים, ומברשת להוספה ולמחיקה. המספרים מתעדכנים מיד | 20, 32 |
| F4 | הצעה לרכיב solid לפי סף שאפשר לשנות, ודניאל מאשר | 22 |
| F5 | סימון Uncertain כשהמדידה לא אמינה | 23, 27 |
| F6 | בסריקת מעקב: קפיצה למיקום המשוער של הקשרית מסריקת הבסיס, ודניאל מאשר | 24–27 |
| F7 | הצגה של קו המתאר המומחה ליד קו המתאר של הכלי, עם אפשרות להדליק ולכבות כל אחד | 31 |
| F8 | רשימת מועמדים לאיתור, עם רמת ביטחון. אפשר לכבות אותה | 28, 30 |
| F9 | ייצוא CSV בעמודות של הגיליון, עם עמודת מקור וגרסת אלגוריתם | 33–35, 53 |
| F10 | מדידת זמן אוטומטית לכל מקרה, ושמירה וטעינה של קובץ session | 12, 36 |

### דרישות לא-פונקציונליות
| דרישה | יעד |
|---|---|
| זמינות | אתר סטטי, בלי שרת חי (10) |
| ביצועים | טעינת מקרה תוך פחות מ-5 שניות. קליק או שינוי סף תוך פחות משנייה (54) |
| עלות ותחזוקה | אפס (8, 10) |
| פרטיות | דאטה ציבורי בלבד. שום דבר לא עולה לשרת (9) |
| תאימות | Chrome ו-Edge עם WebGL2 (55) |
| שחזוריות | גרסת אלגוריתם ופרמטרים בכל שורה (53) |
| נפח אחסון | כ-20 מקרים, בערך 10–20MB למקרה אחרי חיתוך ודחיסה |

### אילוצים
- שבוע אחד עד גרסה עובדת לחלק 1, ו-3 שבועות עד הדמו לנאומי (46).
- מפתח אחד: ה-FDE עם Claude Code.
- אין IT, אין התקנה ואין תקציב.

## 2. ארכיטקטורה ברמה גבוהה

```
 ┌─────────────── OFFLINE (במחשב של המפתח, Python) ───────────────┐
 │ TCIA (RIDER, RIDER-Seg, LIDC)                                   │
 │   │  download subset                                            │
 │   ▼                                                             │
 │ pipeline/                                                       │
 │   1. ingest     DICOM → NIfTI (int16, gzip), metadata → JSON    │
 │   2. crop       חיתוך לתיבת הריאות, resample לפרוסות של 1.25 מ"מ │
 │   3. lungmask   מסכת ריאות (שמאל/ימין)                           │
 │   4. reference  RTSTRUCT/SEG/LIDC XML → מסכות מומחה              │
 │   5. register   זוג בסיס→מעקב: affine על מסכות הריאה             │
 │   6. detect     מועמדים (אופציונלי, שבוע 3)                      │
 │   7. eval       מדדי דיוק ועקביות (offline)                      │
 │   ▼                                                             │
 │ public/cases/<case_id>/…  +  public/manifest.json               │
 └──────────────────────────────┬──────────────────────────────────┘
                                │ build & deploy (static)
 ┌──────────────────────────────▼──────────────────────────────────┐
 │ BROWSER (React + Vite + NiiVue)                                  │
 │  CaseList ─► Viewer (NiiVue, WebGL2)                             │
 │                 │ click / threshold / brush                      │
 │                 ▼                                                │
 │            measure/ (TS, Web Worker)                             │
 │              regionGrow3D · axes · volume · solidCore            │
 │                 │                                                │
 │  FollowUp ◄── transforms from case files (affine + local snap)   │
 │                 ▼                                                │
 │            Session store (IndexedDB) ─► CSV export / session.json│
 │            Timer per case                                        │
 └──────────────────────────────────────────────────────────────────┘
```

## 3. רכיבים

### 3.1 צינור עיבוד מראש (`pipeline/`, Python 3.11)
| שלב | ספריות | קלט → פלט |
|---|---|---|
| ingest | pydicom, SimpleITK | סדרת DICOM → `ct.nii.gz` ו-`meta.json` |
| crop/resample | SimpleITK | `ct.nii.gz` חתוך לתיבת הריאות עם שוליים של 10 מ"מ |
| lungmask | lungmask (U-Net מאומן), ואם הוא נכשל: סף HU וחיבור רכיבים | `lungs.nii.gz` |
| reference | pydicom-seg / rt-utils, pylidc | `ref_<reader>.nii.gz` לכל קשרית |
| register | SimpleITK (affine, Mattes MI על המסכות) | `reg_<base>_to_<fu>.json` (מטריצה 4×4) |
| detect | MONAI lung_nodule_ct_detection (שבוע 3, אם יש זמן) | `candidates.json` |
| eval | numpy, pandas | `eval/results.csv` ו-`eval/report.md` |

**כללים לצינור:**
- כל הרצה דטרמיניסטית.
- כל פלט מקבל `pipeline_version`.
- שום PHI: הדאטה ב-TCIA כבר de-identified.

### 3.2 אפליקציית ווב (`web/`, React + TypeScript + Vite)
| מודול | אחריות |
|---|---|
| `CaseList` | רשימת המקרים מ-`manifest.json`, מסוננת לפי מקור, סוג ומקרה הוראה |
| `Viewer` | עוטף את NiiVue: תצוגה צירית ראשית ו-MPR קטן, חלונות צפייה, שכבות overlay (כלי, מומחה, מועמדים) |
| `measure/` | ב-Web Worker: `regionGrow3D(seed, lo, hi, lungMask)`, `axes(mask)`, `volume(mask)`, `solidCore(mask, hu)` |
| `Edit` | מברשת להוספה ולמחיקה על המסכה, ואחריה חישוב מחדש |
| `FollowUp` | ממפה נקודה מסריקת הבסיס לסריקת המעקב: affine, אחר כך חיפוש מקומי של 15 מ"מ על מפת דמיון, ואחר כך "הצמדה" לכתם |
| `Session` | ב-IndexedDB: מדידות, אירועי עריכה וזמנים. ייצוא וייבוא של `session.json` |
| `Export` | CSV בעמודות של דניאל, עם עמודת מקור וגרסה |
| `Timer` | מתחיל בפתיחת מקרה ונעצר בייצוא או בסגירה. לא סופר זמן שבו החלון לא פעיל יותר מ-60 שניות |
| `Banner` | "Research use only" ושורת ייחוס ל-TCIA |

### 3.3 אחסון ופריסה
- קבצים סטטיים על Vercel או Cloudflare Pages. ההכרעה תלויה בניסוי של Base44 (החלטה 11).
- הסריקות נשמרות ב-`public/cases`. אם נפח הקבצים גדול מדי לאחסון, הן יעברו לאחסון אובייקטים ציבורי (R2) עם CORS.

## 4. מודל נתונים

### `manifest.json`
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

### רשומת מדידה (בדפדפן)
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

### CSV: העמודות של דניאל בדיוק, ועוד שלוש בסוף
`patient_id, scan_date, timepoint, series, slice_thickness, nodule_id, lobe, image_number, type, long_axis_mm, short_axis_mm, mean_diameter_mm, solid_component_mm, volume_mm3, match_status, minutes, initials, notes` **+** `provenance, algo_version, params`

## 5. אלגוריתמים, בפירוט

### 5.1 קו מתאר בקליק (`regionGrow3D`)
1. הסף מתחיל מ-HU של נקודת הקליק ושל סביבתה (קובייה של 5×5×5): `lo = max(-800, μ - 2σ)`, `hi = 400`. הסרגל משנה את `lo`.
2. מילוי (flood fill) תלת-ממדי עם קישוריות 6, רק בתוך מסכת הריאות. זו החסימה של דופן החזה.
3. פתיחה מורפולוגית ברדיוס 1 voxel, שמנתקת כלי דם דקים. אחר כך נשאר רק הרכיב שמכיל את נקודת הקליק.
4. אם המסכה יוצאת מתיבה של 60 מ"מ, היא "דלפה". המדידה מסומנת Uncertain, ומוצעת העלאה של `lo`.
5. כל החישוב נעשה בתוך קובייה של 80 מ"מ סביב נקודת הקליק, ולכן הוא לוקח פחות משנייה.

### 5.2 צירים ונפח
- **נפח:** מספר ה-voxels כפול נפח voxel.
- **פרוסת המדידה:** הפרוסה הצירית שבה שטח המסכה הכי גדול.
- **ציר ארוך:** המרחק המקסימלי בין שתי נקודות על קו המתאר בפרוסה. מחושב על ה-convex hull.
- **ציר קצר:** הרוחב המקסימלי בכיוון שניצב לציר הארוך.
- **mean:** הממוצע של שני הצירים.
- הצירים מצוירים על המסך, כמו קליפר.

### 5.3 רכיב solid
- הצעה: החלק בתוך המסכה שבו HU גדול מ-`solidHu`. ברירת המחדל תכויל על מקרי part-solid ב-LIDC.
- מהחלק הזה מחושב הקוטר הארוך ביותר, בחלון ריאה.
- דניאל מאשר או מתקן. כל תיקון משנה את המקור ל-edited.

### 5.4 התאמה בסריקת המעקב
1. הנקודה מסריקת הבסיס מועברת לסריקת המעקב דרך מטריצת ה-affine שחושבה מראש.
2. חיפוש מקומי ברדיוס 15 מ"מ: הכלי מחפש את המיקום שבו הקובייה סביב הנקודה הכי דומה לקובייה בסריקת הבסיס (NCC).
3. "הצמדה" לכתם הצפוף הקרוב ביותר, ואז `regionGrow3D`.
4. אם הדמיון קטן מסף שנקבע מראש, או אם נמצאו שני כתמים קרובים, ההתאמה מסומנת Uncertain.

## 6. הערכה (offline, `pipeline/eval`)
| מדד | נגד מה | יעד |
|---|---|---|
| הפרש בציר ארוך ובציר קצר, במ"מ | קו המתאר של RIDER-Seg, והקוראים ב-LIDC | קטן מהפער בין הקוראים ב-LIDC (38) |
| Dice, והפרש נפח באחוזים | אותו דבר | מדווח לפי סוג מקרה (40) |
| עקביות בין שתי הסריקות | זוגות RIDER | הפרש של עד כ-1 מ"מ (39) |
| הצלחת התאמה | זוגות RIDER, ו-2–3 מקרי מעקב מ-LIDC | אחוז ההתאמות הנכונות |
| מועמדים שגויים לכל סריקה | RIDER בלבד | מדווח, ומקוזז מהחיסכון (45) |
| זמן | ניסוי מתוזמן ומודל זמן | חיסכון של כ-50% בסריקות מעקב (1, 42–44) |

הספים נקבעים לפני ההרצה, ב-`eval/thresholds.yaml` (41).

## 7. מבנה הריפו
```
longmarker/
  decisions.md  architecture-review.md  design.md  README.md
  pipeline/   ingest.py crop.py lungmask.py reference.py register.py detect.py eval/
  web/        src/{CaseList,Viewer,measure,FollowUp,Session,Export}/ public/{manifest.json,cases/}
  data/       (gitignored) raw TCIA downloads
```

## 8. תוכנית לשבוע 1
| יום | משימה | יציאה |
|---|---|---|
| 1 | לאמת סדרות ועובי פרוסה ב-RIDER-Seg. להוריד 2 מטופלים. ניסוי Base44 של חצי יום | החלטה על פלטפורמה. אומת שיש ground truth |
| 2 | ingest, crop, lungmask, reference למטופל אחד. NiiVue מציג CT עם קו המתאר המומחה | מקרה ראשון בדפדפן |
| 3 | `regionGrow3D`, צירים ונפח ב-Worker. סרגל ספים | מדידה בקליק עובדת |
| 4 | מברשת, CSV, Timer, Session. באנר וייחוס | זרימה מלאה למקרה אחד |
| 5 | להרחיב לכ-10 מקרי RIDER. Deploy. עדכון ל-#base44-internal עם לינק | **לינק עובד** |

שבוע 2: התאמה בסריקת המעקב, תת-הקבוצה של LIDC, eval, ויום ניסוי של MedSAM.
שבוע 3: איתור, ניסוי הזמנים, דוח וליטוש הדמו.

## 9. ממה צריך להיזהר, ומה לבחון שוב כשהכלי יגדל
- **GGO:** ייתכן ש-region growing לא יחזיק ב-GGO. אם כך, MedSAM יורץ מראש כ"הצעה שנייה".
- **נפח אחסון:** אם האחסון הסטטי מוגבל, הסריקות יעברו לאחסון אובייקטים.
- **סריקות אמיתיות (שלב 2):** צריך פענוח DICOM בדפדפן או שירות מקומי. `measure/` כבר רץ בדפדפן, אבל רישום ואיתור יצטרכו להריץ בדפדפן גרסה קלה (ONNX-web) או שירות שאושר על ידי IT.
- **יותר ממשתמש אחד ושיתוף:** כרגע הכל בקובץ session. אם המעבדה תרצה עבודה משותפת, יידרש backend, ואולי כאן Base44 ייכנס בטבעיות.
