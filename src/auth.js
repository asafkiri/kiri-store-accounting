import { initializeApp } from "firebase/app";
import {
  getAuth,
  setPersistence,
  browserLocalPersistence,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  onAuthStateChanged,
  signOut,
} from "firebase/auth";
export async function initializeAuth() {
  // Firebase Hosting serves this PUBLIC web-app configuration automatically. It contains no server secrets.
  const r = await fetch("/__/firebase/init.json", { cache: "no-store" });
  if (!r.ok)
    throw Error(
      "המערכת עדיין לא חוברה ל־Firebase. יש להשלים את ההפעלה הראשונית.",
    );
  let config;
  try {
    config = await r.json();
  } catch {
    throw Error(
      "הגדרת החיבור עדיין אינה זמינה. יש להשלים את ההפעלה הראשונית ב־Firebase.",
    );
  }
  if (
    config.projectId !== "kiri-store-accounting" ||
    !config.apiKey ||
    !config.appId
  )
    throw Error("הגדרת Firebase אינה תואמת לחנות.");
  const auth = getAuth(initializeApp(config));
  auth.languageCode = "he";
  await setPersistence(auth, browserLocalPersistence);
  return auth;
}
export { onAuthStateChanged, signOut };
export function normalizePhone(value) {
  let s = value.replace(/[\s()-]/g, "");
  if (/^0[2-9]\d{7,8}$/.test(s)) s = "+972" + s.slice(1);
  if (!/^\+[1-9]\d{7,14}$/.test(s)) throw Error("יש להזין מספר טלפון תקין.");
  return s;
}
export async function sendCode(auth, phone, element) {
  const normalized = normalizePhone(phone);
  const container =
    typeof element === "string" ? document.getElementById(element) : element;
  if (!container) throw Error("בדיקת האבטחה לא נטענה. רענן את העמוד ונסה שוב.");
  container.replaceChildren();
  let verifier,
    cleared = false;
  const clear = () => {
    if (cleared) return;
    cleared = true;
    try {
      verifier?.clear();
    } finally {
      container.replaceChildren();
    }
  };
  try {
    verifier = new RecaptchaVerifier(auth, container, { size: "invisible" });
    await verifier.render();
    const confirmation = await signInWithPhoneNumber(
      auth,
      normalized,
      verifier,
    );
    return { confirmation, clear };
  } catch (e) {
    clear();
    throw e;
  }
}
export function authMessage(e) {
  const code = typeof e?.code === "string" ? e.code : "";
  const detail = typeof e?.message === "string" ? e.message : "";
  if (code === "auth/operation-not-allowed") {
    // This code also covers a disabled Phone provider; only the specific
    // Firebase region diagnostic proves that the destination is blocked.
    if (
      /SMS unable to be sent until this region enabled by the app developer/i.test(
        detail,
      )
    )
      return "שליחת SMS למדינה של מספר הטלפון חסומה כרגע. יש לאפשר אותה בהגדרות מדינות ה־SMS ב־Firebase.";
    return "הכניסה באמצעות SMS אינה מאופשרת כרגע. יש לבדוק שהתחברות בטלפון מופעלת בהגדרות Firebase.";
  }
  return (
    {
      "auth/invalid-verification-code": "הקוד אינו נכון. בדוק את הודעת ה־SMS.",
      "auth/code-expired": "הקוד פג. אפשר לבקש קוד חדש.",
      "auth/too-many-requests":
        "היו כמה ניסיונות רצופים. יש להמתין לפני ניסיון נוסף.",
      "auth/invalid-phone-number": "מספר הטלפון אינו תקין.",
      "auth/network-request-failed": "אין חיבור יציב כרגע. נסה שוב.",
      "auth/captcha-check-failed": "בדיקת האבטחה לא הושלמה. נסה שוב.",
      "auth/quota-exceeded":
        "שליחת ה־SMS אינה זמינה כרגע. יש לבדוק את הגדרת השירות.",
      "auth/unauthorized-domain":
        "כתובת האפליקציה לא אושרה להתחברות. יש להשלים את הגדרת Firebase.",
    }[code] ||
    (!code && /[\u0590-\u05ff]/u.test(detail)
      ? detail
      : "ההתחברות לא הושלמה. נסה שוב.")
  );
}
