import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { loadModule } from "./load-module.mjs";

async function fixture() {
  const dom = new JSDOM('<div id="recaptcha"></div>');
  globalThis.document = dom.window.document;
  let rendered = 0,
    attempts = 0;
  globalThis.phoneTestSdk = {
    RecaptchaVerifier: class {
      constructor(_auth, element) {
        this.container =
          typeof element === "string"
            ? document.getElementById(element)
            : element;
      }
      async render() {
        if (this.container.childNodes.length)
          throw Error("reCAPTCHA has already been rendered in this element");
        this.container.append(document.createElement("iframe"));
        rendered++;
      }
      clear() {} // Firebase's invisible verifier leaves children behind.
    },
    signInWithPhoneNumber: async () => {
      attempts++;
      if (attempts === 1)
        throw Object.assign(Error("network"), {
          code: "auth/network-request-failed",
        });
      return { confirm: async () => {} };
    },
  };
  const auth = await loadModule("src/auth.js", {
    "firebase/app": "export const initializeApp = () => ({});",
    "firebase/auth":
      "export const {RecaptchaVerifier, signInWithPhoneNumber} = globalThis.phoneTestSdk; export const getAuth=()=>({}), setPersistence=()=>{}, browserLocalPersistence={}, onAuthStateChanged=()=>{}, signOut=()=>{};",
  });
  return { ...auth, counts: () => ({ rendered, attempts }) };
}
test("SMS retry after a failed send clears invisible reCAPTCHA and can send again", async () => {
  const f = await fixture();
  await assert.rejects(f.sendCode({}, "0500000000", "recaptcha"));
  const session = await f.sendCode({}, "0500000000", "recaptcha");
  assert.ok(session.confirmation);
  session.clear();
  assert.equal(document.getElementById("recaptcha").childNodes.length, 0);
  assert.deepEqual(f.counts(), { rendered: 2, attempts: 2 });
});
test("invalid phone input never renders reCAPTCHA or sends SMS", async () => {
  const f = await fixture();
  await assert.rejects(f.sendCode({}, "1", "recaptcha"), /מספר טלפון תקין/);
  assert.deepEqual(f.counts(), { rendered: 0, attempts: 0 });
});

test("startup configuration fetch reports a network failure in Hebrew", async t => {
  const f = await fixture(), original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => { throw new TypeError("Load failed"); };
  await assert.rejects(f.initializeAuth(), /אין חיבור לרשת כרגע/);
});
