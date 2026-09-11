// Runs in CI with native Chromium and WebKit, independently of Node's fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile as readTestFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createBrowserCheckServer } from "../scripts/check-browser.mjs";
import { installScannerFixtures } from "./scanner-fixtures.mjs";

// Exercise narrow Android/Chromium and iPhone/WebKit layouts with touch enabled.
// These are browser emulations, not a claim of testing physical phones.
const phoneOptions = (engine) => ({
  viewport:
    engine.name() === "chromium"
      ? { width: 360, height: 800 }
      : { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 3,
});

async function scannerPage(t, engine) {
  const server = createBrowserCheckServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await engine.launch(); t.after(() => browser.close());
  const page = await browser.newPage(phoneOptions(engine));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => document.querySelector("#result").textContent !== "Running…");
  const workerName = (await readdir(new URL("../dist/assets", import.meta.url))).find(name => /^scan-worker-.*\.js$/.test(name));
  assert.ok(workerName, "Run npm run build before browser tests");
  const hosting = JSON.parse(await readTestFile(new URL("../firebase.json", import.meta.url), "utf8"));
  const csp = hosting.hosting.headers[0].headers.find(h => h.key === "Content-Security-Policy").value;
  await page.evaluate(({ workerName, csp }) => {
    window.SCAN_WORKER_URL = "/assets/" + workerName;
    window.scannerCspViolations = [];
    document.addEventListener("securitypolicyviolation", event => window.scannerCspViolations.push(event.violatedDirective));
    const meta = document.createElement("meta"); meta.httpEquiv = "Content-Security-Policy";
    // frame-ancestors is an HTTP-only directive, irrelevant to this test page.
    meta.content = csp.replace(/; frame-ancestors [^;]+/, ""); document.head.append(meta);
  }, { workerName, csp });
  await page.evaluate(installScannerFixtures);
  return page;
}

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: scanner geometry, perspective/20-degree/long fixtures and thin text preservation`, async t => {
    const page = await scannerPage(t, engine);
    const result = await page.evaluate(async () => {
      const { orderCorners, homography, projectPoint, detectCorners, warpImage, enhanceImage, fullCorners } = await import("/scan-worker.js");
      const expected = [{ x: 20, y: 30 }, { x: 450, y: 80 }, { x: 400, y: 700 }, { x: 10, y: 640 }];
      const ordered = orderCorners([expected[2], expected[0], expected[3], expected[1]]);
      const known = [.9, .12, 20, .03, 1.1, 18, .0002, .0003, 1];
      const base = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 850 }, { x: 0, y: 850 }];
      const transform = homography(base, base.map(p => projectPoint(known, p)));
      const predictionErrors = [...base, { x: 200, y: 400 }, { x: 730, y: 210 }].map(p => {
        const a = projectPoint(known, p), b = projectPoint(transform, p); return Math.hypot(a.x - b.x, a.y - b.y);
      });
      const detections = [];
      for (const mode of ["perspective", "rotated", "long", "none", "circle"]) {
        const { canvas, corners } = window.makeDocumentCanvas(mode, mode === "long" ? 500 : 1000);
        const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
        const found = detectCorners(pixels);
        const error = corners && found ? Math.max(...found.map((p, i) => Math.hypot((p.x - corners[i].x) * canvas.width, (p.y - corners[i].y) * canvas.height))) / Math.max(canvas.width, canvas.height) : null;
        detections.push({ mode, found, error });
      }
      const rotated = document.createElement("canvas"); rotated.width = 1000; rotated.height = 850;
      const pen = rotated.getContext("2d"); pen.fillStyle = "#222"; pen.fillRect(0, 0, 1000, 850);
      pen.translate(500, 425); pen.rotate(20 * Math.PI / 180); pen.fillStyle = "white"; pen.fillRect(-230, -300, 460, 600);
      pen.fillStyle = "#333"; pen.fillRect(-210, -2, 420, 4);
      const { corners } = window.makeDocumentCanvas("rotated");
      const warped = warpImage(pen.getImageData(0, 0, 1000, 850), corners);
      let darkRowMin = Infinity, darkRowMax = 0;
      for (let x = 25; x < warped.width - 25; x += 10) for (let y = 10; y < warped.height - 10; y++) {
        if (warped.data[(y * warped.width + x) * 4] < 100) { darkRowMin = Math.min(darkRowMin, y); darkRowMax = Math.max(darkRowMax, y); }
      }
      const thin = new ImageData(320, 250);
      for (let y = 0; y < thin.height; y++) for (let x = 0; x < thin.width; x++) {
        const i = (y * thin.width + x) * 4, gray = x === 160 ? 184 : 220;
        thin.data.set([gray, gray, gray, 255], i);
      }
      const before = [...thin.data.slice((100 * 320 + 160) * 4, (100 * 320 + 161) * 4)];
      const enhanced = enhanceImage(thin);
      const text = enhanced.data[(100 * 320 + 160) * 4], paper = enhanced.data[(100 * 320 + 150) * 4];
      const small = warpImage(new ImageData(200, 300), fullCorners());
      return { expected, ordered, predictionErrors, detections, rotation: [warped.width, warped.height, darkRowMax - darkRowMin], thin: { before, text, paper }, small: [small.width, small.height] };
    });
    assert.deepEqual(result.ordered, result.expected);
    assert.ok(result.predictionErrors.every(e => e < .5), JSON.stringify(result.predictionErrors));
    for (const detection of result.detections) {
      if (["none", "circle"].includes(detection.mode)) assert.equal(detection.found, null, detection.mode);
      else { assert.ok(detection.found, detection.mode); assert.ok(detection.error <= .02, JSON.stringify(detection)); }
    }
    assert.ok(Math.abs(result.rotation[0] - 461) <= 1 && Math.abs(result.rotation[1] - 601) <= 1, JSON.stringify(result.rotation));
    assert.ok(result.rotation[2] <= 5, "the rotated stripe must become horizontal");
    assert.ok(result.thin.paper - result.thin.text >= 30, JSON.stringify(result.thin));
    assert.ok(result.thin.text > 0 && result.thin.text < 240, "thin gray printing must remain gray");
    assert.deepEqual(result.small, [200, 300], "no enlargement of a small original");
  });

  test(`${engine.name()}: local camera crop, corner dragging, one upload and unchanged human Review gate`, { timeout: 60000 }, async t => {
    const page = await scannerPage(t, engine);
    const errors = []; page.on("pageerror", e => errors.push(e.message));
    await page.evaluate(() => window.openScanner());
    await page.evaluate(() => window.chooseScanPhoto());
    await page.waitForFunction(() => !document.querySelector("[data-crop-accept]").disabled);
    await page.waitForFunction(() => !document.querySelector("[data-crop-zoom]").disabled);
    await mkdir("test-artifacts", { recursive: true });
    await page.screenshot({ path: `test-artifacts/scanner-${engine.name()}.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal scrolling on a phone");
    assert.equal(await page.locator("[data-crop-corner]").count(), 4);
    const handle = page.locator('[data-crop-corner="0"]');
    const before = await handle.evaluate(el => el.style.left);
    const box = await handle.boundingBox(); assert.ok(box.width >= 48 && box.height >= 48);
    if (engine.name() === "chromium") {
      const session = await page.context().newCDPSession(page);
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x + 8, y: point.y + 8 }] });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await session.detach();
    } else {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2 + 8, { steps: 4 }); await page.mouse.up();
    }
    assert.notEqual(await handle.evaluate(el => el.style.left), before);
    assert.equal(await page.evaluate(() => window.scanRequests.length), 0);
    // A cancelled retake leaves the current selection intact.
    const adjusted = await handle.evaluate(el => el.style.left);
    await page.evaluate(() => document.querySelector("[data-crop-retake]").onchange());
    assert.equal(await handle.evaluate(el => el.style.left), adjusted);
    await page.locator("[data-crop-accept]").tap();
    await page.waitForFunction(() => window.scanDrafts().find(([k]) => k === "scan")?.[1].files.length === 1);
    const photo = await page.evaluate(async () => {
      const file = window.scanDrafts().find(([k]) => k === "scan")[1].files[0];
      const blob = new Blob([Uint8Array.from(atob(file.data), c => c.charCodeAt(0))], { type: file.mime });
      const bitmap = await createImageBitmap(blob);
      const result = { keys: Object.keys(file).sort(), width: bitmap.width, height: bitmap.height, mime: file.mime, bytes: blob.size }; bitmap.close(); return result;
    });
    assert.deepEqual(photo.keys, ["data", "mime", "name"]);
    assert.equal(photo.mime, "image/jpeg"); assert.equal(Math.max(photo.width, photo.height), 2500);
    assert.equal(await page.evaluate(() => window.scanRequests.length), 0);
    await page.locator("#run-scan").tap();
    await page.waitForSelector("#invoice-form");
    assert.deepEqual(await page.evaluate(() => window.scanRequests.map(r => r.path)), ["documents", "scan-invoice"]);
    assert.equal(await page.locator("[name=review]").isChecked(), false);
    assert.equal(await page.evaluate(() => window.invoiceSaves.length), 0);
    assert.equal(await page.locator("[name=final]").inputValue(), "3995.00");
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.scannerCspViolations), []);
    console.log(`${engine.name()}: locally cropped 12MP photo -> ${photo.width}x${photo.height}, ${photo.bytes} bytes; touch/review PASS`);
  });

  test(`${engine.name()}: missing boundaries and worker failure keep the full-photo escape usable`, { timeout: 60000 }, async t => {
    const page = await scannerPage(t, engine);
    await page.evaluate(() => window.openScanner());
    await page.evaluate(() => window.chooseScanPhoto("gallery-file", "none"));
    await page.waitForFunction(() => document.querySelector("[data-crop-status]").textContent.includes("לא זוהו גבולות"));
    assert.deepEqual(await page.locator("[data-crop-corner]").evaluateAll(handles => handles.map(h => [h.style.left, h.style.top])), [["0%", "0%"], ["100%", "0%"], ["100%", "100%"], ["0%", "100%"]]);
    await page.locator("[data-crop-original]").tap();
    await page.waitForFunction(() => !document.querySelector(".scan-crop"));
    const equal = await page.evaluate(async () => {
      const { readFile } = await import("/image-upload.js");
      return JSON.stringify(await readFile(window.selectedPhoto)) === JSON.stringify(window.scanDrafts()[0][1].files[0]);
    });
    assert.equal(equal, true, "without crop must match the existing full-photo preparation exactly");
    await page.evaluate(() => {
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        postMessage(message, ...args) { if (message.type !== "process") super.postMessage(message, ...args); }
      };
    });
    await page.evaluate(() => window.chooseScanPhoto());
    await page.waitForFunction(() => !document.querySelector("[data-crop-accept]").disabled);
    await page.locator("[data-crop-accept]").tap();
    await page.waitForFunction(() => document.querySelector("[data-crop-status]").textContent.includes("מיישר ושומר"));
    await page.locator("[data-crop-original]").tap();
    await page.waitForFunction(() => !document.querySelector(".scan-crop"));
    assert.equal(await page.evaluate(() => window.scanDrafts()[0][1].files.length), 2);
    await page.evaluate(() => { window.Worker = class { constructor() { throw Error("Worker unavailable"); } }; });
    await page.evaluate(() => window.chooseScanPhoto());
    await page.waitForFunction(() => document.querySelector("[data-crop-status]").textContent.includes("העיבוד אינו זמין"));
    assert.equal(await page.locator("[data-crop-original]").isEnabled(), true);
    await page.locator("[data-crop-original]").tap();
    await page.waitForFunction(() => !document.querySelector(".scan-crop"));
    assert.equal(await page.evaluate(() => window.scanDrafts()[0][1].files.length), 3);
    assert.equal(await page.evaluate(() => window.scanRequests.length), 0);
    assert.equal(await page.locator("#run-scan").isEnabled(), true);
  });

  test(`${engine.name()}: EXIF orientation and canvas fallback preserve resolution and strip metadata`, { timeout: 60000 }, async t => {
    for (const fallback of [false, true]) {
      const page = await scannerPage(t, engine);
      await page.evaluate(() => window.openScanner());
      await page.evaluate(async fallback => {
        if (fallback) window.SCAN_WORKER_URL = "/scan-worker-no-offscreen.js";
        const canvas = document.createElement("canvas"); canvas.width = 3000; canvas.height = 2000;
        const pen = canvas.getContext("2d"); pen.fillStyle = "white"; pen.fillRect(0, 0, 3000, 2000);
        pen.fillStyle = "#222"; pen.fillRect(100, 100, 200, 200);
        const jpeg = new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .94))).arrayBuffer());
        // A minimal EXIF APP1 segment: orientation 6 (90 degrees clockwise).
        const exif = new Uint8Array([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0]);
        const photo = new File([jpeg.slice(0, 2), exif, jpeg.slice(2)], "rotated.jpg", { type: "image/jpeg" });
        const transfer = new DataTransfer(); transfer.items.add(photo);
        const input = document.querySelector("#camera-file"); input.files = transfer.files;
        window.pendingPhotoSelection = input.onchange();
      }, fallback);
      await page.waitForFunction(() => !document.querySelector("[data-crop-accept]").disabled);
      await page.waitForFunction(() => !document.querySelector("[data-crop-zoom]").disabled);
      const preview = await page.locator("[data-crop-source]").evaluate(img => [img.naturalWidth, img.naturalHeight]);
      assert.ok(preview[1] > preview[0], "EXIF is applied before positioning corners");
      await page.locator("[data-crop-accept]").tap();
      await page.waitForFunction(() => !document.querySelector(".scan-crop"));
      const dimensions = await page.evaluate(async () => {
        const file = window.scanDrafts()[0][1].files[0];
        const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(file.data), c => c.charCodeAt(0))], { type: file.mime }));
        const out = [bitmap.width, bitmap.height, atob(file.data).includes("Exif\0\0")]; bitmap.close(); return out;
      });
      assert.deepEqual(dimensions, [1666, 2500, false], `fallback=${fallback}`);
      assert.deepEqual(await page.evaluate(() => window.scannerCspViolations), []);
      await page.close();
    }
  });
}

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: today's cash starts clean and a failed save can be cancelled, edited and discarded offline`, async (t) => {
    const server = createBrowserCheckServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const browser = await engine.launch();
    t.after(() => browser.close());
    const page = await browser.newPage(phoneOptions(engine));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(
      () => document.querySelector("#result").textContent !== "Running…",
    );
    await page.evaluate(async () => {
      const { cashForm } = await import("/forms.js");
      const { today } = await import("/format.js");
      document.body.innerHTML = '<div id="modal"></div><div id="toast"></div>';
      const drafts = new Map([
        [
          "cash",
          {
            mode: "edit",
            recordId: "2000-01-01",
            version: 2,
            fields: {
              date: "2000-01-01",
              cash: "900",
              ravKav: "800",
              notes: "",
            },
          },
        ],
        ["invoice", { fields: { notes: "another draft" } }],
      ]);
      window.cashRequests = [];
      const ctx = {
        data: { dailyCash: [], suppliers: [], invoices: [] },
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
        render() {},
        refresh() {},
        mergeRecord() {},
        api: {
          save: async (pending) => {
            window.cashRequests.push(structuredClone(pending));
            throw Object.assign(Error("השרת אינו זמין"), { status: 503 });
          },
          request: async () => {
            throw Error("אין חיבור לרשת");
          },
        },
      };
      window.cashToday = today();
      window.cashDrafts = () => [...drafts.entries()];
      window.reopenCash = () => cashForm(ctx);
      await window.reopenCash();
    });
    const date = page.locator("[name=date]"),
      cash = page.locator("[name=cash]");
    assert.equal(
      await date.inputValue(),
      await page.evaluate(() => window.cashToday),
    );
    assert.equal(await date.evaluate((el) => el.readOnly), false);
    assert.equal(await cash.inputValue(), "");
    assert.equal(
      await page.evaluate(() => matchMedia("(pointer: coarse)").matches),
      true,
    );
    await cash.fill("120.45");
    await page.locator("[type=submit]").tap();
    await page.waitForFunction(
      () =>
        !document.querySelector("[type=submit]").disabled &&
        !document.querySelector("[data-cancel-attempt]").hidden,
    );
    assert.equal(await cash.isDisabled(), true);
    await page.locator("[data-cancel-attempt]").tap();
    await page.waitForFunction(
      () => !document.querySelector("[name=cash]").disabled,
    );
    await cash.fill("140.50");
    await page.evaluate(() => window.reopenCash());
    assert.equal(await cash.inputValue(), "140.50");
    assert.equal(await cash.isDisabled(), false);
    await page.locator("[type=submit]").tap();
    await page.waitForFunction(
      () =>
        !document.querySelector("[type=submit]").disabled &&
        document
          .querySelector("[data-form-error]")
          .textContent.includes("אין חיבור"),
    );
    assert.equal(await page.evaluate(() => window.cashRequests.length), 1);
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator("[data-discard-draft]").tap();
    await page.waitForFunction(
      () => !window.cashDrafts().some(([key]) => key === "cash"),
    );
    const result = await page.evaluate(() => ({
      rows: window.cashDrafts(),
      requests: window.cashRequests,
      today: window.cashToday,
    }));
    assert.equal(result.requests[0].path, "daily-cash/" + result.today);
    assert.equal(result.requests[0].body.data.cashAgorot, 12045);
    const rows = new Map(result.rows);
    assert.equal(rows.get("saved-cash-2000-01-01").fields.cash, "900");
    assert.equal(rows.get("invoice").fields.notes, "another draft");
    const receipt = result.rows.find(([key]) =>
      key.startsWith("cancelled-"),
    )[1];
    assert.deepEqual(Object.keys(receipt).sort(), ["entity", "mutationId"]);
  });
  test(`${engine.name()}: mobile supplier review confirms creation, similar names and reactivation before saving`, async (t) => {
    const server = createBrowserCheckServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const browser = await engine.launch();
    t.after(() => browser.close());
    const page = await browser.newPage(phoneOptions(engine));
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
    await create.tap();
    assert.equal(await page.evaluate(() => window.supplierRequests.length), 0);
    await page.locator("[name=review]").check();
    await page.locator("[type=submit]").tap();
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
    await page.locator("[data-supplier-action=confirm]").tap();
    await page.locator("[name=review]").check();
    await page.locator("[type=submit]").tap();
    await page.waitForFunction(() => window.supplierRequests.length === 2);
    await page.evaluate(() => window.openSupplierReview("ספק לא פעיל"));
    await page.locator("[data-supplier-action=reactivate]").tap();
    await page.locator("[name=review]").check();
    await page.locator("[type=submit]").tap();
    await page.waitForFunction(() => window.supplierRequests.length === 3);
    const requests = await page.evaluate(() => window.supplierRequests);
    assert.equal(requests[0].body.data.newSupplier.name, "ספק מהצילום");
    assert.equal(requests[1].body.data.supplierId, "supplier-marina");
    assert.equal(requests[1].body.data.newSupplier, undefined);
    assert.equal(requests[2].body.data.reactivateSupplier.expectedVersion, 2);
    assert.ok(
      await page.evaluate(
        (width) => document.documentElement.scrollWidth <= width,
        page.viewportSize().width,
      ),
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
      const page = await browser.newPage(phoneOptions(engine));
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
        const selection = input.onchange();
        for (let i = 0; i < 8; i++) {
          const deadline = Date.now() + 15000;
          while (!document.querySelector("[data-crop-original]")) {
            if (Date.now() > deadline) throw Error("Missing crop view");
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          document.querySelector("[data-crop-original]").click();
          while ((drafts.get("scan")?.files.length || 0) <= i) {
            if (Date.now() > deadline) throw Error("Page was not retained");
            await new Promise(resolve => setTimeout(resolve, 10));
          }
        }
        await selection;
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
        '<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"><details class="filter-panel"><summary>סינון</summary></details><label class="field"><small>מע״מ לא ידוע נשאר ריק</small></label>',
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

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: native IndexedDB reopens after a committed save and PDF offers the full viewer`, async t => {
    const page = await scannerPage(t, engine);
    const result = await page.evaluate(async () => {
      const { Drafts } = await import("/drafts.js");
      const { cashForm } = await import("/forms.js");
      const { previewDocument } = await import("/preview.js");
      document.body.innerHTML = '<div id="modal"></div><div id="toast"></div>';
      const drafts = new Drafts("native-close-regression");
      await drafts.save("preserved", { secret: "still-encrypted" });
      drafts.db.close();
      const preserved = await drafts.load("preserved");
      let closed = false, merged, writes = 0;
      const ctx = {
        data: { dailyCash: [] }, drafts,
        dialog: (_title, body) => { const el = document.querySelector("#modal"); el.innerHTML = body; return el; },
        setModalBusy() {}, closeModal() { closed = true; }, render() {}, refresh() {},
        mergeRecord(record) { merged = record; },
        api: { save: async pending => { writes++; drafts.db.close(); return { record: { id: "cash-native", ...pending.body.data } }; } },
      };
      await cashForm(ctx);
      const form = document.querySelector("form");
      form.elements.cash.value = "123";
      form.dispatchEvent(new Event("input", { bubbles: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      const deadline = Date.now() + 5000;
      while (!closed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      const remaining = await drafts.load("cash");
      const message = document.querySelector("#toast").textContent;
      drafts.db.close();
      const dialog = previewDocument(new Blob(["%PDF-1.7\nfixture"], { type: "application/pdf" }));
      const link = dialog.querySelector("a");
      const viewer = { frames: dialog.querySelectorAll("iframe").length, target: link.target, blob: link.href.startsWith("blob:"), fallback: dialog.textContent.includes("שמור או שתף PDF") };
      dialog.close();
      return { preserved, closed, remaining, message, writes, amount: merged?.cashAgorot, viewer };
    });
    assert.equal(result.preserved.secret, "still-encrypted");
    assert.equal(result.closed, true);
    assert.equal(result.writes, 1);
    assert.equal(result.amount, 12300);
    assert.equal(result.remaining, null);
    assert.match(result.message, /נשמר בחנות/);
    assert.deepEqual(result.viewer, { frames: 0, target: "_blank", blob: true, fallback: true });
    assert.deepEqual(await page.evaluate(() => window.scannerCspViolations), []);
  });
}
