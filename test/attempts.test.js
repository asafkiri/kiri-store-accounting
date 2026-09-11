import test from "node:test";
import assert from "node:assert/strict";
import { settleDiscardedAttempts } from "../src/attempts.js";

function setup(request) {
  const rows = new Map([
    [
      "cancelled-mutation-001",
      { mutationId: "mutation-001", entity: "invoices/invoice-001" },
    ],
    [
      "cancelled-mutation-002",
      { mutationId: "mutation-002", entity: "daily-cash/2026-09-10" },
    ],
    ["cash", { fields: { cash: "12.00" } }],
  ]);
  const merged = [];
  return {
    rows,
    merged,
    ctx: {
      api: { request },
      drafts: {
        names: async () => [...rows.keys()],
        load: async (key) => rows.get(key),
        remove: async (key) => rows.delete(key),
      },
      mergeRecord: (record, path) => merged.push({ record, path }),
    },
  };
}

test("discard journal settles cancellation or committed records without replaying writes", async () => {
  const calls = [];
  const { ctx, rows, merged } = setup(async (path, options) => {
    calls.push({ path, options });
    return calls.length === 1
      ? {
          status: "committed",
          path: options.body.entity,
          record: { id: "invoice-001", version: 1 },
          relatedRecords: [
            { path: "suppliers/supplier-001", record: { id: "supplier-001" } },
          ],
        }
      : { status: "cancelled" };
  });
  assert.deepEqual(await settleDiscardedAttempts(ctx), [
    "committed",
    "cancelled",
  ]);
  assert.deepEqual([...rows.keys()], ["cash"]);
  assert.deepEqual(
    merged.map((row) => row.path),
    ["suppliers/supplier-001", "invoices/invoice-001"],
  );
  assert.ok(
    calls.every(
      (call) => call.options.method === "POST" && call.path.endsWith("/cancel"),
    ),
  );
});

test("offline or malformed cancellation keeps its journal and stops the refresh batch", async () => {
  for (const response of [
    "offline",
    { status: "committed" },
    { status: "unknown" },
  ]) {
    let calls = 0;
    const { ctx, rows } = setup(async () => {
      calls++;
      if (response === "offline") throw Error("offline");
      return response;
    });
    assert.deepEqual(await settleDiscardedAttempts(ctx), []);
    assert.equal(calls, 1);
    assert.equal(rows.size, 3);
    await assert.rejects(
      settleDiscardedAttempts(ctx, "cancelled-mutation-001"),
    );
    assert.equal(rows.size, 3);
  }
});

test("changing account during reconciliation does not merge or remove the previous account journal", async () => {
  const { ctx, rows, merged } = setup(async () => {
    ctx.api = {
      request: async () => {
        throw Error("must not use new session");
      },
    };
    return {
      status: "committed",
      path: "invoices/invoice-001",
      record: { id: "invoice-001" },
    };
  });
  assert.deepEqual(await settleDiscardedAttempts(ctx), []);
  assert.equal(rows.size, 3);
  assert.equal(merged.length, 0);
});
