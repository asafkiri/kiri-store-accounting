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
