# בדיקה מול הוראות Base44 (Home Assignment, Part 1)

כל שורה במסמך המטלה, והראיה במערכת שנבנתה.

| דרישה במסמך | סטטוס | ראיה |
|---|---|---|
| "Build a tool… hand over to a hospital research team" | ✅ | https://longmarker.vercel.app: כלי ווב, בלי התקנה ובלי IT (החלטה 8) |
| "Your tool should cut that manual time… without hurting the quality" | ⚠️ חלקי | מודל הזמן: −57% בסריקת מעקב (−40% בלי ההנחה על Find), −23% בסריקת בסיס. האיכות מול רדיולוגים ב-[eval/report.md](eval/report.md). **הניסוי המתוזמן דורש אדם** ולא נעשה |
| "Use any language, framework, platform or AI tool" | ✅ | React, NiiVue, Python, lungmask. נבנה ב-Claude Code לפי בחירת שמחה (J0) |
| "For research use only. Do not make clinical claims" | ✅ | באנר בכל מסך, שורת כותרת ב-CSV ("Research use only. Not for clinical use"), ואין פלט של ממאירות או אבחנה (החלטה 3) |
| "All communication goes through the lab's Slack" / "ask the lab" | ✅ | כל הדרישות מגיעות מההתכתבות עם נאומי ודניאל, וצוטטו ב-[decisions.md](decisions.md) |
| "Any update… goes in #base44-internal" | ⏳ פעולה של שמחה | טיוטת העדכון הוכנה. הפרסום בידי שמחה |
| "Work with the lab's practice set… RIDER Lung CT and RIDER-LungCT-Seg" | ✅ | 7 זוגות RIDER, וקווי המתאר `GTVp_*_man` של RIDER-Seg. **הערה:** הורדנו דרך NBIA REST API של TCIA ולא דרך Data Retriever. זה אותו דאטה מאותו שרת |
| "Both are free to use with attribution" | ✅ | ייחוס ב-footer של הכלי, ב-README וב-CSV |
| "You may add medical data that is openly published" | ✅ | LIDC-IDRI (CC BY 3.0, TCIA). הרישיון נבדק בדף האוסף |
| "The lab cannot give you any other data… scans never leave the hospital" | ✅ | רק דאטה ציבורי. שום דבר לא עולה לשרת (החלטה 9) |
| "A link to the running tool" | ✅ | https://longmarker.vercel.app נבדק בלי התחברות (`curl` 200) ובדפדפן, בזרימה מלאה |
| "The source code (e.g. a repository invite), with instructions to run it" | ✅ / ⏳ | ריפו פרטי https://github.com/binim10/longmarker עם [README.md](README.md). **ההזמנה לבודקי Base44 בידי שמחה** |
| "Your results: what works, what fails" | ✅ | [BRIEF.md](BRIEF.md) §4–5 ו-[eval/report.md](eval/report.md), כולל שגיאות שקטות וכשלי איתור |
| "…and how you measured the time saved" | ✅ מתודולוגיה / ⏳ מדידה | מודל עם ניתוח רגישות, טיימר מובנה לכל מקרה, ופרוטוקול ב-[eval/timed-study.md](eval/timed-study.md) |
| "Be ready to present the project" | ✅ | BRIEF, junctions ודמו חי |
| Part 2 (משחק multiplayer ב-Base44) | — | מחוץ להיקף הבנייה הזו |
