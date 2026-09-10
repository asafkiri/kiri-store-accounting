import test from "node:test";
import assert from "node:assert/strict";
import { registerAccountingTools } from "../src/agent-tools.js";
test("optional agent tool validates arguments and authorization, and reads the same invoice state", async () => {
  let registered,
    checks = 0;
  const ctx = {
    api: {
      request: async (path) => {
        assert.equal(path, "me");
        checks++;
      },
    },
    data: {
      invoices: [
        { status: "unpaid", finalAgorot: 123 },
        { status: "paid", finalAgorot: 999 },
        { status: "unpaid", deletedAt: 1, finalAgorot: 100 },
      ],
    },
    lastRefresh: 100,
  };
  const cleanup = registerAccountingTools(ctx, {
    registerTool: (tool) => {
      registered = tool;
    },
  });
  assert.equal(registered.name, "read_unpaid_invoice_summary");
  assert.equal(registered.annotations.readOnlyHint, true);
  assert.deepEqual(await registered.execute({}), {
    count: 1,
    finalAgorot: 123,
    currency: "ILS",
    loadedAt: 100,
  });
  assert.equal(checks, 1);
  await assert.rejects(registered.execute({ force: true }));
  ctx.api = null;
  await assert.rejects(registered.execute({}));
  cleanup();
});
