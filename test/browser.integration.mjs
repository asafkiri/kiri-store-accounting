// Runs in CI with native Chromium and WebKit, independently of Node's fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile as readTestFile } from "node:fs/promises";
import { chromium, webkit } from "playwright";
import { createBrowserCheckServer } from "../scripts/check-browser.mjs";
import { installScannerFixtures } from "./scanner-fixtures.mjs";
import { workspaceFixture } from "./workspace-fixture.mjs";

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
  let browser;
  // Close the browser before its HTTP server. A failed UI check can leave an
  // active connection, which otherwise hides the failure behind a stuck hook.
  t.after(async () => {
    try { await browser?.close(); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }, { timeout: 15000 });
  console.log(`Starting ${t.name}`);
  browser = await engine.launch();
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

async function assertWholeCropVisible(page) {
  // Let layout and ResizeObserver settle after image/status/viewport changes.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const layout = await page.evaluate(() => {
    const area = document.querySelector(".crop-source-area"), img = document.querySelector("[data-crop-result]");
    const rect = el => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const style = getComputedStyle(area);
    return {
      area: rect(area), image: rect(img), ratio: img.naturalWidth / img.naturalHeight,
      available: [area.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), area.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)],
      scroll: [area.scrollWidth - area.clientWidth, area.scrollHeight - area.clientHeight, area.scrollLeft, area.scrollTop],
      handles: [...document.querySelectorAll("[data-crop-corner]")].filter(handle => handle.offsetParent !== null).map(handle => {
        const r = rect(handle), hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
        return { ...r, reachable: handle.contains(hit) };
      }),
      actions: [...document.querySelectorAll(".crop-actions button")].map(rect),
      screen: { left: 0, top: 0, right: innerWidth, bottom: innerHeight },
    };
  });
  const inside = (r, container) => r.left >= container.left - 1 && r.top >= container.top - 1 && r.right <= container.right + 1 && r.bottom <= container.bottom + 1;
  assert.ok(inside(layout.image, layout.area) && inside(layout.area, layout.screen), `the entire image must fit: ${JSON.stringify(layout)}`);
  assert.ok(layout.scroll.every(value => Math.abs(value) <= 1), `no hidden or scrolled document edges: ${JSON.stringify(layout.scroll)}`);
  assert.ok(Math.abs(layout.image.width / layout.image.height / layout.ratio - 1) < .005, "screen fitting preserves image proportions");
  assert.ok(Math.abs(layout.image.width - layout.available[0]) <= 1 || Math.abs(layout.image.height - layout.available[1]) <= 1, "use the largest size that shows the whole page");
  for (const handle of layout.handles) {
    assert.ok(inside(handle, layout.area) && handle.reachable, `all four full corner targets must stay reachable: ${JSON.stringify(layout)}`);
    assert.ok(handle.width >= 48 && handle.height >= 48, "keep large touch targets");
  }
  assert.ok(layout.actions.every(r => inside(r, layout.screen)), "approval actions remain on screen");
}
// The result screen has three action buttons; the manual tools open behind "fix by hand".
async function openManualTools(page) {
  await page.waitForFunction(() => !document.querySelector("[data-crop-adjust]").disabled);
  await page.locator("[data-crop-adjust]").press("Enter");
  await page.waitForFunction(() => document.querySelector(".scan-crop").classList.contains("adjusting") && !document.querySelector("[data-crop-toolbar], .crop-toolbar").hidden);
}

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: scanner geometry, perspective/20-degree/long fixtures and thin text preservation`, async t => {
    const page = await scannerPage(t, engine);
    const result = await page.evaluate(async () => {
      const { orderCorners, homography, projectPoint, detectCorners, warpImage, enhanceImage, fullCorners, mapCropCorners } = await import("/scan-worker.js");
      const expected = [{ x: 20, y: 30 }, { x: 450, y: 80 }, { x: 400, y: 700 }, { x: 10, y: 640 }];
      const ordered = orderCorners([expected[2], expected[0], expected[3], expected[1]]);
      const known = [.9, .12, 20, .03, 1.1, 18, .0002, .0003, 1];
      const base = [{ x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 1000, y: 850 }, { x: 0, y: 850 }];
      const transform = homography(base, base.map(p => projectPoint(known, p)));
      const initialCrop = expected.map(p => ({ x: p.x / 500, y: p.y / 750 }));
      const inset = [{ x: .07, y: .06 }, { x: .95, y: .03 }, { x: .96, y: .97 }, { x: .02, y: .94 }];
      const firstCrop = mapCropCorners(inset, initialCrop), secondCrop = mapCropCorners(inset, firstCrop);
      const initialTransform = homography(fullCorners(), initialCrop), insetTransform = homography(fullCorners(), inset);
      const cropErrors = secondCrop.map((p, i) => {
        const expected = projectPoint(initialTransform, projectPoint(insetTransform, inset[i]));
        return Math.hypot(p.x - expected.x, p.y - expected.y) * 4000;
      });
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
      return { expected, ordered, predictionErrors, cropErrors, detections, rotation: [warped.width, warped.height, darkRowMax - darkRowMin], thin: { before, text, paper }, small: [small.width, small.height] };
    });
    assert.deepEqual(result.ordered, result.expected);
    assert.ok(result.predictionErrors.every(e => e < .5), JSON.stringify(result.predictionErrors));
    assert.ok(result.cropErrors.every(e => e < .5), "repeated preview crops must compose back to the original within half a source pixel");
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

  test(`${engine.name()}: repeated crops of a perspective photo preserve the proportions of printed shapes`, async t => {
    const page = await scannerPage(t, engine);
    const result = await page.evaluate(async () => {
      const { homography, projectPoint, fullCorners, imageFrame, perspectiveFrame, cropFrame, warpImage } = await import("/scan-worker.js");
      const source = new ImageData(900, 1000);
      const corners = [{ x: .1, y: .06 }, { x: .91, y: .27 }, { x: .67, y: .94 }, { x: .22, y: .86 }];
      const toPaper = homography(corners.map(p => ({ x: p.x * 899, y: p.y * 999 })), fullCorners());
      // Render a known printed shape THROUGH a projective camera transform,
      // rather than putting horizontal text inside a slanted outline.
      for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
        const p = projectPoint(toPaper, { x, y }), gray = Math.hypot(p.x - .5, p.y - .5) < .12 ? 50 : 230;
        source.data.set([gray, gray, gray, 255], (y * source.width + x) * 4);
      }
      const measurements = [], canvases = [];
      let frame = perspectiveFrame(corners, imageFrame(source));
      for (let step = 0; step < 5; step++) {
        const image = warpImage(source, frame.corners, 2500, frame);
        let left = image.width, top = image.height, right = 0, bottom = 0;
        for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) if (image.data[(y * image.width + x) * 4] < 100) {
          left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
        }
        measurements.push({ width: right - left + 1, height: bottom - top + 1, output: [image.width, image.height] });
        if (step === 0 || step === 4) {
          const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
          canvas.getContext("2d").putImageData(image, 0, 0); canvas.style.cssText = "width:100%;height:auto"; canvases.push(canvas);
        }
        frame = cropFrame([{ x: .06, y: .035 }, { x: .96, y: .035 }, { x: .96, y: .97 }, { x: .06, y: .97 }], frame);
      }
      const comparison = document.createElement("div"); comparison.style.cssText = "display:grid;grid-template-columns:1fr 1fr;align-items:start;gap:24px";
      comparison.append(...canvases); document.body.replaceChildren(comparison);
      return measurements;
    });
    await mkdir("test-artifacts", { recursive: true });
    await page.setViewportSize({ width: 960, height: 850 });
    await page.screenshot({ path: `test-artifacts/crop-proportions-${engine.name()}.png`, fullPage: true });
    const ratio = result[0].width / result[0].height;
    for (const measurement of result.slice(1)) {
      assert.ok(Math.abs(measurement.width / measurement.height / ratio - 1) < .01, `printed proportions must survive repeated crops: ${JSON.stringify(result)}`);
      assert.ok(Math.abs(measurement.width - result[0].width) <= 2 && Math.abs(measurement.height - result[0].height) <= 2, "trimming must not rescale the remaining ink");
    }
  });

  test(`${engine.name()}: large dark and coloured logos do not introduce illumination halos`, async t => {
    const page = await scannerPage(t, engine);
    const result = await page.evaluate(async () => {
      const { enhanceImage } = await import("/scan-worker.js");
      const canvas = document.createElement("canvas"); canvas.width = 960; canvas.height = 720;
      const pen = canvas.getContext("2d"); pen.fillStyle = "rgb(232,220,205)"; pen.fillRect(0, 0, 960, 720);
      const blocks = [{ x: 130, y: 160, w: 300, h: 320, colour: "#204ca0" }, { x: 550, y: 160, w: 250, h: 320, colour: "#343434" }];
      for (const block of blocks) { pen.fillStyle = block.colour; pen.fillRect(block.x, block.y, block.w, block.h); }
      pen.putImageData(enhanceImage(pen.getImageData(0, 0, 960, 720)), 0, 0);
      const rgb = (x, y) => [...pen.getImageData(x, y, 1, 1).data.slice(0, 3)];
      const measurements = blocks.map(b => ({
        centre: rgb(b.x + b.w / 2, b.y + b.h / 2),
        inside: [rgb(b.x + 8, b.y + b.h / 2), rgb(b.x + b.w - 9, b.y + b.h / 2), rgb(b.x + b.w / 2, b.y + 8)],
        outside: [rgb(b.x - 8, b.y + b.h / 2), rgb(b.x + b.w + 8, b.y + b.h / 2)],
      }));
      canvas.style.width = "100%"; document.body.replaceChildren(canvas);
      return { measurements, paper: rgb(30, 30) };
    });
    await mkdir("test-artifacts", { recursive: true });
    await page.setViewportSize({ width: 960, height: 760 });
    await page.screenshot({ path: `test-artifacts/logo-illumination-${engine.name()}.png`, fullPage: true });
    for (const block of result.measurements) {
      for (const inside of block.inside) assert.ok(inside.every((v, c) => Math.abs(v - block.centre[c]) <= 2), `no inner glow: ${JSON.stringify(block)}`);
      for (const outside of block.outside) assert.ok(outside.every((v, c) => Math.abs(v - result.paper[c]) <= 2), `no paper halo: ${JSON.stringify(block)}`);
    }
    const blue = result.measurements[0].centre;
    assert.ok(blue[2] - blue[0] >= 40, "logo colour is preserved");
  });

  test(`${engine.name()}: shaded paper becomes neutral and faint single-pixel ink gains contrast without binarization`, async t => {
    const page = await scannerPage(t, engine);
    const result = await page.evaluate(async () => {
      const { enhanceImage } = await import("/scan-worker.js");
      const { canvas, samples } = window.makeShadedPaper(), pen = canvas.getContext("2d");
      const before = pen.getImageData(0, 0, canvas.width, canvas.height);
      const start = performance.now();
      const after = enhanceImage(new ImageData(new Uint8ClampedArray(before.data), before.width, before.height));
      const elapsed = performance.now() - start;
      const rgb = (image, x, y) => [...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];
      const gray = value => value.reduce((s, n) => s + n, 0) / 3;
      pen.putImageData(after, 0, 0);
      const measurements = samples.map(({ x, y, ratio }) => {
        const paper = rgb(after, x + 4, y), ink = rgb(after, x, y);
        return { ratio, paper, ink, before: gray(rgb(before, x + 4, y)) - gray(rgb(before, x, y)), after: gray(paper) - gray(ink) };
      });
      const tones = Array.from({ length: 48 }, (_, i) => Math.round(gray(rgb(after, 84 + i * 12, 960))));
      const original = document.createElement("canvas"); original.width = canvas.width; original.height = canvas.height;
      original.getContext("2d").putImageData(before, 0, 0);
      const comparison = document.createElement("div"); comparison.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:24px;direction:rtl;font:22px sans-serif";
      for (const [label, image] of [["לפני השיפור", original], ["אחרי השיפור", canvas]]) {
        const figure = document.createElement("figure"), caption = document.createElement("figcaption");
        figure.style.margin = "0"; caption.textContent = label; image.style.width = "100%";
        figure.append(caption, image); comparison.append(figure);
      }
      document.body.replaceChildren(comparison);
      return { measurements, tones, colour: rgb(after, 765, 990), elapsed };
    });
    await mkdir("test-artifacts", { recursive: true });
    await page.setViewportSize({ width: 960, height: 760 });
    await page.screenshot({ path: `test-artifacts/paper-enhancement-${engine.name()}.png`, fullPage: true });
    for (const sample of result.measurements) {
      assert.ok(Math.min(...sample.paper) >= 235, `paper should be light: ${JSON.stringify(sample)}`);
      assert.ok(Math.max(...sample.paper) - Math.min(...sample.paper) <= 5, `neutral paper: ${JSON.stringify(sample)}`);
      assert.ok(sample.after >= sample.before * 1.6, `faint ink must gain contrast: ${JSON.stringify(sample)}`);
      assert.ok(Math.min(...sample.ink) > 0 && Math.max(...sample.ink) < 250, `gray strokes survive: ${JSON.stringify(sample)}`);
    }
    assert.ok(new Set(result.tones).size >= 40, "preserve many gray tones instead of thresholding/posterizing");
    assert.ok(result.colour[2] - result.colour[0] >= 40, "coloured marks must retain their colour");
    console.log(`${engine.name()}: shaded-paper correction ${Math.round(result.elapsed)}ms on the test machine; faint-stroke contrast preserved`);
  });

  test(`${engine.name()}: blue paper, deep shadows and underexposure preserve faint strokes and decimal points`, async t => {
    const page = await scannerPage(t, engine);
    const results = await page.evaluate(async () => {
      const { enhanceImage } = await import("/scan-worker.js");
      const results = [], comparison = document.createElement("div");
      comparison.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:16px";
      for (const kind of ["blue", "deep", "dim"]) {
        const { canvas, samples } = window.makeDifficultPaper(kind), pen = canvas.getContext("2d");
        const before = pen.getImageData(0, 0, canvas.width, canvas.height);
        const start = performance.now();
        const after = enhanceImage(new ImageData(new Uint8ClampedArray(before.data), before.width, before.height));
        const elapsed = performance.now() - start;
        const rgb = (image, x, y) => [...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];
        const gray = values => values.reduce((a, b) => a + b, 0) / 3;
        const measurements = samples.map(({ x, y, ratio }) => {
          const paper = rgb(after, x + 4, y), ink = rgb(after, x, y), dot = rgb(after, x + 6, y + 4);
          return { ratio, paper, ink, dot, before: gray(rgb(before, x + 4, y)) - gray(rgb(before, x, y)), after: gray(paper) - gray(ink), dotContrast: gray(rgb(after, x + 6, y + 7)) - gray(dot) };
        });
        const original = document.createElement("canvas"); original.width = canvas.width; original.height = canvas.height;
        original.getContext("2d").putImageData(before, 0, 0); pen.putImageData(after, 0, 0);
        for (const image of [original, canvas]) { image.style.width = "100%"; comparison.append(image); }
        const boundary = [];
        if (kind !== "dim") for (const y of [660, 680, 690, 695, 705, 710, 720]) for (const x of [20, 380, 920]) boundary.push(rgb(after, x, y));
        results.push({ kind, measurements, boundary, elapsed });
      }
      const black = new ImageData(160, 160); black.data.fill(5);
      const untouched = new Uint8ClampedArray(black.data); enhanceImage(black);
      results.push({ kind: "no-light", unchanged: black.data.every((value, i) => value === untouched[i]) });
      document.body.replaceChildren(comparison); return results;
    });
    for (const result of results) {
      if (result.kind === "no-light") { assert.equal(result.unchanged, true); continue; }
      for (const sample of result.measurements) {
        const label = `${result.kind}: ${JSON.stringify(sample)}`;
        assert.ok(Math.min(...sample.paper) >= 235, `paper should become light: ${label}`);
        assert.ok(Math.max(...sample.paper) - Math.min(...sample.paper) <= 5, `remove paper cast: ${label}`);
        assert.ok(sample.after >= sample.before * 1.6 && sample.after >= 2, `preserve faint strokes: ${label}`);
        assert.ok(sample.dotContrast >= 2, `preserve decimal points: ${label}`);
      }
      assert.ok(result.boundary.every(rgb => Math.min(...rgb) >= 230), `no broad dark band at a shadow boundary: ${JSON.stringify(result.boundary)}`);
      console.log(`${engine.name()}: ${result.kind} paper correction ${Math.round(result.elapsed)}ms on the CI machine`);
    }
    await mkdir("test-artifacts", { recursive: true });
    await page.setViewportSize({ width: 1000, height: 1000 });
    await page.screenshot({ path: `test-artifacts/difficult-paper-${engine.name()}.png`, fullPage: true });
  });

  test(`${engine.name()}: logo edges stay uniform at every illumination-grid offset`, async t => {
    const page = await scannerPage(t, engine);
    const results = await page.evaluate(async () => {
      const { enhanceImage } = await import("/scan-worker.js");
      const results = [], canvas = document.createElement("canvas"); canvas.width = canvas.height = 384;
      const pen = canvas.getContext("2d");
      for (const colour of ["#000000", "#343434", "#606060", "#808080", "#204ca0"]) for (let shift = 0; shift < 16; shift++) {
        pen.fillStyle = "rgb(232,220,205)"; pen.fillRect(0, 0, 384, 384);
        const left = 74 + shift, top = 94 + shift, width = 111, height = 155;
        pen.fillStyle = colour; pen.fillRect(left, top, width, height);
        const image = enhanceImage(pen.getImageData(0, 0, 384, 384));
        const rgb = (x, y) => [...image.data.slice((y * 384 + x) * 4, (y * 384 + x) * 4 + 3)];
        const centre = rgb(left + 50, top + 70), paper = rgb(20, 20);
        let inner = 0, outer = 0;
        for (let y = top - 20; y < top + height + 20; y++) for (let x = left - 20; x < left + width + 20; x++) {
          const inside = x >= left + 2 && x < left + width - 2 && y >= top + 2 && y < top + height - 2;
          // Exclude only the immediate one-pixel unsharp-mask edge, not the
          // surrounding band where a bad illumination field produces halos.
          const outside = x < left - 1 || x > left + width || y < top - 1 || y > top + height;
          const reference = inside ? centre : paper;
          if (!inside && !outside) continue;
          const difference = Math.max(...rgb(x, y).map((v, c) => Math.abs(v - reference[c])));
          if (inside) inner = Math.max(inner, difference); else outer = Math.max(outer, difference);
        }
        results.push({ colour, shift, inner, outer, centre });
      }
      return results;
    });
    for (const result of results) {
      assert.ok(result.inner <= 2 && result.outer <= 2, `no grid-dependent halo: ${JSON.stringify(result)}`);
      assert.ok(Math.max(...result.centre) < 210, `solid ink must not become paper: ${JSON.stringify(result)}`);
      if (result.colour === "#204ca0") assert.ok(result.centre[2] - result.centre[0] >= 40);
    }
  });

  test(`${engine.name()}: missed automatic boundaries can be aligned manually before a single perspective render`, { timeout: 60000 }, async t => {
    const page = await scannerPage(t, engine);
    await page.evaluate(async () => {
      window.cropMessages = []; const NativeWorker = window.Worker;
      window.cropBlobs = new Map(); const createObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = object => { const url = createObjectURL(object); window.cropBlobs.set(url, object); return url; };
      window.Worker = class extends NativeWorker {
        postMessage(message, ...args) { window.cropMessages.push(structuredClone(message)); super.postMessage(message, ...args); }
      };
      await window.openScanner();
      const { file, corners } = await window.makePhoto("manual", 1600); window.manualCorners = corners;
      const transfer = new DataTransfer(); transfer.items.add(file);
      const input = document.querySelector("#camera-file"); input.files = transfer.files; window.pendingPhotoSelection = input.onchange();
    });
    await page.waitForFunction(() => !document.querySelector("[data-crop-accept]").disabled);
    assert.match(await page.locator("[data-crop-status]").textContent(), /לא נמצאו גבולות ברורים/);
    const initialUrl = await page.locator("[data-crop-result]").getAttribute("src");
    const initialBytes = await page.evaluate(async () => [...new Uint8Array(await window.cropBlobs.get(document.querySelector("[data-crop-result]").src).arrayBuffer())]);
    await openManualTools(page);
    await page.locator("[data-crop-straighten]").press("Enter");
    await assertWholeCropVisible(page);
    const corners = await page.evaluate(() => window.manualCorners), box = await page.locator(".crop-source").boundingBox();
    const session = engine.name() === "chromium" ? await page.context().newCDPSession(page) : null;
    for (let index = 0; index < 4; index++) {
      const handle = await page.locator(`[data-crop-corner="${index}"]`).boundingBox();
      const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
      const to = { x: box.x + box.width * corners[index].x, y: box.y + box.height * corners[index].y };
      if (session) {
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
        await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [to] });
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      } else {
        await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y); await page.mouse.up();
      }
      assert.equal(await page.locator("[data-crop-result]").getAttribute("src"), initialUrl, "moving individual corners does not repeatedly stretch the preview");
    }
    const selected = await page.locator("[data-crop-corner]").evaluateAll(handles => handles.map(h => ({ x: parseFloat(h.style.left) / 100, y: parseFloat(h.style.top) / 100 })));
    for (let i = 0; i < 4; i++) assert.ok(Math.hypot(selected[i].x - corners[i].x, selected[i].y - corners[i].y) < .01, "four independent corners follow the paper");
    assert.equal(await page.evaluate(() => window.cropMessages.filter(m => ["preview", "straighten"].includes(m.type)).length), 0);
    await session?.detach();
    // Use the button's native keyboard activation after the four pointer drags.
    // Native camera/crop touch coverage remains in the existing integration test.
    await page.locator("[data-crop-accept]").press("Enter");
    await page.waitForFunction(url => document.querySelector("[data-crop-result]").src !== url && !document.querySelector("[data-crop-accept]").disabled, initialUrl);
    await assertWholeCropVisible(page);
    assert.equal(await page.locator("[data-crop-accept]").textContent(), "אשר", "show the result before saving it");
    assert.equal(await page.evaluate(() => window.cropMessages.filter(m => m.type === "straighten").length), 1);
    assert.equal(await page.evaluate(() => window.scanRequests.length), 0);
    await mkdir("test-artifacts", { recursive: true });
    await page.screenshot({ path: `test-artifacts/manual-perspective-${engine.name()}.png`, fullPage: true });
    const correctedUrl = await page.locator("[data-crop-result]").getAttribute("src");
    await page.locator("[data-crop-undo]").press("Enter");
    await page.waitForFunction(url => document.querySelector("[data-crop-result]").src !== url && !document.querySelector("[data-crop-accept]").disabled, correctedUrl);
    const restoredBytes = await page.evaluate(async () => [...new Uint8Array(await window.cropBlobs.get(document.querySelector("[data-crop-result]").src).arrayBuffer())]);
    assert.deepEqual(restoredBytes, initialBytes, "Back restores the exact image before manual straightening");
    await page.locator("[data-crop-straighten]").press("Enter");
    await page.locator('[data-crop-corner="0"]').press("Shift+ArrowRight");
    await page.locator("[data-crop-undo]").press("Enter");
    assert.equal(await page.locator("[data-crop-straighten]").getAttribute("aria-pressed"), "false", "Back also cancels unapplied alignment");
    assert.equal(await page.evaluate(() => window.cropMessages.filter(m => m.type === "straighten").length), 1);
    await page.locator("[data-crop-original]").press("Enter");
    await page.waitForFunction(() => !document.querySelector(".scan-crop"));
    assert.equal(await page.evaluate(() => window.scanDrafts()[0][1].files.length), 1);
    assert.deepEqual(await page.evaluate(() => window.scannerCspViolations), []);
  });

  test(`${engine.name()}: whole long receipt stays visible without scrolling after crops, Back and viewport changes`, { timeout: 60000 }, async t => {
    const page = await scannerPage(t, engine);
    await page.evaluate(async () => {
      window.cropMessages = [];
      window.cropBlobs = new Map();
      const createObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = object => {
        const url = createObjectURL(object);
        if (object instanceof Blob) window.cropBlobs.set(url, object);
        return url;
      };
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        postMessage(message, ...args) {
          window.cropMessages.push({ type: message.type, points: message.points, frame: message.frame });
          super.postMessage(message, ...args);
        }
      };
      await window.openScanner();
      const { file } = await window.makePhoto("long", 1500), transfer = new DataTransfer(); transfer.items.add(file);
      const input = document.querySelector("#camera-file"); input.files = transfer.files;
      window.pendingPhotoSelection = input.onchange();
    });
    await page.waitForFunction(() => !document.querySelector("[data-crop-accept]").disabled);
    const initial = await page.locator("[data-crop-result]").evaluate(img => ({ ratio: img.naturalWidth / img.naturalHeight, edge: Math.max(img.naturalWidth, img.naturalHeight) }));
    assert.ok(initial.ratio < .3, "exercise an unusually narrow, long page");
    assert.equal(initial.edge, 2500, "fitting the screen must not reduce the actual image resolution");
    await assertWholeCropVisible(page);
    await mkdir("test-artifacts", { recursive: true });
    await page.screenshot({ path: `test-artifacts/scanner-long-${engine.name()}.png`, fullPage: true });
    assert.equal(await page.locator("[data-crop-reset]").count(), 0, "Back replaces Reset");
    await openManualTools(page);
    await assertWholeCropVisible(page);
    const bytes = () => page.locator("[data-crop-result]").evaluate(async img => [...new Uint8Array(await window.cropBlobs.get(img.src).arrayBuffer())]);
    const initialBytes = await bytes();
    const crop = async key => {
      const before = await page.locator("[data-crop-result]").getAttribute("src");
      await page.locator('[data-crop-corner="0"]').press(key);
      await page.waitForFunction(before => document.querySelector("[data-crop-result]").src !== before && !document.querySelector("[data-crop-accept]").disabled, before);
      await assertWholeCropVisible(page);
    };
    const undo = async () => {
      const before = await page.locator("[data-crop-result]").getAttribute("src");
      await page.locator("[data-crop-undo]").tap();
      await page.waitForFunction(before => document.querySelector("[data-crop-result]").src !== before && !document.querySelector("[data-crop-accept]").disabled, before);
      await assertWholeCropVisible(page);
    };
    await crop("Shift+ArrowRight");
    const firstBytes = await bytes();
    await crop("Shift+ArrowDown");
    await page.screenshot({ path: `test-artifacts/scanner-long-cropped-${engine.name()}.png`, fullPage: true });
    const croppedUrl = await page.locator("[data-crop-result]").getAttribute("src");
    const requestsBeforeResize = await page.evaluate(() => window.cropMessages.length);
    for (const size of [{ width: 360, height: 640 }, { width: 740, height: 390 }, phoneOptions(engine).viewport]) {
      await page.setViewportSize(size);
      await assertWholeCropVisible(page);
      if (size.width > size.height) await page.screenshot({ path: `test-artifacts/scanner-landscape-${engine.name()}.png`, fullPage: true });
      assert.equal(await page.locator("[data-crop-result]").getAttribute("src"), croppedUrl, "rotation changes only the display, not the crop");
    }
    assert.equal(await page.evaluate(() => window.cropMessages.length), requestsBeforeResize, "screen resizing does not reprocess or degrade the photo");
    await undo(); assert.deepEqual(await bytes(), firstBytes, "one Back restores the preceding crop exactly");
    await undo(); assert.deepEqual(await bytes(), initialBytes, "another Back restores the initial straightened image exactly");
    await undo();
    const ratio = await page.locator("[data-crop-result]").evaluate(img => img.naturalWidth / img.naturalHeight);
    assert.ok(Math.abs(ratio - .5) < .001, "Back can recover edges missed by the automatic crop");
    assert.equal(await page.locator("[data-crop-undo]").isDisabled(), true, "history stops at the full enhanced photo");
    // Compare the actual JPEG displayed by the image element with the upload.
    await page.evaluate(async () => {
      const blob = window.cropBlobs.get(document.querySelector("[data-crop-result]").src);
      window.confirmedPreviewBytes = new Uint8Array(await blob.arrayBuffer());
    });
    await page.locator("[data-crop-accept]").tap();
    await page.waitForFunction(() => !document.querySelector(".scan-crop"));
    const saved = await page.evaluate(() => {
      const file = window.scanDrafts()[0][1].files[0], bytes = Uint8Array.from(atob(file.data), c => c.charCodeAt(0));
      return { identical: bytes.length === window.confirmedPreviewBytes.length && bytes.every((value, i) => value === window.confirmedPreviewBytes[i]), process: window.cropMessages.find(m => m.type === "process") };
    });
    assert.equal(saved.identical, true, "preview and upload must have identical JPEG bytes");
    assert.deepEqual(saved.process.frame.corners, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]);
    assert.equal(await page.locator(".crop-modal, .crop-modal-content").count(), 0, "normal scan layout is restored");
    assert.equal(await page.locator(".modal-heading").isVisible(), true);
    assert.equal(await page.evaluate(() => window.scanRequests.length), 0);
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
    assert.equal(await page.locator(".scan-crop img").count(), 1, "one processed image is the crop surface");
    assert.equal(await page.locator("[data-crop-source]").count(), 0, "the unprocessed original is not displayed");
    await assertWholeCropVisible(page);
    await openManualTools(page);
    await assertWholeCropVisible(page);
    const before = await page.locator("[data-crop-result]").getAttribute("src");
    const box = await handle.boundingBox(); assert.ok(box.width >= 48 && box.height >= 48);
    if (engine.name() === "chromium") {
      const session = await page.context().newCDPSession(page);
      const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x + 8, y: point.y + 8 }] });
      const edges = await page.locator("[data-crop-corner]").evaluateAll(handles => handles.map(h => [h.style.left, h.style.top]));
      assert.equal(edges[0][1], edges[1][1]); assert.equal(edges[0][0], edges[3][0]);
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await session.detach();
    } else {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 8, box.y + box.height / 2 + 8, { steps: 4 }); await page.mouse.up();
    }
    await page.waitForFunction(before => document.querySelector("[data-crop-result]").src !== before && !document.querySelector("[data-crop-accept]").disabled, before);
    await assertWholeCropVisible(page);
    assert.deepEqual(await page.locator("[data-crop-corner]").evaluateAll(handles => handles.map(h => [h.style.left, h.style.top])), [["0%", "0%"], ["100%", "0%"], ["100%", "100%"], ["0%", "100%"]], "handles follow the newly rectified image");
    assert.equal(await page.evaluate(() => window.scanRequests.length), 0);
    // A cancelled retake leaves the current selection intact.
    const adjusted = await page.locator("[data-crop-result]").getAttribute("src");
    await page.evaluate(() => document.querySelector("[data-crop-retake]").onchange());
    assert.equal(await page.locator("[data-crop-result]").getAttribute("src"), adjusted);
    await page.locator("[data-crop-accept]").tap();
    await page.waitForFunction(() => window.scanDrafts().find(([k]) => k === "scan")?.[1].files.length === 1);
    const photo = await page.evaluate(async () => {
      const file = window.scanDrafts().find(([k]) => k === "scan")[1].files[0];
      const blob = new Blob([Uint8Array.from(atob(file.data), c => c.charCodeAt(0))], { type: file.mime });
      const bitmap = await createImageBitmap(blob);
      const result = { keys: Object.keys(file).sort(), width: bitmap.width, height: bitmap.height, mime: file.mime, bytes: blob.size }; bitmap.close(); return result;
    });
    assert.deepEqual(photo.keys, ["data", "mime", "name"]);
    assert.equal(photo.mime, "image/jpeg");
    assert.ok(Math.max(photo.width, photo.height) >= 2000 && Math.max(photo.width, photo.height) <= 2500, "retain available resolution without enlarging a trimmed source");
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

  test(`${engine.name()}: approved photo survives manual entry and explicit invoice save without AI`, { timeout: 60000 }, async t => {
    const page = await scannerPage(t, engine);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.evaluate(() => window.openScanner());
    await page.evaluate(() => window.chooseScanPhoto());
    await page.waitForFunction(() => !document.querySelector("[data-crop-accept]").disabled);
    await page.locator("[data-crop-accept]").tap();
    await page.waitForFunction(() => !document.querySelector(".scan-crop") && !window.scanBusy);
    await page.locator("#manual-from-scan").tap();
    await page.waitForSelector("#invoice-form");
    assert.deepEqual(await page.evaluate(() => window.scanRequests.map(request => request.path)), ["documents"]);
    assert.ok(await page.evaluate(() => JSON.stringify(window.scanRequests[0].body.files) === JSON.stringify(window.scanDrafts().find(([key]) => key === "scan")[1].files)));
    assert.equal(await page.locator("[data-open-document]").count(), 1);
    assert.equal(await page.locator("[name=review]").isChecked(), false);
    assert.equal(await page.evaluate(() => window.invoiceSaves.length), 0);
    await page.locator("[name=supplierName]").fill("אסם");
    await page.locator("[name=documentNumber]").fill("MANUAL-PHOTO-1");
    await page.locator("[name=total]").fill("10");
    await page.locator("[name=final]").fill("10");
    await page.locator("[name=review]").check();
    await page.locator("#invoice-form button[type=submit]").tap();
    await page.waitForFunction(() => window.invoiceSaves.length === 1);
    const saved = await page.evaluate(() => window.invoiceSaves[0].body.data);
    assert.deepEqual(saved.attachmentIds, ["attachment-0"]);
    assert.equal(saved.source, "manual");
    assert.equal(saved.scanJobId, null);
    assert.equal(saved.reviewConfirmed, true);
    assert.deepEqual(await page.evaluate(() => window.scanRequests.map(request => request.path)), ["documents"]);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.scannerCspViolations), []);
  });

  test(`${engine.name()}: missing boundaries, a stuck save and a failed worker keep one-tap approval usable`, { timeout: 60000 }, async t => {
    const page = await scannerPage(t, engine);
    await page.evaluate(() => window.openScanner());
    await page.evaluate(() => window.chooseScanPhoto("gallery-file", "none"));
    await page.waitForFunction(() => document.querySelector("[data-crop-status]").textContent.includes("לא נמצאו גבולות ברורים"));
    await assertWholeCropVisible(page);
    assert.equal(await page.locator("[data-crop-corner]").evaluateAll(handles => handles.filter(h => h.offsetParent !== null).length), 0, "no handles on the result screen");
    await openManualTools(page);
    assert.deepEqual(await page.locator("[data-crop-corner]").evaluateAll(handles => handles.map(h => [h.style.left, h.style.top])), [["0%", "0%"], ["100%", "0%"], ["100%", "100%"], ["0%", "100%"]]);
    await page.locator("[data-crop-original]").tap();
    await page.waitForFunction(() => !document.querySelector(".scan-crop"));
    const equal = await page.evaluate(async () => {
      const { readFile } = await import("/image-upload.js");
      return JSON.stringify(await readFile(window.selectedPhoto)) === JSON.stringify(window.scanDrafts()[0][1].files[0]);
    });
    assert.equal(equal, true, "without crop must match the existing full-photo preparation exactly");
    // A save that never completes can still be abandoned from the header.
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
    assert.equal(await page.locator("[data-crop-retake-button]").isEnabled(), true, "retake stays available while saving");
    await page.locator("[data-crop-cancel]").tap();
    await page.waitForFunction(() => !document.querySelector(".scan-crop"));
    assert.equal(await page.evaluate(() => window.scanDrafts()[0][1].files.length), 1, "cancelling a stuck save keeps no page");
    // Without a worker the photo is kept as it is with the same approve button.
    await page.evaluate(() => { window.Worker = class { constructor() { throw Error("Worker unavailable"); } }; });
    await page.evaluate(() => window.chooseScanPhoto());
    await page.waitForFunction(() => document.querySelector("[data-crop-status]").textContent.includes("העיבוד לא הצליח"));
    assert.equal(await page.locator("[data-crop-adjust]").isDisabled(), true, "manual tools need a processed image");
    assert.equal(await page.locator("[data-crop-accept]").isEnabled(), true);
    assert.equal(await page.locator("[data-crop-result]").evaluate(img => img.naturalWidth > 0 && !img.classList.contains("processing")), true, "the original photo stays on screen");
    await page.locator("[data-crop-accept]").tap();
    await page.waitForFunction(() => !document.querySelector(".scan-crop"));
    const kept = await page.evaluate(async () => {
      const { readFile } = await import("/image-upload.js");
      return JSON.stringify(await readFile(window.selectedPhoto)) === JSON.stringify(window.scanDrafts()[0][1].files[1]);
    });
    assert.equal(kept, true, "approving after a worker failure stores the full photo");
    assert.equal(await page.evaluate(() => window.scanDrafts()[0][1].files.length), 2);
    assert.equal(await page.evaluate(() => window.scanRequests.length), 0);
    assert.equal(await page.locator("#run-scan").isEnabled(), true);
  });

  test(`${engine.name()}: the result screen offers one approval tap, and manual tools open and close without changing the image`, { timeout: 60000 }, async t => {
    const page = await scannerPage(t, engine);
    await page.evaluate(() => {
      window.cropBlobs = new Map(); const createObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = object => { const url = createObjectURL(object); if (object instanceof Blob) window.cropBlobs.set(url, object); return url; };
    });
    await page.evaluate(() => window.openScanner());
    await page.evaluate(() => window.chooseScanPhoto());
    await page.waitForFunction(() => !document.querySelector("[data-crop-accept]").disabled);
    const visibleActions = () => page.locator(".crop-actions button").evaluateAll(buttons => buttons.filter(b => b.offsetParent !== null).map(b => b.textContent.trim()));
    assert.deepEqual(await visibleActions(), ["אשר", "צלם שוב", "תקן ידנית"], "exactly three action buttons");
    assert.equal(await page.locator(".crop-heading [data-crop-cancel]").isVisible(), true, "cancel stays in the header");
    assert.equal(await page.locator(".crop-toolbar").isVisible(), false);
    assert.match(await page.locator("[data-crop-status]").textContent(), /בדוק שכל התעודה נראית/);
    await mkdir("test-artifacts", { recursive: true });
    await page.screenshot({ path: `test-artifacts/result-screen-${engine.name()}.png`, fullPage: true });
    const shownBytes = () => page.locator("[data-crop-result]").evaluate(async img => [...new Uint8Array(await window.cropBlobs.get(img.src).arrayBuffer())]);
    const shown = await page.locator("[data-crop-result]").getAttribute("src"), before = await shownBytes();
    await openManualTools(page);
    assert.deepEqual(await visibleActions(), ["אשר", "צלם שוב", "ללא חיתוך"]);
    assert.equal(await page.locator(".crop-toolbar").isVisible(), true);
    assert.equal(await page.locator("[data-crop-corner]").evaluateAll(handles => handles.filter(h => h.offsetParent !== null).length), 4);
    await assertWholeCropVisible(page);
    // Trim, then leave the manual screen: the image shown before is restored.
    await page.locator('[data-crop-corner="0"]').press("Shift+ArrowRight");
    await page.waitForFunction(shown => document.querySelector("[data-crop-result]").src !== shown && !document.querySelector("[data-crop-accept]").disabled, shown);
    await page.locator("[data-crop-cancel]").tap();
    await page.waitForFunction(() => !document.querySelector(".scan-crop").classList.contains("adjusting") && !document.querySelector("[data-crop-accept]").disabled);
    assert.deepEqual(await visibleActions(), ["אשר", "צלם שוב", "תקן ידנית"]);
    assert.deepEqual(await shownBytes(), before, "leaving the manual screen restores the image shown before it");
    // Cancel from the result screen leaves without storing a page.
    await page.locator("[data-crop-cancel]").tap();
    await page.waitForFunction(() => !document.querySelector(".scan-crop") && !window.scanBusy);
    assert.equal(await page.evaluate(() => window.scanDrafts().length), 0);
    await page.evaluate(() => window.chooseScanPhoto("gallery-file", "none"));
    await page.waitForFunction(() => document.querySelector("[data-crop-status]").textContent.includes("לא נמצאו גבולות ברורים"));
    await page.screenshot({ path: `test-artifacts/result-screen-undetected-${engine.name()}.png`, fullPage: true });
    await page.locator("[data-crop-accept]").tap();
    await page.waitForFunction(() => !document.querySelector(".scan-crop"));
    assert.equal(await page.evaluate(() => window.scanDrafts()[0][1].files.length), 1, "one tap stores the page");
    assert.equal(await page.evaluate(() => window.scanRequests.length), 0);
    assert.deepEqual(await page.evaluate(() => window.scannerCspViolations), []);
  });

  test(`${engine.name()}: 24MP EXIF capture and canvas fallback cap retained source at 3000px and strip metadata`, { timeout: 60000 }, async t => {
    for (const fallback of [false, true]) {
      const page = await scannerPage(t, engine);
      await page.evaluate(() => window.openScanner());
      await page.evaluate(async fallback => {
        if (fallback) window.SCAN_WORKER_URL = "/scan-worker-no-offscreen.js";
        window.sourceFrames = []; window.transferredSizes = [];
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
          constructor(...args) {
            super(...args);
            this.addEventListener("message", ({ data }) => { if (data.result?.originalFrame) window.sourceFrames.push(data.result.originalFrame); });
          }
          postMessage(message, ...args) {
            if (message.image) window.transferredSizes.push([message.image.width, message.image.height]);
            super.postMessage(message, ...args);
          }
        };
        const canvas = document.createElement("canvas"); canvas.width = 6000; canvas.height = 4000;
        const pen = canvas.getContext("2d"); pen.fillStyle = "white"; pen.fillRect(0, 0, canvas.width, canvas.height);
        pen.fillStyle = "#222"; pen.fillRect(100, 100, 200, 200);
        const jpeg = new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", .94))).arrayBuffer());
        // A minimal EXIF APP1 segment: orientation 6 (90 degrees clockwise).
        const exif = new Uint8Array([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0]);
        const photo = new File([jpeg.slice(0, 2), exif, jpeg.slice(2)], "rotated.jpg", { type: "image/jpeg" });
        canvas.width = canvas.height = 1;
        const transfer = new DataTransfer(); transfer.items.add(photo);
        const input = document.querySelector("#camera-file"); input.files = transfer.files;
        window.pendingPhotoSelection = input.onchange();
      }, fallback);
      await page.waitForFunction(() => !document.querySelector("[data-crop-accept]").disabled);
      await page.waitForFunction(() => !document.querySelector("[data-crop-zoom]").disabled);
      const preview = await page.locator("[data-crop-result]").evaluate(img => [img.naturalWidth, img.naturalHeight]);
      assert.ok(preview[1] > preview[0], "EXIF is applied before positioning corners");
      assert.deepEqual(await page.evaluate(() => window.sourceFrames.map(f => [f.width, f.height])), [[2000, 3000]], "retained oriented RGBA is 24MB instead of 96MB");
      if (fallback) assert.deepEqual(await page.evaluate(() => window.transferredSizes), [[2000, 3000]], "fallback scales before transferring pixels to the worker");
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

  // Seeded procedural photographs (test/scanner-fixtures.mjs), each drawn at
  // 1000px and detected both as a 320px live frame (canvas downscale, as the
  // camera view does) and through the still path (box downscale and refinement
  // at 1000px). Tolerances are percent of the long edge; "inward" is how far a
  // found corner sits inside the true page, where print would be cut off.
  test(`${engine.name()}: procedural fixtures are found within tolerance at 320px and in the still path, negatives stay null`, { timeout: 180000 }, async t => {
    const page = await scannerPage(t, engine);
    const result = await page.evaluate(async () => {
      const { detectDocument, DETECT_EDGE } = await import("/scan-worker.js");
      const positives = ["beige-texture", "dark-counter", "wood-grain", "white-table-soft-shadow", "cut-off", "long-1-5", "a4-angle", "shadow-across", "crumpled", "perspective", "rotated", "long"];
      const frame = (canvas, maxEdge) => {
        const scale = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
        if (scale === 1) return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
        const small = document.createElement("canvas"); small.width = Math.round(canvas.width * scale); small.height = Math.round(canvas.height * scale);
        const pen = small.getContext("2d", { willReadFrequently: true }); pen.drawImage(canvas, 0, 0, small.width, small.height);
        return pen.getImageData(0, 0, small.width, small.height);
      };
      const rows = [];
      for (const mode of positives) {
        const made = window.makeDocumentCanvas(mode, 1000, .85, 1), truth = made.expected || made.corners;
        for (const [path, image] of [["live", frame(made.canvas, DETECT_EDGE)], ["still", frame(made.canvas, 1000)]]) {
          const found = detectDocument(image), deviation = found.corners ? window.cornerDeviation(found.corners, truth, image.width, image.height) : null;
          rows.push({ mode, path, confidence: found.confidence, reason: found.reason, borderSides: found.borderSides,
            max: deviation && +deviation.max.toFixed(2), inward: deviation && +deviation.maxInward.toFixed(2) });
        }
      }
      const negatives = [];
      for (const mode of ["none", "circle", "texture-only"]) {
        const made = window.makeDocumentCanvas(mode, 1000, .85, 1);
        for (const [path, image] of [["live", frame(made.canvas, DETECT_EDGE)], ["still", frame(made.canvas, 1000)]]) {
          const found = detectDocument(image);
          negatives.push({ mode, path, corners: found.corners, confidence: found.confidence, reason: found.reason });
        }
      }
      let textureFalsePositives = 0;
      for (let seed = 1; seed <= 100; seed++) {
        if (detectDocument(frame(window.makeDocumentCanvas("texture-only", 1000, .85, seed).canvas, DETECT_EDGE)).corners) textureFalsePositives++;
      }
      return { rows, negatives, textureFalsePositives };
    });
    for (const row of result.rows) {
      const label = `${row.mode}/${row.path}: ${JSON.stringify(row)}`;
      assert.ok(row.max !== null, `document must be found: ${label}`);
      assert.ok(row.max <= (row.mode === "crumpled" ? 2.5 : 1.5), `corner within tolerance: ${label}`);
      assert.ok(row.inward <= .5, `no print cut off: ${label}`);
      assert.ok(row.confidence >= .6, `confidence reaches the auto-capture lock: ${label}`);
      assert.equal(row.borderSides, row.mode === "cut-off" ? 1 : 0, `frame borders used only where the page leaves the frame: ${label}`);
    }
    for (const row of result.negatives) {
      assert.equal(row.corners, null, `no document: ${JSON.stringify(row)}`);
      assert.equal(row.confidence, 0, JSON.stringify(row));
      assert.ok(["no-lines", "fills-frame", "no-supported-quad"].includes(row.reason), JSON.stringify(row));
    }
    assert.ok(result.textureFalsePositives <= 1, `texture-only false positives over 100 seeds: ${result.textureFalsePositives}`);
    t.diagnostic(`${engine.name()} texture-only false positives /100: ${result.textureFalsePositives}`);
  });

  // Timing is printed for every run; the guards are wide so a busy shared runner
  // cannot fail CI, while a large regression still does.
  test(`${engine.name()}: detection time at 320px and in the still path stays within the guards`, { timeout: 120000 }, async t => {
    const page = await scannerPage(t, engine);
    const measure = () => page.evaluate(async () => {
      const { detectDocument, DETECT_EDGE } = await import("/scan-worker.js");
      const { canvas } = window.makeDocumentCanvas("beige-texture", 1000, .85, 1);
      const small = document.createElement("canvas"); small.width = Math.round(canvas.width * DETECT_EDGE / canvas.height); small.height = DETECT_EDGE;
      small.getContext("2d").drawImage(canvas, 0, 0, small.width, small.height);
      const live = small.getContext("2d").getImageData(0, 0, small.width, small.height), still = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
      const time = (image, runs) => {
        const samples = [];
        for (let k = 0; k < runs; k++) { const t0 = performance.now(); detectDocument(image); samples.push(performance.now() - t0); }
        samples.sort((a, b) => a - b);
        return { median: +samples[samples.length >> 1].toFixed(1), p95: +samples[Math.min(samples.length - 1, Math.floor(samples.length * .95))].toFixed(1) };
      };
      detectDocument(live);
      return { live: time(live, 20), still: time(still, 10) };
    });
    const timing = await measure();
    t.diagnostic(`${engine.name()} detect 320px median ${timing.live.median}ms p95 ${timing.live.p95}ms; still path (1000px) median ${timing.still.median}ms p95 ${timing.still.p95}ms`);
    assert.ok(timing.live.median <= 60, `320px detection median ${timing.live.median}ms`);
    assert.ok(timing.still.median <= 300, `still path median ${timing.still.median}ms`);
    if (engine.name() === "chromium") {
      // A 4x CPU slowdown approximates a mid-range phone; printed, not asserted.
      const session = await page.context().newCDPSession(page);
      await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      const throttled = await measure();
      await session.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      t.diagnostic(`chromium 4x CPU throttle: detect 320px median ${throttled.live.median}ms p95 ${throttled.live.p95}ms`);
    }
  });

  // The in-app camera is exercised with a fake getUserMedia backed by
  // canvas.captureStream: a page slides across the frame, then holds still.
  const fakeCamera = () => {
    window.liveStreams = []; window.workerLog = []; window.workerCount = 0; window.cameraMode = "page";
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args); window.workerCount++;
        this.addEventListener("message", ({ data }) => {
          if (data.result && "hintUsed" in data.result) window.workerLog.push({ type: "init-result", hintUsed: data.result.hintUsed, detected: data.result.detected, blob: data.result.blob });
        });
      }
      postMessage(message, ...args) { window.workerLog.push({ type: message.type, hint: Boolean(message.hint) }); super.postMessage(message, ...args); }
    };
    const { canvas: paper } = window.makeDocumentCanvas("dark-counter", 1000, .85, 1);
    const scene = document.createElement("canvas"); scene.width = 1800; scene.height = 2400;
    const small = document.createElement("canvas"); small.width = 1280; small.height = 720;
    const pen = scene.getContext("2d"), smallPen = small.getContext("2d");
    // WebKit only captures frames from a canvas that is painted; keep both in the document, tiny and inert.
    for (const canvas of [scene, small]) { Object.assign(canvas.style, { position: "fixed", left: "0", top: "0", width: "18px", height: "24px", opacity: ".01", pointerEvents: "none" }); document.body.append(canvas); }
    window.sceneMoving = true; let step = 0;
    // Redraw continuously: a captured canvas only produces frames when it is drawn to.
    setInterval(() => {
      step++;
      const dx = window.sceneMoving ? [0, 60, 120, 180][step % 4] - 90 : 0;
      pen.fillStyle = "#282624"; pen.fillRect(0, 0, scene.width, scene.height);
      pen.drawImage(paper, dx, 0, scene.width, scene.height);
      smallPen.fillStyle = "#282624"; smallPen.fillRect(0, 0, small.width, small.height);
      smallPen.drawImage(paper, 300, -100, 700, 933);
    }, 66);
    if (!navigator.mediaDevices) Object.defineProperty(navigator, "mediaDevices", { value: {}, configurable: true });
    const fakeGetUserMedia = async constraints => {
      window.lastConstraints = constraints;
      if (window.cameraMode === "denied") throw new DOMException("Permission denied", "NotAllowedError");
      const stream = (window.cameraMode === "small" ? small : scene).captureStream(15);
      window.liveStreams.push(stream);
      return stream;
    };
    // A plain assignment is ignored by engines that expose getUserMedia as a prototype accessor.
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: fakeGetUserMedia, configurable: true, writable: true });
    return navigator.mediaDevices.getUserMedia === fakeGetUserMedia;
  };
  test(`${engine.name()}: the live camera shows the polygon, locks only when still, hands the frame with a hint to the review, and falls back cleanly`, { timeout: 180000 }, async t => {
    const page = await scannerPage(t, engine);
    const support = await page.evaluate(async () => {
      const { liveCameraSupported } = await import("/live-capture.js");
      return { supported: liveCameraSupported(), secureContext: window.isSecureContext, captureStream: typeof HTMLCanvasElement.prototype.captureStream === "function", videoFrameCallback: "requestVideoFrameCallback" in HTMLVideoElement.prototype };
    });
    t.diagnostic(`${engine.name()} live camera support: ${JSON.stringify(support)}`);
    if (!support.captureStream) { t.skip("canvas.captureStream is not available in this engine"); return; }
    if (!support.supported) { t.skip("the test page is not a secure context for this engine, so the in-app camera never opens"); return; }
    await page.evaluate(() => window.openScanner());
    const patched = await page.evaluate(fakeCamera);
    t.diagnostic(`${engine.name()} fake getUserMedia installed: ${patched}`);
    if (!patched && engine.name() === "webkit") { t.skip("getUserMedia cannot be replaced in this engine"); return; }
    assert.equal(patched, true, "the fake camera replaces getUserMedia");
    const cameraLabel = page.locator("label:has(#camera-file)");
    const detectCount = () => page.evaluate(() => window.workerLog.filter(entry => entry.type === "detect").length);
    const tracksEnded = () => page.evaluate(() => window.liveStreams.every(stream => stream.getTracks().every(track => track.readyState === "ended")));
    const videoState = () => page.evaluate(() => {
      const video = document.querySelector("[data-live-video]");
      return { status: document.querySelector("[data-live-status]")?.textContent, unavailable: document.querySelector("[data-live-unavailable]")?.hidden === false, paused: document.querySelector("[data-live-paused]")?.hidden === false,
        video: video && { width: video.videoWidth, height: video.videoHeight, readyState: video.readyState, paused: video.paused, hasStream: Boolean(video.srcObject) }, streams: window.liveStreams.length, tracks: window.liveStreams.map(s => s.getTracks().map(track => `${track.readyState}${track.muted ? "/muted" : ""}`)) };
    });
    // 1. Moving page: the polygon follows it, nothing is captured.
    await cameraLabel.tap();
    await page.waitForSelector(".scan-live");
    const started = await page.waitForFunction(() => document.querySelector("[data-live-video]")?.videoWidth === 1800, null, { timeout: 20000 }).then(() => true, () => false);
    if (!started) {
      const state = await videoState();
      t.diagnostic(`${engine.name()} fake camera did not start: ${JSON.stringify(state)}`);
      // Headless WebKit on Linux may not feed a canvas-captured stream into a video element; the
      // view's own logic is engine-neutral and is covered by Chromium, so do not fail CI on that.
      if (engine.name() === "webkit") { await page.locator("[data-live-cancel]").tap(); t.skip("canvas.captureStream did not produce video frames in this engine"); return; }
      assert.fail(`the in-app camera did not start: ${JSON.stringify(state)}`);
    }
    assert.deepEqual(await page.evaluate(() => [window.lastConstraints.video.facingMode.ideal, window.lastConstraints.video.width.ideal]), ["environment", 3840]);
    await page.waitForFunction(() => !document.querySelector("[data-live-polygon]").hasAttribute("hidden"));
    await page.waitForFunction(() => window.workerLog.filter(entry => entry.type === "detect").length >= 12);
    assert.equal(await page.locator(".scan-crop").count(), 0, "no capture while the page moves");
    const polygon = await page.evaluate(() => {
      const element = document.querySelector("[data-live-polygon]"), points = element.getAttribute("points").trim().split(/\s+/).map(pair => pair.split(",").map(Number));
      const area = Math.abs(points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
      return { hidden: element.hasAttribute("hidden"), display: getComputedStyle(element).display, points, area };
    });
    assert.ok(!polygon.hidden && polygon.display !== "none" && polygon.points.length === 4 && polygon.area > 2000 && polygon.points.every(p => p.every(v => v >= 0 && v <= 100)), `the polygon outlines the page: ${JSON.stringify(polygon)}`);
    assert.equal(await page.locator("[data-live-shutter]").isEnabled(), true);
    const layout = await page.evaluate(() => {
      const rect = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; };
      return { frame: rect(document.querySelector("[data-live-frame]")), shutter: rect(document.querySelector("[data-live-shutter]")), status: document.querySelector("[data-live-status]").textContent, viewport: [innerWidth, innerHeight] };
    });
    assert.ok(layout.frame[2] - layout.frame[0] > 100 && layout.frame[3] - layout.frame[1] > 100, `camera frame is laid out: ${JSON.stringify(layout)}`);
    assert.ok(layout.shutter[3] <= layout.viewport[1] && layout.shutter[1] >= layout.frame[3] - 1, `shutter below the frame and on screen: ${JSON.stringify(layout)}`);
    assert.ok(Math.abs((layout.frame[2] - layout.frame[0]) / (layout.frame[3] - layout.frame[1]) - .75) < .02, `frame keeps the 3:4 video proportions: ${JSON.stringify(layout)}`);
    await mkdir("test-artifacts", { recursive: true });
    await page.screenshot({ path: `test-artifacts/live-camera-${engine.name()}.png` });
    // 2. Still page: lock within a few detections, then the review opens with the hint.
    const before = await detectCount();
    await page.evaluate(() => { window.sceneMoving = false; });
    await page.waitForSelector(".scan-crop");
    assert.ok(await detectCount() - before <= 15, `locks within a few frames after the page holds still (${await detectCount() - before})`);
    assert.equal(await page.locator(".scan-live").count(), 0, "the live view closes when the review opens");
    await page.waitForFunction(() => !document.querySelector("[data-crop-accept]").disabled);
    const handover = await page.evaluate(() => ({ workers: window.workerCount, init: window.workerLog.find(entry => entry.type === "init"), result: window.workerLog.find(entry => entry.type === "init-result") }));
    assert.equal(handover.workers, 1, "the review reuses the live view's worker");
    assert.equal(handover.init?.hint, true, "the captured frame carries the detection hint");
    assert.deepEqual([handover.result?.hintUsed, handover.result?.detected], [true, true], JSON.stringify(handover));
    assert.equal(await tracksEnded(), true, "camera tracks stop once the frame is captured");
    assert.match(await page.locator("[data-crop-status]").textContent(), /בדוק שכל התעודה נראית/);
    // 3. Retake returns to the camera; cancelling it keeps no page.
    await page.locator("[data-crop-retake-button]").tap();
    await page.waitForSelector(".scan-live");
    await page.waitForFunction(() => document.querySelector("[data-live-video]")?.videoWidth === 1800);
    assert.equal(await page.locator(".scan-crop").count(), 0);
    await page.locator("[data-live-cancel]").tap();
    await page.waitForFunction(() => !document.querySelector(".scan-live") && !window.scanBusy);
    assert.equal(await tracksEnded(), true, "cancelling stops the camera");
    assert.equal(await page.evaluate(() => window.scanDrafts()[0]?.[1].files.length ?? 0), 0);
    // 4. Hiding the tab pauses the camera and stops its tracks; showing it resumes.
    await page.evaluate(() => { window.sceneMoving = true; });
    await cameraLabel.tap();
    await page.waitForFunction(() => document.querySelector("[data-live-video]")?.videoWidth === 1800);
    const streamsBefore = await page.evaluate(() => window.liveStreams.length);
    await page.evaluate(() => { Object.defineProperty(document, "hidden", { get: () => true, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    await page.waitForFunction(() => !document.querySelector("[data-live-paused]").hidden);
    assert.equal(await tracksEnded(), true, "a hidden tab releases the camera");
    await page.evaluate(() => { Object.defineProperty(document, "hidden", { get: () => false, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
    await page.waitForFunction(streams => window.liveStreams.length > streams && document.querySelector("[data-live-paused]").hidden && document.querySelector("[data-live-video]").videoWidth === 1800, streamsBefore);
    // 5. Approval saves the review's own result, byte for byte.
    await page.evaluate(() => { window.sceneMoving = false; });
    await page.waitForSelector(".scan-crop");
    await page.waitForFunction(() => !document.querySelector("[data-crop-accept]").disabled);
    await page.locator("[data-crop-accept]").tap();
    await page.waitForFunction(() => !document.querySelector(".scan-crop") && !window.scanBusy && window.scanDrafts()[0]?.[1].files.length === 1);
    assert.equal(await page.evaluate(async () => {
      const saved = window.scanDrafts()[0][1].files[0], blob = window.workerLog.filter(entry => entry.type === "init-result").at(-1).blob;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return saved.mime === "image/jpeg" && btoa(binary) === saved.data;
    }), true, "the saved page is the worker's own output");
    // 6. A stream below 1600px falls back to the phone camera and stays out of the way afterwards.
    await page.evaluate(() => { window.cameraMode = "small"; });
    await cameraLabel.tap();
    await page.waitForFunction(() => !document.querySelector("[data-live-unavailable]")?.hidden);
    assert.equal(await page.locator("[data-live-fallback]").count(), 1, "the overlay offers the phone camera");
    assert.equal(await tracksEnded(), true, "the small stream is released");
    await page.locator("[data-live-cancel]").tap();
    await page.waitForFunction(() => !document.querySelector(".scan-live") && !window.scanBusy);
    assert.match(await page.locator("#scan-status").textContent(), /מצלמת הטלפון/);
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), cameraLabel.tap()]);
    assert.ok(chooser, "after a failure the button opens the phone camera natively");
    assert.equal(await page.locator(".scan-live").count(), 0);
    assert.deepEqual(await page.evaluate(() => window.scannerCspViolations), []);
    await page.close();
    // 7. Fresh page: turning the phone to landscape keeps the frame, shutter and
    // cancel on screen; a denied permission gives the same fallback as above.
    const denied = await scannerPage(t, engine);
    await denied.evaluate(() => window.openScanner());
    await denied.evaluate(fakeCamera);
    await denied.locator("label:has(#camera-file)").tap();
    await denied.waitForFunction(() => document.querySelector("[data-live-video]")?.videoWidth === 1800);
    await denied.setViewportSize({ width: 844, height: 390 });
    const landscapeLayout = () => denied.evaluate(() => {
      const rect = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; };
      return { frame: rect(document.querySelector("[data-live-frame]")), shutter: rect(document.querySelector("[data-live-shutter]")), cancel: rect(document.querySelector("[data-live-cancel]")), viewport: [innerWidth, innerHeight] };
    });
    await denied.waitForFunction(() => innerWidth === 844 && document.querySelector("[data-live-frame]").getBoundingClientRect().height < 390);
    const landscape = await landscapeLayout();
    for (const [name, box] of Object.entries({ frame: landscape.frame, shutter: landscape.shutter, cancel: landscape.cancel }))
      assert.ok(box[0] >= 0 && box[1] >= 0 && box[2] <= landscape.viewport[0] && box[3] <= landscape.viewport[1] && box[2] > box[0] && box[3] > box[1], `${name} on screen in landscape: ${JSON.stringify(landscape)}`);
    assert.ok(Math.abs((landscape.frame[2] - landscape.frame[0]) / (landscape.frame[3] - landscape.frame[1]) - .75) < .03, `the portrait video keeps its proportions in landscape: ${JSON.stringify(landscape)}`);
    await denied.screenshot({ path: `test-artifacts/live-camera-landscape-${engine.name()}.png` });
    await denied.locator("[data-live-cancel]").tap();
    await denied.waitForFunction(() => !document.querySelector(".scan-live") && !window.scanBusy);
    await denied.setViewportSize(phoneOptions(engine).viewport);
    await denied.evaluate(() => { window.cameraMode = "denied"; });
    await denied.locator("label:has(#camera-file)").tap();
    await denied.waitForFunction(() => !document.querySelector("[data-live-unavailable]")?.hidden);
    await denied.locator("[data-live-cancel]").tap();
    await denied.waitForFunction(() => !document.querySelector(".scan-live") && !window.scanBusy);
    const [deniedChooser] = await Promise.all([denied.waitForEvent("filechooser"), denied.locator("label:has(#camera-file)").tap()]);
    assert.ok(deniedChooser, "a denied permission hands the button to the phone camera");
    assert.deepEqual(await denied.evaluate(() => window.scannerCspViolations), []);
  });
}

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: today's cash starts clean and a failed save can be cancelled, edited and discarded offline`, async (t) => {
    const server = createBrowserCheckServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let browser;
    t.after(async () => {
      try { await browser?.close(); }
      finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    }, { timeout: 15000 });
    browser = await engine.launch();
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
    let browser;
    t.after(async () => {
      try { await browser?.close(); }
      finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    }, { timeout: 15000 });
    browser = await engine.launch();
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
    await page.locator(".quick-other > summary").click();
    await page.locator('[data-quick-choice="vat-unknown"]').tap();
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
    await page.locator(".quick-other > summary").click();
    await page.locator('[data-quick-choice="vat-unknown"]').tap();
    await page.locator("[type=submit]").tap();
    await page.waitForFunction(() => window.supplierRequests.length === 2);
    await page.evaluate(() => window.openSupplierReview("ספק לא פעיל"));
    await page.locator("[data-supplier-action=reactivate]").tap();
    await page.locator(".quick-other > summary").click();
    await page.locator('[data-quick-choice="vat-unknown"]').tap();
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
    let browser;
    t.after(async () => {
      try { await browser?.close(); }
      finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    }, { timeout: 15000 });
    browser = await engine.launch();
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
      let browser;
      t.after(async () => {
        try { await browser?.close(); }
        finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
      }, { timeout: 15000 });
      browser = await engine.launch();
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
          while (!document.querySelector("[data-crop-adjust]") || document.querySelector("[data-crop-adjust]").disabled) {
            if (Date.now() > deadline) throw Error("Missing crop view");
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          document.querySelector("[data-crop-adjust]").click();
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

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: scan-first workspace, month/supplier photos, supplier deletion and date layout`, { timeout: 60000 }, async t => {
    const { server, requests, month, previous } = workspaceFixture();
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    let browser;
    t.after(async () => {
      try { await browser?.close(); }
      finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    });
    browser = await engine.launch();
    const page = await browser.newPage(phoneOptions(engine));
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator(".scan-primary").waitFor();
    assert.equal(await page.locator('nav [data-route="suppliers"]').count(), 0);
    const scan = await page.locator(".scan-primary").boundingBox();
    const manual = await page.locator('[data-action="invoice"]').boundingBox();
    assert.ok(scan.width > manual.width * 2 && scan.height > manual.height);
    assert.ok(scan.y < 200, "primary scanning is immediately available");
    const monthFolders = page.locator(".month-folder");
    assert.equal(await monthFolders.count(), 2);
    assert.equal(await monthFolders.first().getAttribute("data-folder"), "invoices:" + month);
    await mkdir("test-artifacts", { recursive: true });
    await page.screenshot({ path: `test-artifacts/workspace-${engine.name()}.png`, fullPage: true });
    await page.locator(".scan-primary").click();
    await page.locator(".scan-live").waitFor();
    assert.ok(await page.locator("[data-live-gallery]").count());
    assert.ok(await page.locator("[data-live-manual]").isVisible());
    await page.locator("[data-live-cancel]").click();
    await page.locator("[data-close-modal]").click();
    await page.locator('.sidebar [data-route="documents"]').click();
    const current = page.locator(`[data-folder="photos:${month}"]`);
    const supplier = current.locator(`[data-folder="photos:${month}:supplier-tnuva"]`);
    await supplier.locator(":scope > summary").click();
    assert.equal(await supplier.locator("[data-open-document]").count(), 2);
    const documentTitle = await supplier.locator(".document-card-heading > div > strong").boundingBox();
    const documentMeta = await supplier.locator(".document-card-heading .document-meta").boundingBox();
    assert.ok(documentMeta.y >= documentTitle.y + documentTitle.height - 1, "invoice number and date occupy separate readable lines");
    await supplier.locator("[data-open-document]").first().click();
    await page.locator(".preview-dialog img").waitFor();
    assert.equal(requests.filter(r => r.path.startsWith("/api/v1/documents/")).length, 1);
    assert.ok(await page.locator("[data-preview-download]").isVisible());
    await page.locator("[data-preview-close]").click();
    await page.screenshot({ path: `test-artifacts/photos-${engine.name()}.png`, fullPage: true });
    await page.locator('.sidebar [data-route="cash"]').click();
    assert.equal(await page.locator('[name="month"]').inputValue(), month);
    assert.equal(await page.locator('[name="from"]').count(), 0);
    await page.locator('[data-action="period-mode"]').click();
    const from = page.locator('[name="from"]'), to = page.locator('[name="to"]');
    assert.equal(await page.locator('[name="month"]').count(), 0);
    for (const width of [320, 360, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const a = await from.boundingBox(), b = await to.boundingBox();
      assert.ok(Math.abs(a.y - b.y) < 2, "from and to share one row");
      assert.ok(b.x + b.width <= a.x + 1, "date fields never overlap in RTL");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "no horizontal overflow");
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await from.fill(previous + "-01");
    await to.fill(previous + "-28");
    assert.equal(await page.locator(".cash-row").count(), 1);
    await page.screenshot({ path: `test-artifacts/cash-${engine.name()}.png`, fullPage: true });
    await page.locator('[data-action="period-mode"]').click();
    assert.equal(await page.locator('[name="month"]').inputValue(), previous);
    await page.locator('.sidebar [data-route="reports"]').click();
    assert.equal(await page.locator(".report-supplier-row").count(), 2);
    assert.match(await page.locator(".report-overview").innerText(), /1,714/);
    await page.screenshot({ path: `test-artifacts/summary-${engine.name()}.png`, fullPage: true });
    await page.locator('[data-action="report-supplier"][data-id="supplier-tnuva"]').click();
    assert.equal(await page.locator(".invoice-card").count(), 1);
    await page.locator('.sidebar [data-route="invoices"]').click();
    await page.locator('[data-action="manage-suppliers"]').click();
    await page.locator('[data-action="supplier-edit"][data-id="supplier-unused"]').click();
    await page.locator("[data-remove-supplier]").click();
    await page.locator('.delete-form [type="submit"]').click();
    await page.locator("#modal").waitFor({ state: "hidden" });
    assert.equal(await page.locator('[data-action="supplier-edit"][data-id="supplier-unused"]').count(), 0);
    await page.reload();
    await page.locator('[data-action="manage-suppliers"]').click();
    assert.equal(await page.locator('[data-action="supplier-edit"][data-id="supplier-unused"]').count(), 0);
    await page.locator('[data-action="supplier-edit"][data-id="supplier-tnuva"]').click();
    await page.locator("[data-remove-supplier]").click();
    assert.match(await page.locator(".delete-form").innerText(), /30 יום/);
    await page.locator('.delete-form [type="submit"]').click();
    await page.locator("#modal").waitFor({ state: "hidden" });
    await page.locator('[data-route="supplier-trash"]').click();
    assert.equal(await page.locator(".trash-card").count(), 2);
    await page.locator('[data-action="supplier-restore"][data-id="supplier-tnuva"]').click();
    await page.locator('.delete-form [type="submit"]').click();
    await page.locator("#modal").waitFor({ state: "hidden" });
    assert.equal(await page.locator(".trash-card").count(), 1);
    await page.screenshot({ path: `test-artifacts/trash-${engine.name()}.png`, fullPage: true });
    assert.equal(requests.filter(r => r.method === "DELETE").length, 2);
    assert.deepEqual(errors, []);
  });
}

for (const engine of [chromium, webkit]) {
  test(`${engine.name()}: direct camera, PDF intake, short questions, compact approval and real draft reminders`, { timeout: 60000 }, async t => {
    const { server, requests, data } = workspaceFixture();
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    let browser;
    t.after(async () => { try { await browser?.close(); } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
    browser = await engine.launch();
    const page = await browser.newPage(phoneOptions(engine));
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator(".scan-primary").waitFor();
    assert.equal(await page.locator(".draft-banner").count(), 0);
    assert.equal(await page.locator('main [data-route="documents"]').count(), 0);
    await page.locator('[data-action="invoice"]').click();
    await page.locator("#invoice-form").waitFor();
    await page.locator("[data-close-modal]").click();
    assert.equal(await page.locator(".draft-banner").count(), 0);
    await page.locator(".scan-primary").click();
    await page.locator(".scan-live").waitFor();
    assert.equal(await page.locator(".scan-view").isVisible(), false);
    await page.locator("[data-live-gallery]").setInputFiles({ name: "invoice.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n% synthetic fixture\n%%EOF") });
    await page.locator(".pdf-preview").waitFor();
    await page.locator("#run-scan").click();
    await page.locator('[data-quick-choice="invoice"]').click();
    await page.locator('[data-quick-choice="vat-rate"]').waitFor();
    assert.match(await page.locator('[data-quick-choice="vat-rate"]').innerText(), /18%/);
    await page.locator('[data-quick-choice="vat-rate"]').click();
    await page.locator(".quick-summary-grid").waitFor();
    assert.equal(await page.locator(".quick-question").count(), 0);
    for (const width of [360, 390]) {
      await page.setViewportSize({ width, height: 800 });
      const layout = await page.locator("#modal").evaluate(el => ({ height: el.clientHeight, content: el.scrollHeight, width: el.scrollWidth, clientWidth: el.clientWidth }));
      assert.ok(layout.content <= layout.height + 2, `summary fits without scrolling at ${width}: ${JSON.stringify(layout)}`);
      assert.ok(layout.width <= layout.clientWidth + 1, "no horizontal overflow");
    }
    await page.locator('[name="paymentReduction"]').fill("100");
    await page.locator('[name="notes"]').fill("חוסר שאושר עם הספק");
    await page.locator('[name="notes"]').blur();
    await mkdir("test-artifacts", { recursive: true });
    await page.screenshot({ path: `test-artifacts/quick-invoice-${engine.name()}.png`, fullPage: true });
    await page.locator("[data-close-modal]").click();
    await page.locator('.draft-banner[data-key="invoice"]').waitFor();
    assert.equal(await page.locator(".draft-banner").count(), 1);
    const color = await page.locator(".draft-banner").evaluate(el => getComputedStyle(el).color);
    assert.equal(color, "rgb(155, 32, 40)");
    await page.reload();
    await page.locator('.draft-banner[data-key="invoice"]').click();
    await page.locator(".quick-summary-grid").waitFor();
    assert.equal(await page.locator('[name="paymentReduction"]').inputValue(), "100");
    assert.equal(requests.filter(r => r.path === "/api/v1/scan-invoice").length, 1);
    await page.locator('.quick-invoice [type="submit"]').click();
    await page.locator("#modal").waitFor({ state: "hidden" });
    await page.waitForFunction(() => !document.querySelector(".draft-banner"));
    const saved = data.invoices.find(i => i.documentNumber === "SCAN-118");
    assert.equal(saved.finalAgorot, 1800); assert.equal(saved.vatAgorot, 1800); assert.equal(saved.totalAgorot, 11800);
    assert.equal(saved.attachmentIds.length, 1);
    await page.locator('.topbar [data-route="settings"]').click();
    await page.locator('[data-action="vat-preferences"]').click();
    await page.locator('[name="rate"]').fill("17");
    await page.locator('#modal [type="submit"]').click();
    await page.locator("#modal").waitFor({ state: "hidden" });
    await page.reload();
    await page.locator('.topbar [data-route="settings"]').click();
    assert.match(await page.locator("main").innerText(), /17%/);
    assert.deepEqual(errors, []);
  });
}
