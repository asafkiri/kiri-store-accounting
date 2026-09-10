// Runs in CI with native Chromium and WebKit, independently of Node's fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";
import { createBrowserCheckServer } from "../scripts/check-browser.mjs";

for (const engine of [chromium, webkit]) {
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
