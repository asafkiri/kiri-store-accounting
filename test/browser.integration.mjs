// Runs in CI with native Chromium and WebKit, independently of Node's fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { createBrowserCheckServer } from "../scripts/check-browser.mjs";

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: mobile supplier review confirms creation, similar names and reactivation before saving`, async (t) => {
    const server = createBrowserCheckServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const browser = await engine.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(
      () => document.querySelector("#result").textContent !== "Running…",
    );
    await page.evaluate(async () => {
      const { invoiceForm } = await import("/forms.js");
      document.documentElement.lang = "he";
      document.documentElement.dir = "rtl";
      document.body.innerHTML =
        '<div id="modal" style="max-width:390px;padding:16px"></div><div id="toast"></div>';
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "/styles.css";
      document.head.append(css);
      const drafts = new Map();
      window.supplierRequests = [];
      const ctx = {
        data: {
          suppliers: [
            {
              id: "supplier-marina",
              name: "מרינה בע״מ",
              active: true,
              version: 1,
            },
            {
              id: "supplier-inactive",
              name: "ספק לא פעיל",
              active: false,
              version: 2,
            },
          ],
          invoices: [],
          dailyCash: [],
        },
        drafts: {
          load: async (key) => structuredClone(drafts.get(key)),
          save: async (key, value) => drafts.set(key, structuredClone(value)),
          remove: async (key) => drafts.delete(key),
        },
        dialog: (_title, html) => {
          document.querySelector("#modal").innerHTML = html;
          return document.querySelector("#modal");
        },
        setModalBusy() {},
        closeModal() {},
        mergeRecord() {},
        render() {},
        refresh() {},
        api: {
          save: async (pending) => {
            window.supplierRequests.push(structuredClone(pending));
            return {
              record: { id: pending.path.split("/")[1] },
              ...(pending.body.data.newSupplier
                ? {
                    supplierAction: "created",
                    relatedRecords: [
                      {
                        path: "suppliers/" + pending.body.data.supplierId,
                        record: {
                          id: pending.body.data.supplierId,
                          name: pending.body.data.newSupplier.name,
                        },
                      },
                    ],
                  }
                : {}),
            };
          },
        },
      };
      window.openSupplierReview = (name) =>
        invoiceForm(ctx, null, {
          id: crypto.randomUUID(),
          attachmentIds: [],
          result: {
            supplierName: name,
            documentNumber: crypto.randomUUID(),
            invoiceDate: "2026-09-10",
            documentType: "invoice",
            subtotalAgorot: null,
            vatAgorot: null,
            totalAgorot: 1200,
            finalAgorot: 1200,
            deductions: [],
            uncertainFields: [],
            needsReview: false,
            warnings: [],
          },
        });
      await window.openSupplierReview("ספק מהצילום");
    });
    const create = page.locator("[data-supplier-action=create]");
    const box = await create.boundingBox();
    assert.ok(box.height >= 48 && box.width >= 240);
    await create.click();
    assert.equal(await page.evaluate(() => window.supplierRequests.length), 0);
    await page.locator("[name=review]").check();
    await page.locator("[type=submit]").click();
    await page.waitForFunction(() => window.supplierRequests.length === 1);
    assert.match(
      await page.locator("#toast").innerText(),
      /נפתח ספק חדש: ספק מהצילום/,
    );
    await page.evaluate(() => window.openSupplierReview("מרינה"));
    assert.equal(await page.locator("[name=supplierId]").inputValue(), "");
    assert.equal(
      await page.locator("[data-supplier-action=create]").count(),
      0,
    );
    await page.locator("[data-supplier-action=confirm]").click();
    await page.locator("[name=review]").check();
    await page.locator("[type=submit]").click();
    await page.waitForFunction(() => window.supplierRequests.length === 2);
    await page.evaluate(() => window.openSupplierReview("ספק לא פעיל"));
    await page.locator("[data-supplier-action=reactivate]").click();
    await page.locator("[name=review]").check();
    await page.locator("[type=submit]").click();
    await page.waitForFunction(() => window.supplierRequests.length === 3);
    const requests = await page.evaluate(() => window.supplierRequests);
    assert.equal(requests[0].body.data.newSupplier.name, "ספק מהצילום");
    assert.equal(requests[1].body.data.supplierId, "supplier-marina");
    assert.equal(requests[1].body.data.newSupplier, undefined);
    assert.equal(requests[2].body.data.reactivateSupplier.expectedVersion, 2);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= 390),
    );
  });
  test(`${engine.name()}: reproduce the old receiver failure and verify the fixed API`, async (t) => {
    const server = createBrowserCheckServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const browser = await engine.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => {
      return document.querySelector("#result").textContent !== "Running…";
    });
    const result = await page.locator("#result").innerText();
    assert.match(result, /Legacy receiver: TypeError:/);
    assert.match(result, /Current Api default: PASS/);
    assert.match(result, /Explicitly bound native fetch: PASS/);
    assert.doesNotMatch(result, /FAIL/);
    console.log(`${engine.name()}: ${result}`);
  });
  test(
    `${engine.name()}: eight 24MP pages are prepared before the size check, PDF stays intact and mobile controls are readable`,
    { timeout: 120000 },
    async (t) => {
      const server = createBrowserCheckServer();
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.after(() => new Promise((resolve) => server.close(resolve)));
      const browser = await engine.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({
        viewport: { width: 390, height: 844 },
      });
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      await page.waitForFunction(
        () => document.querySelector("#result").textContent !== "Running…",
      );
      const result = await page.evaluate(async () => {
        const { readFile } = await import("/image-upload.js");
        const { scanDialog } = await import("/scan.js");
        document.body.innerHTML =
          '<div id="modal"></div><div id="toast"></div>';
        const source = document.createElement("canvas");
        source.width = 5712;
        source.height = 4284;
        const pen = source.getContext("2d");
        pen.fillStyle = "white";
        pen.fillRect(0, 0, 5712, 4284);
        pen.font = "80px sans-serif";
        pen.fillStyle = "black";
        pen.fillText("Invoice 123.45 / VAT 0.00", 100, 4200);
        // A deterministic textured band makes the original selection exceed 12MiB.
        const noise = pen.createImageData(5712, 400);
        let seed = 1234;
        for (let i = 0; i < noise.data.length; i += 4) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          noise.data[i] = seed & 255;
          noise.data[i + 1] = (seed >>> 8) & 255;
          noise.data[i + 2] = (seed >>> 16) & 255;
          noise.data[i + 3] = 255;
        }
        pen.putImageData(noise, 0, 1000);
        const original = await new Promise((resolve) =>
          source.toBlob(resolve, "image/png"),
        );
        const originalTotal = original.size * 8;
        source.width = source.height = 1;
        const drafts = new Map();
        let requests = 0;
        const ctx = {
          drafts: {
            load: async (k) => drafts.get(k),
            save: async (k, v) => drafts.set(k, structuredClone(v)),
          },
          dialog: (_title, html) => {
            document.getElementById("modal").innerHTML = html;
            return document.getElementById("modal");
          },
          setModalBusy() {},
          api: {
            request: async () => {
              requests++;
              throw Error("Unexpected request");
            },
          },
        };
        await scanDialog(ctx);
        const transfer = new DataTransfer();
        for (let i = 0; i < 8; i++)
          transfer.items.add(
            new File([original], `page-${i}.png`, { type: "image/png" }),
          );
        const input = document.getElementById("gallery-file");
        input.files = transfer.files;
        await input.onchange();
        const files = drafts.get("scan")?.files || [];
        const dimensions = [];
        for (const f of files) {
          const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
          const image = await createImageBitmap(
            new Blob([bytes], { type: f.mime }),
          );
          dimensions.push([image.width, image.height]);
          image.close();
        }
        const pdf = new File(["%PDF-1.7\nfixture unchanged"], "invoice.pdf", {
          type: "application/pdf",
        });
        const kept = await readFile(pdf);
        return {
          originalTotal,
          count: files.length,
          preparedTotal: files.reduce((n, f) => n + (f.data.length * 3) / 4, 0),
          dimensions,
          requests,
          error: document.getElementById("scan-error").textContent,
          pdfText: atob(kept.data),
          pdfMime: kept.mime,
        };
      });
      assert.ok(result.originalTotal > 12 * 1024 * 1024);
      assert.equal(result.count, 8, result.error);
      assert.ok(result.preparedTotal < 12 * 1024 * 1024);
      assert.deepEqual(result.dimensions, Array(8).fill([2500, 1875]));
      assert.equal(result.requests, 0);
      assert.equal(result.pdfText, "%PDF-1.7\nfixture unchanged");
      assert.equal(result.pdfMime, "application/pdf");
      await page.setContent(
        '<link rel="stylesheet" href="/styles.css"><details class="filter-panel"><summary>סינון</summary></details><label class="field"><small>מע״מ לא ידוע נשאר ריק</small></label>',
      );
      await page.locator(".field small").waitFor();
      const layout = await page.evaluate(() => ({
        target: document.querySelector("summary").getBoundingClientRect()
          .height,
        font: parseFloat(
          getComputedStyle(document.querySelector(".field small")).fontSize,
        ),
      }));
      assert.ok(layout.target >= 44, JSON.stringify(layout));
      assert.ok(layout.font >= 16, JSON.stringify(layout));
      console.log(
        `${engine.name()}: prepared eight 24MP images (${result.originalTotal} -> ${result.preparedTotal} bytes); PDF and mobile sizing PASS`,
      );
    },
  );
}
