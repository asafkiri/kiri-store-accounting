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

ההרשאות שנוספות לחשבון הפרסום:

| תפקיד | היקף | מטרה |
|---|---|---|
| `roles/firebasehosting.admin` | הפרויקט | פרסום האתר וקריאת הגדרות הפרויקט הדרושות ל־Firebase CLI |
| `roles/serviceusage.serviceUsageConsumer` | הפרויקט | שימוש ב־APIs של הפרויקט |
| `roles/run.viewer` | השירות `kiri-store-accounting-ai-scan` ב־`us-east1` בלבד | קריאת הגדרות יעד ההפניה `/api/**`, ש־Hosting מאמת בזמן סיום הפרסום |

`roles/iam.workloadIdentityUser` נוסף על חשבון הפרסום עצמו, רק לזהות הריפו המאושרת. תנאי הכניסה בודק את מזהי הריפו והבעלים המספריים, את `refs/heads/main`, את הנתיב המדויק של `.github/workflows/ci.yml` ואת אירועי `push` או `workflow_dispatch`. ההגדרה אינה מעניקה הרשאות לנתוני החשבוניות ב־Firestore, למסמכי Storage, ל־Secret Manager, לניהול IAM או לפרסום Cloud Run. הרשאת הקריאה לשירות כוללת את תצורתו ומשתני סביבה שהוגדרו כערכים גלויים. אין מפתח service account קבוע; בכל הרצה נוצרת הרשאה זמנית דרך OIDC ו־Application Default Credentials.

בסיום צריך להופיע: **החיבור לפרסום אוטומטי הוגדר בהצלחה.** התעדכנות הרשאות Google עשויה להימשך עד חמש דקות. הצלחת הסקריפט מסיימת את החיבור; הצלחת משימת **Publish Firebase Hosting** מאמתת את הפרסום בפועל.

## בדיקת הפרסום

פתח [GitHub Actions](https://github.com/asafkiri/kiri-store-accounting/actions/workflows/ci.yml). אחרי מיזוג ההגדרה, ההרצה החדשה צריכה להציג הצלחה גם עבור **check** וגם עבור **Publish Firebase Hosting**. סיכום הפרסום כולל את ה־commit שפורסם ואת כתובת האתר.

אם ההרשאות עדיין מתעדכנות ונכשל רק הפרסום, אפשר לבחור **Re-run failed jobs** אחרי מספר דקות. כדי לפרסם שוב את `main` בלי שינוי קוד, בחר **App checks → Run workflow → main**. גם הרצה יזומה מחייבת את כל הבדיקות. הרצה יזומה מענף אחר אינה מפרסמת.

### השלמת הרשאת קריאה ליעד ההפניה

אם ההגדרה הראשונית בוצעה לפני הוספת הרשאת Cloud Run, הפרסום עלול להעלות את הקבצים ואז להיכשל ב־`finalizing version` עם `403 Permission 'run.services.get' denied`. החיבור ל־Google כבר עובד, אך חסרה הרשאת קריאה ליעד ההפניה. אפשר להריץ שוב את סקריפט ההגדרה המעודכן, או להוסיף רק את ההרשאה החסרה ב־Cloud Shell:

```bash
gcloud run services add-iam-policy-binding kiri-store-accounting-ai-scan \
  --project=kiri-store-accounting \
  --region=us-east1 \
  --member='serviceAccount:ksa-hosting-deploy@kiri-store-accounting.iam.gserviceaccount.com' \
  --role=roles/run.viewer \
  --condition=None --quiet --format=none
```

לאחר הצלחת הפקודה והתעדכנות ההרשאה, הפעילו שוב את משימת הפרסום שנכשלה. נדרשת הצלחה של **Publish the tested build** כדי לאשר שהאתר פורסם בפועל.

אין צורך לבצע פקודת פריסה ידנית אחרי כל עדכון. המסלול הידני ב־[SETUP](SETUP.md#5-פריסת-האפליקציה-לfirebase-hosting) נשאר זמין לפי הצורך. שרת ה־AI ממשיך להתפרסם דרך ה־Cloud Build trigger הקיים שלו; קובצי ההגדרה האלה מטפלים בממשק בלבד.

## מקורות

- [Google: חיבור GitHub עם Workload Identity Federation דרך service account](https://github.com/google-github-actions/auth#workload-identity-federation-through-a-service-account)
- [Firebase CLI: Application Default Credentials ב־CI](https://firebase.google.com/docs/cli#use_the_cli_with_ci_systems)
- [Google: הרשאות Firebase Hosting Admin](https://docs.cloud.google.com/iam/docs/roles-permissions/firebasehosting)
- [Google: הרשאות Cloud Run Viewer והגבלתן לשירות יחיד](https://docs.cloud.google.com/run/docs/reference/iam/roles)
- [Google: הוספת הרשאה לשירות Cloud Run](https://docs.cloud.google.com/sdk/gcloud/reference/run/services/add-iam-policy-binding)
- [GitHub: שדות OIDC המשמשים להגבלת החיבור](https://docs.github.com/en/actions/reference/security/oidc)
