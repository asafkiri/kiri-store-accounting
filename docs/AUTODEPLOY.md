# פרסום אוטומטי אחרי מיזוג

לאחר החיבור החד־פעמי שלהלן, מיזוג ל־`main` מפעיל את תהליך **App checks**: בדיקות התאמה לשרת, בדיקות יחידה, build ובדיקות Chromium/WebKit. רק כשהכול עובר, משימת **Publish Firebase Hosting** מפרסמת לאתר הקיים:

https://kiri-store-accounting.web.app

המשימה משתמשת בתוצר הבנייה שנבדק באותה הרצה. פרסומים מתבצעים אחד בכל פעם; הרצה ישנה שכבר הוחלפה ב־main מדלגת על הפרסום כדי שלא להחזיר גרסה ישנה. כל PR נבדק, אך אינו מקבל הרשאת פרסום. רענון האתר בטלפון טוען את הגרסה שפורסמה.

## חיבור חד־פעמי

פתח [Cloud Shell בפרויקט הקיים](https://console.cloud.google.com/?cloudshell=true&project=kiri-store-accounting), עם חשבון Google שמורשה לנהל IAM ושירותים בפרויקט. הסקריפט בודק את מספר הפרויקט `292191260602` לפני השינוי הראשון. אין צורך להתחבר ל־GitHub ב־Cloud Shell או להעתיק מפתחות.

מתוך עותק עדכני של הריפו:

```bash
bash scripts/setup-hosting-ci.sh
```

אם החיבור נעשה לפני מיזוג קובצי ההגדרה, אפשר להריץ את הסקריפט מתוך ה־commit שנבדק ב־PR. יש להשתמש בקישור ל־commit המסוים שנמסר עם ה־PR, ולא בקוד לא מזוהה.

הסקריפט יוצר חשבון פרסום ייעודי `ksa-hosting-deploy` ו־Workload Identity Pool בשם `ksa-hosting-github`, עם ספק `github`. אפשר להריץ אותו שוב אם פעולה נקטעה. הסקריפט מוסיף bindings נדרשים ומשמר bindings קיימים.

ההרשאות שנוספות לחשבון הפרסום בפרויקט:

| תפקיד | מטרה |
|---|---|
| `roles/firebasehosting.admin` | פרסום האתר וקריאת הגדרות הפרויקט הדרושות ל־Firebase CLI |
| `roles/serviceusage.serviceUsageConsumer` | שימוש ב־APIs של הפרויקט |

`roles/iam.workloadIdentityUser` נוסף על חשבון הפרסום עצמו, רק לזהות הריפו המאושרת. תנאי הכניסה בודק את מזהי הריפו והבעלים המספריים, את `refs/heads/main`, את הנתיב המדויק של `.github/workflows/ci.yml` ואת אירועי `push` או `workflow_dispatch`. ההגדרה אינה מעניקה הרשאות לנתוני החשבוניות, למסמכי Storage, לסודות, לניהול IAM או לפרסום Cloud Run. אין מפתח service account קבוע; בכל הרצה נוצרת הרשאה זמנית דרך OIDC ו־Application Default Credentials.

בסיום צריך להופיע: **החיבור לפרסום אוטומטי הוגדר בהצלחה.** התעדכנות הרשאות Google עשויה להימשך עד חמש דקות. הצלחת הסקריפט מסיימת את החיבור; הצלחת משימת **Publish Firebase Hosting** מאמתת את הפרסום בפועל.

## בדיקת הפרסום

פתח [GitHub Actions](https://github.com/asafkiri/kiri-store-accounting/actions/workflows/ci.yml). אחרי מיזוג ההגדרה, ההרצה החדשה צריכה להציג הצלחה גם עבור **check** וגם עבור **Publish Firebase Hosting**. סיכום הפרסום כולל את ה־commit שפורסם ואת כתובת האתר.

אם ההרשאות עדיין מתעדכנות ונכשל רק הפרסום, אפשר לבחור **Re-run failed jobs** אחרי מספר דקות. כדי לפרסם שוב את `main` בלי שינוי קוד, בחר **App checks → Run workflow → main**. גם הרצה יזומה מחייבת את כל הבדיקות. הרצה יזומה מענף אחר אינה מפרסמת.

אין צורך לבצע פקודת פריסה ידנית אחרי כל עדכון. המסלול הידני ב־[SETUP](SETUP.md#5-פריסת-האפליקציה-לfirebase-hosting) נשאר זמין לפי הצורך. שרת ה־AI ממשיך להתפרסם דרך ה־Cloud Build trigger הקיים שלו; קובצי ההגדרה האלה מטפלים בממשק בלבד.

## מקורות

- [Google: חיבור GitHub עם Workload Identity Federation דרך service account](https://github.com/google-github-actions/auth#workload-identity-federation-through-a-service-account)
- [Firebase CLI: Application Default Credentials ב־CI](https://firebase.google.com/docs/cli#use_the_cli_with_ci_systems)
- [Google: הרשאות Firebase Hosting Admin](https://docs.cloud.google.com/iam/docs/roles-permissions/firebasehosting)
- [GitHub: שדות OIDC המשמשים להגבלת החיבור](https://docs.github.com/en/actions/reference/security/oidc)
