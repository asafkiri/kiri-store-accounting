import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { Drafts } from "../src/drafts.js";
test("encrypted drafts and pending mutations survive reload, are per-user, and signout clears them", async () => {
  const a = new Drafts("owner-unit-a");
  await a.open();
  const data = {
    fields: { documentNumber: "private-document-test", vat: "" },
    pending: { path: "invoices/unit-test", body: { mutationId: "stable-id" } },
  };
  await a.save("invoice", data);
  const fresh = new Drafts("owner-unit-a");
  await fresh.open();
  assert.deepEqual(await fresh.load("invoice"), data);
  const other = new Drafts("owner-unit-b");
  await other.open();
  assert.equal(await other.load("invoice"), null);
  const tx = a.db.transaction("drafts");
  const values = await new Promise((resolve) => {
    const req = tx.objectStore("drafts").getAll();
    req.onsuccess = () => resolve(req.result);
  });
  assert.ok(!JSON.stringify(values).includes("private-document-test"));
  assert.equal(a.key.extractable, false);
  await fresh.clear();
  assert.equal(await a.load("invoice"), null);
});
test("rapid changes persist in order and latest draft survives a new instance", async () => {
  const a = new Drafts("owner-unit-c");
  await a.open();
  await Promise.all([
    a.save("cash", { cash: "1" }),
    a.save("cash", { cash: "12" }),
    a.save("cash", { cash: "123" }),
  ]);
  const b = new Drafts("owner-unit-c");
  await b.open();
  assert.equal((await b.load("cash")).cash, "123");
});

test("closed and browser-forced IndexedDB connections reopen once and keep the same encrypted drafts", async () => {
  const { forceCloseDatabase } = await import("fake-indexeddb");
  const a = new Drafts("closed-connection");
  await a.save("invoice", { pending: { mutationId: "original-id" } });
  a.db.close();
  assert.equal((await a.load("invoice")).pending.mutationId, "original-id");
  forceCloseDatabase(a.db);
  await new Promise(resolve => setTimeout(resolve, 0));
  await Promise.all([a.save("cash", { cash: "1" }), a.save("cash", { cash: "2" })]);
  a.db.close();
  assert.deepEqual((await a.names()).sort(), ["cash", "invoice"]);
  a.db.close();
  await a.remove("invoice");
  assert.equal(await a.load("invoice"), null);
  a.db.onversionchange();
  assert.equal(a.db, null);
  assert.equal((await a.load("cash")).cash, "2");
  a.db.close();
  await a.clear();
  assert.deepEqual(await a.names(), []);
  a.db.close();
});


test("closure during asynchronous encryption reopens without losing the write", async t => {
  const { forceCloseDatabase } = await import("fake-indexeddb");
  const drafts = new Drafts("close-during-encryption");
  await drafts.open();
  const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  let interrupted = false;
  t.mock.method(crypto.subtle, "encrypt", async (...args) => {
    const bytes = await encrypt(...args);
    if (!interrupted) {
      interrupted = true;
      forceCloseDatabase(drafts.db);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return bytes;
  });
  await drafts.save("cash", { cash: "456" });
  assert.equal((await drafts.load("cash")).cash, "456");
  assert.equal(interrupted, true);
  drafts.db.close();
});
