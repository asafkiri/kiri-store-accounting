# הפעלה בתשתית הקיימת — צעד אחר צעד

הפרויקט: **kiri-store-accounting**, מספר **292191260602**. השירות הקיים: **kiri-store-accounting-ai-scan**, אזור **us-east1**. כתובת האפליקציה: **https://kiri-store-accounting.web.app**.

אין ליצור project חדש, Cloud Run חדש, מפתח OpenAI חדש או Realtime Database. הדפדפן ייגש לנתונים רק דרך השרת.

## 1. בדיקת בניית השרת

1. פתח [Cloud Build — History](https://console.cloud.google.com/cloud-build/builds?project=kiri-store-accounting).
2. בחר אזור `us-east1` אם הטריגר אזורי; אם לא מופיע build, בדוק גם את התצוגה הגלובלית.
3. פתח את ה־build של הריפו `kiri-store-accounting-ai-scan` וה־commit האחרון מ־`main`.
4. המתן למצב הצלחה. ה־Dockerfile כולל בדיקות, ולכן build שבור לא יפיק image תקין לפריסה.
5. אם לא נוצר build: Cloud Build → Triggers → הטריגר **הקיים** של הריפו → Run → branch `main`. אין ליצור שירות/טריגר חלופי.
6. אם הטריגר עדיין מחפש Dockerfile במקום אחר, Edit → Build configuration → Dockerfile → repository root (`/`) → Dockerfile. שמור את שלב הפריסה ואת יעד השירות שכבר הוגדרו.
7. פתח [Cloud Run](https://console.cloud.google.com/run?project=kiri-store-accounting), בחר בשירות הקיים, וודא שה־revision האחרון Ready וש־100% מהתעבורה מופנים אליו.

## 2. המספר המורשה — נשאר פרטי

1. בתוך שירות Cloud Run הקיים לחץ **Edit & deploy new revision**.
2. עבור ל־**Containers → Variables & Secrets**.
3. השאר ללא שינוי את הסוד `OPENAI_API_KEY` שמפנה ל־`OPENAI_API_KEY:latest`.
4. השאר `OPENAI_MODEL=gpt-5.6-luna`.
5. הוסף משתנה סביבה **ALLOWED_PHONE_NUMBER**. הזן **רק במסך Google Cloud** את המספר של אבא בפורמט E.164: קידומת המדינה, בלי האפס הראשון ובלי רווחים. אל תשלח אותו לריפו או ל־README.
6. ניתן במקום ערך רגיל להפנות את המשתנה לסוד ייעודי ב־Secret Manager. זה אופציונלי; אין צורך לשנות את סוד OpenAI.
7. הוסף/ודא `FIREBASE_PROJECT_ID=kiri-store-accounting` ו־`FIREBASE_STORAGE_BUCKET=kiri-store-accounting.firebasestorage.app`.
8. הוסף/ודא `NODE_ENV=production`.
9. `ALLOWED_ORIGIN` יכול להיות `https://kiri-store-accounting.web.app,https://kiri-store-accounting.firebaseapp.com` — זו גם ברירת המחדל בקוד.
10. `ALLOWED_UID` הוא אופציונלי. השאר ריק אם רוצים לאשר לפי המספר בלבד; אם מוגדר בנוסף, נדרשת התאמה גם ל־UID.
11. ודא את המשאבים הקיימים: min=0, max=2, concurrency=2, memory=512 MiB, CPU=1, timeout=60 שניות, request-based billing.
12. לפני Deploy: מספר שאינו בפורמט E.164 או `OPENAI_MODEL` שאינו `gpt-5.6-luna` מונעים מה־revision לעלות. יש לתקן את הערך במסך Variables & Secrets, בלי לפרסם אותו.
13. לחץ Deploy. בלי allowlist השרת עולה לבדיקת health, אבל חוסם את המערכת ב־503. זו התנהגות מכוונת.

ברירת המחדל: עד 30 סריקות ביום ו־300 בחודש. אפשר לשנות `MAX_SCANS_PER_DAY` / `MAX_SCANS_PER_MONTH`. אלו מגבלות מספר בקשות; אינן מבטיחות חשבון של עד 25 ₪. אין escalation או retry אוטומטי.

## 3. הרשאות Google Cloud

Service account של ה־revision צריך להישאר:

`firebase-adminsdk-fbsvc@kiri-store-accounting.iam.gserviceaccount.com`

בדוק ב־**IAM & Admin → IAM** את ההרשאות הקיימות. אל תחליף חשבון שירות ואל תיצור קובץ מפתח. נדרשת יכולת:

- לקרוא ולכתוב ב־Firestore — לדוגמה `Cloud Datastore User` (`roles/datastore.user`).
- לקרוא משתמשי Firebase Auth לצורך בדיקת ביטול token — לדוגמה `Firebase Authentication Viewer` (`roles/firebaseauth.viewer`), או הרשאה קיימת שמכילה יכולת זו.
- לקרוא וליצור אובייקטים ב־bucket הקיים — `Storage Object User` (`roles/storage.objectUser`) ברמת bucket מספיקה לפעולות הנדרשות.
- לקרוא את סוד OpenAI — `Secret Manager Secret Accessor`, שכבר הוגדר לפי תיאור ההקמה.

הוסף רק אם חסרה יכולת בפועל. `firebase-adminsdk` עשוי כבר להחזיק בהרשאות מתאימות.

ב־Cloud Run → **Security / Authentication**, אפשר הגעה ציבורית לשירות עבור Firebase Hosting (Allow unauthenticated / Allow public access, בהתאם למסך). זו הרשאת הגעה לשרת; **כל גישה לנתונים עדיין מחייבת Firebase ID token והמספר המורשה בתוך הקוד**. אין לפתוח Firestore או Storage לציבור.

## 4. Firebase Authentication והגדרת Web App

1. פתח [Firebase Console](https://console.firebase.google.com/project/kiri-store-accounting/overview).
2. Project settings → General → Your apps. אם יש Web App, השאר אותה. אם אין, Add app → סמל `</>` → שם `Kiri Store Accounting` → רשום אותה **בפרויקט הקיים**. אין צורך להעתיק את ה־config לקוד.
3. בתוך ה־Web App: לחץ **Link to a Firebase Hosting site**, בחר **kiri-store-accounting** ושמור. רישום Web App לבדו אינו מספיק: אתר Hosting צריך להיות מקושר אליה. בדוק שבכתובת `https://kiri-store-accounting.web.app/__/firebase/init.json` יש `projectId` נכון וגם `appId`.
4. Build → Authentication → Sign-in method → ודא Phone = Enabled.
5. Authentication → Settings → Authorized domains → ודא שקיימים `kiri-store-accounting.web.app` ו־`kiri-store-accounting.firebaseapp.com`.
6. Authentication → Settings → SMS region policy → עריכת המדיניות → בחר מצב **Allow / Allowlist** (מדינות מותרות), סמן **Israel (IL)** ושמור. פתח שוב את המדיניות ובדוק שהמצב והבחירה נשמרו. אם נבחר מצב **Deny / Denylist** (מדינות חסומות), סימון ישראל דווקא חוסם אותה. אין צורך לאפשר מדינות נוספות עבור השימוש המתואר. זו מדיניות מדינות יעד ל־SMS, נפרדת מהפעלת ספק Phone ומהמספר המורשה ב־Cloud Run.
7. אין להגדיר את מספר אבא כ־test phone number עם קוד קבוע בייצור. התחברות אמיתית צריכה לקבל SMS אמיתי.

האפליקציה טוענת config ציבורי אוטומטית מ־`/__/firebase/init.json`. מפתח OpenAI ומספר הטלפון אינם נמצאים ב־config הזה. [תיעוד כתובות Firebase Hosting](https://firebase.google.com/docs/hosting/reserved-urls).

## 5. פריסת האפליקציה ל־Firebase Hosting

יש להשלים פעם אחת את [חיבור הפרסום האוטומטי](AUTODEPLOY.md) בחשבון Google שמורשה להגדיר את ההרשאות בפרויקט. לאחר מכן, מיזוג ל־main מפעיל את הבדיקות ומפרסם את הממשק אוטומטית כשהן עוברות. בלי חיבור ההרשאות, שלב הפרסום ב־GitHub ייכשל ולא יוצג כהצלחה. ההוראות בהמשך הסעיף הן לפרסום ידני לפי הצורך.

בבדיקת הריפו נמצאה הגדרת GitHub Pages קיימת שמפעילה `pages build and deployment`. האפליקציה אינה משתמשת בה. כדי לכבות אותה: בריפו האפליקציה → **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: None → Save**. אל תמחק את הריפו. ההגדרה אינה משנה את Firebase Hosting. [הוראות GitHub](https://docs.github.com/en/pages/getting-started-with-github-pages/deleting-a-github-pages-site).

1. פתח [Google Cloud Console](https://console.cloud.google.com/?project=kiri-store-accounting).
2. לחץ למעלה על סמל **Activate Cloud Shell** (`>_`). אשר את ההרשאה לחשבון שלך אם Google מבקש.
3. אם זו הפעם הראשונה, הרץ:

```sh
git clone https://github.com/asafkiri/kiri-store-accounting.git
cd kiri-store-accounting
```

אם התיקייה כבר קיימת, היכנס אליה והריץ `git pull --ff-only origin main` במקום clone. אל תדרוס עריכות מקומיות.

4. ודא Node.js בגרסה 22 ומעלה (`node --version`). ב־Cloud Shell אפשר לבחור גרסה כך: `nvm install 22` ואז `nvm use 22`. הרץ:

```sh
npm ci &&
npm test &&
npm run build &&
npx firebase-tools@14.16.0 deploy --project kiri-store-accounting --only hosting
```

5. אם ה־CLI מבקש התחברות, הרץ `npx firebase-tools@14.16.0 login --no-localhost`, השלם את הכניסה בדפדפן לפי ההוראות, ואז הרץ שוב את פקודת deploy. אין להעתיק tokens לריפו או לצ׳אט.
6. בסיום צריכה להופיע כתובת `https://kiri-store-accounting.web.app` והודעת Deploy complete.
7. Firebase Console → Firestore → Rules: צריך להיות `allow read, write: if false`.
8. Firebase Console → Storage → Rules: צריך להיות `allow read, write: if false`.

`firebase.json` מפנה `/api/**` לשירות Cloud Run הקיים ב־us-east1. אין יצירת Cloud Run חדש. [תיעוד ההפניה](https://firebase.google.com/docs/hosting/cloud-run).

## 6. בדיקות לפני שימוש יומיומי

1. מתוך Cloud Run העתק את **Service URL**. פתח `<Service URL>/health`; צריך להופיע JSON עם `ok: true`.
2. פתח `<Service URL>/api/v1/me` ללא token; צריך לקבל 401. זה תקין.
3. פתח בטלפון של אבא את כתובת האפליקציה.
4. הזן את מספר הטלפון שלו, קבל SMS, הזן את הקוד והיכנס.
5. הוסף ספק בשם **ספק בדיקה**.
6. הוסף ידנית חשבונית `בדיקה-001`, לפני מע״מ 100, מע״מ 18, כולל 118, סופי 118. בדוק וסמן אישור → שמור חשבונית.
7. רענן. החשבונית צריכה להיטען מהשרת.
8. סמן כשולמה בצ׳ק: תאריך תשלום = יום המסירה, ותאריך פירעון עתידי שונה. פתח שוב ובדוק ששניהם נשארו נכונים.
9. קופה ורב־קו: רשום קופה 100 ורב־קו 25. ודא שני סכומים נפרדים ושאינם משפיעים על החשבונית.
10. התחל טיוטת חשבונית, כבה רשת, מלא עוד שדה. ניסיון שמירה חייב להראות שלא התקבל אישור; אחרי החזרת הרשת נסה שוב. בדוק שנוצרה חשבונית אחת בלבד.
11. סרוק **חשבונית אחת אמיתית וברורה**. בדוק מול המסמך כל סכום ובמיוחד מע״מ. ודא שלפני לחיצה על שמור חשבונית היא אינה מופיעה ברשימת החשבוניות.
12. נסה גם מסמך שבו לא נמצא מע״מ: השדה צריך להישאר ריק ולדרוש בדיקה, לא להפוך ל־0.
13. סגור ופתח שוב את האפליקציה: באותו מכשיר לא אמור להידרש SMS מחדש כל עוד ה־session נשמר.
14. התחבר במכשיר נוסף עם אותו מספר ובדוק שהחשבונית מופיעה. אם נערכה רשומה במכשיר אחר, שמירה מגרסה ישנה חייבת להציג התנגשות ולא לדרוס.
15. אפשר לבדוק עם מספר אחר בשליטתך: גם אם יצליח להתחבר ב־SMS, הוא חייב לקבל הודעת שאין הרשאה לנתוני החנות. בדיקה כזאת צורכת SMS נוסף.
16. הורד גיבוי JSON ו־CSV מסונן לחודש ובדוק את הרשומות. מחק את חשבוניות הבדיקה דרך הממשק עם אישור; אפשר להפוך את ספק הבדיקה ללא פעיל.

## אם משהו נכשל

| מה רואים | מה לבדוק |
|---|---|
| המערכת עדיין אינה מוכנה | פריסת Hosting, רישום Web App ו־`/__/firebase/init.json` |
| הגדרת Firebase אינה תואמת לחנות | Project settings → Your apps → Web App → Link to a Firebase Hosting site → kiri-store-accounting; בדוק `appId` ב־init.json |
| לא ניתן לאמת את ההתחברות כרגע / 503 | תקלה זמנית או הרשאות IAM של שירות האימות; בדוק request ID ו־errorCategory בלוג. אין צורך לשנות את המספר המורשה |
| גישה טרם הוגדרה / 503 | `ALLOWED_PHONE_NUMBER` ב־revision הפעיל |
| לחשבון אין הרשאה / 403 | המספר בפורמט E.164, וה־UID אם הוגדר; אין לפרסם אותם |
| שגיאת SMS / captcha | Phone Enabled, דומיינים מורשים, SMS region policy ומכסה |
| `SMS unable to be sent until this region enabled` / `auth/operation-not-allowed` | Firebase דחה את בקשת ה־SMS בגלל מדינת היעד. בדוק בפרויקט הזה שמדיניות SMS היא Allow עם Israel מסומנת ושמורה. קוד `operation-not-allowed` בלי פירוט המדינה יכול לציין גם שספק Phone כבוי. שינוי מדיניות זו אינו דורש פריסת Hosting מחדש. |
| health לא עולה | build, Dockerfile, revision Ready, `$PORT`, והגעה ציבורית לשירות |
| me עובד אבל שמירה נכשלת | הרשאות IAM ל־Firestore, מסד `(default)` וה־service account הפעיל |
| העלאת מסמך נכשלת | הרשאות bucket, סוג וגודל קובץ; עד 8 עמודים ו־12 מגה |
| הסריקה אינה זמינה | Secret reference, Secret Accessor, `OPENAI_MODEL` והזמינות בחשבון OpenAI |
| ניתוק אחרי סריקה | לחץ בדיקת תוצאה; אין להפעיל מיד סריקה חדשה בתשלום |
| התנגשות גרסאות / 409 | הטיוטה נשמרת; טען את העדכון מהשרת ובדוק לפני עריכה נוספת |

לוגים נבדקים לפי request ID/קטגוריית השגיאה. אין לשלוח מפתח OpenAI, token או SMS code. קוד השרת אינו מבטיח שספק ה־AI הצליח לקרוא מסמך מסוים; הסקירה האנושית נשארת הכרחית.


### אייפון, התקנה וקבצים

יש להוסיף למסך הבית **לפני ההתחברות הראשונה**, ואז לפתוח מהאייקון ולהתחבר שם. Safari והאפליקציה ממסך הבית עשויים להשתמש באחסון ובהתחברות נפרדים. טיוטה מקומית אינה גיבוי: Safari עשוי לפנות נתוני אתר שלא נעשה בו שימוש ממושך. שמור רשומות בחנות והורד גיבויים.

נדרש דפדפן עדכני; באייפון נדרש iOS 16 ומעלה. בדפדפן שחסרות בו היכולות הנדרשות מוצגת הודעת עדכון בעברית. קובצי PDF נפתחים בצופה המלא של המכשיר, עם אפשרות שמירה/שיתוף. ביישום המותקן באייפון הייצוא מציע שיתוף קובץ כשנתמך; להדפסה פתח ב־Safari ובחר שתף → הדפס.

בתעודת זיכוי מקלידים את גובה הסכום כמספר חיובי ובוחרים סוג מסמך זיכוי. לאחר בדיקה ואישור הוא נשמר כהפחתה. סכומי המקור מהסריקה נשארים מוצגים, ומע״מ חסר נשאר חסר. רשומות ישנות לא משתנות אוטומטית.
