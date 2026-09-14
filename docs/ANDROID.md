# אפליקציית האנדרואיד

האפליקציה לאנדרואיד היא אותו אתר בדיוק, בתוך מעטפת דקה (Capacitor). המסכים נטענים מ־`https://kiri-store-accounting.web.app`, ולכן **כל עדכון שנמזג ל־`main` מגיע לטלפון ברענון הבא, בלי התקנה מחדש**. המעטפת מוסיפה שני דברים שדפדפן אינו יכול לתת:

- **הסורק של גוגל** (ML Kit Document Scanner, דרך Google Play services) — אותו סורק שבשימוש ב־Drive: מוצא את גבולות הדף, מיישר, מנקה, תומך בכמה עמודים ובצילום חוזר. ב״צלם עמוד״ הוא מחליף את המצלמה שבתוך האפליקציה.
- **דף השיתוף של אנדרואיד** — WebView אינו יודע לשמור קובץ מקישור `blob:`, ולכן כל הורדה באפליקציה (ייצוא לרואה החשבון, PDF, תמונה) נפתחת כשיתוף: וואטסאפ, מייל, שמירה בקבצים.

בכל דפדפן אחר, כולל האתר באייפון, אין מעטפת: ״צלם עמוד״ ממשיך לפתוח את המצלמה שבתוך האפליקציה וההורדות נשארות הורדות. הקוד בודק `window.Capacitor` בזמן ריצה (`src/native-bridge.js`), ואם אין — שום מסלול לא משתנה.

## התקנה בטלפון

1. לפתוח בטלפון: <https://github.com/asafkiri/kiri-store-accounting/releases/download/android-latest/kiri-store.apk>
2. אנדרואיד ישאל אם לאפשר התקנה מהמקור הזה — לאשר.
3. להתקין, ולפתוח את ״החשבונות של החנות״.

הקישור קבוע: כל בנייה מחליפה את הקובץ באותה כתובת. התקנה חוזרת על גרסה קיימת שומרת את ההתחברות ואת הטיוטות, כל עוד היא חתומה באותו מפתח.

## מתי צריך APK חדש

רק כששינו את המעטפת עצמה — `android/**`, `capacitor.config.json`, או מסלול הצילום/השיתוף בצד ה־web (`src/native-bridge.js`, `src/scan.js`, `src/export.js`). ה־workflow‏ `.github/workflows/android.yml` בונה אוטומטית בכל מיזוג כזה ל־`main`, ואפשר גם להריץ אותו ידנית מלשונית Actions → ״Android app״ → ״Run workflow״.

## המפתח שחותם על האפליקציה

אנדרואיד מתקין רק אפליקציה חתומה, ומתיר לעדכן אפליקציה קיימת רק בחתימה של אותו מפתח. המפתח שמור כ־secret יחיד בריפו בשם `ANDROID_KEYSTORE_BASE64` (הקובץ עצמו, מקודד base64). הסיסמה שלו קבועה בקוד ה־workflow — הקובץ הוא הסוד, לא הסיסמה.

כדאי לשמור עותק של קובץ ה־keystore בגיבוי אישי. אם הוא יאבד, אפשר ליצור מפתח חדש, אבל אז העדכון הבא בטלפון ידרוש הסרה והתקנה מחדש (הנתונים עצמם בשרת, ולא ייעלמו).

ליצירת מפתח חדש, ולהמרה ל־secret:

```bash
keytool -genkeypair -v -keystore kiri-store-android.keystore -storetype PKCS12 \
  -alias kiri -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass kiri-store-android -keypass kiri-store-android \
  -dname "CN=Kiri Store Accounting, OU=Android, O=Kiri Store, L=Israel, C=IL"
base64 -w0 kiri-store-android.keystore   # התוכן שמודבק ב-secret
```

## מה יש בפנים

- `capacitor.config.json` — מזהה האפליקציה `com.kiristore.accounting`, כתובת האתר החי, ומסך `offline.html` שמוצג כשאין רשת.
- `android/app/src/main/java/com/kiristore/accounting/KiriScannerPlugin.java` — הסורק (`scan`), בדיקת זמינות Play services (`available`), והשיתוף (`shareFileStart` / `shareFileChunk` / `shareFiles`). העמודים חוזרים כ־JPEG בגודל שהאפליקציה שומרת בלי המעטפת (עד 2500px, איכות 88), וקובץ לשיתוף עובר בחלקים של 3MB כדי שייצוא של עשרות מגה לא יוחזק פעמיים בזיכרון.
- אותו קובץ גם מחזיק את רשימת הכתובות שה־WebView טוען בעצמו. בלעדיה Capacitor היה שולח לדפדפן החיצוני כל ניווט שאינו של האפליקציה — כולל ה־iframe של בדיקת האבטחה בהתחברות ב־SMS.
- `src/native-bridge.js` — הצד ה־web של אותו גשר, עם בדיקות ב־`test/native-bridge.test.js` ובדיקת דפדפן שמדמה את המעטפת ב־`test/browser.integration.mjs`.

## מה נבדק ומה לא

ה־CI מקמפל את המעטפת ובודק את הצד ה־web (יחידה ודפדפן, עם גשר מדומה). **התנהגות הסורק, השיתוף וההתחברות בטלפון עצמו נבדקת רק במכשיר.** לפני שמעבירים את האפליקציה לשימוש יומיומי כדאי לעבור על: התחברות ב־SMS, צילום חשבונית בכמה עמודים, בחירת תמונות ו־PDF מהגלריה, ייצוא לרואה החשבון ושיתופו, ופתיחת חשבונית קיימת עם הצילומים שלה.
