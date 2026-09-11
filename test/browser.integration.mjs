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
      handles: [...document.querySelectorAll("[data-crop-corner]")].map(handle => {
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
        results.push({ kind, measurements, elapsed });
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
    assert.match(await page.locator("[data-crop-status]").textContent(), /לא זוהו גבולות/);
    const initialUrl = await page.locator("[data-crop-result]").getAttribute("src");
    const initialBytes = await page.evaluate(async () => [...new Uint8Array(await window.cropBlobs.get(document.querySelector("[data-crop-result]").src).arrayBuffer())]);
    await page.locator("[data-crop-straighten]").tap();
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
    await session?.detach();
    const selected = await page.locator("[data-crop-corner]").evaluateAll(handles => handles.map(h => ({ x: parseFloat(h.style.left) / 100, y: parseFloat(h.style.top) / 100 })));
    for (let i = 0; i < 4; i++) assert.ok(Math.hypot(selected[i].x - corners[i].x, selected[i].y - corners[i].y) < .01, "four independent corners follow the paper");
    assert.equal(await page.evaluate(() => window.cropMessages.filter(m => ["preview", "straighten"].includes(m.type)).length), 0);
    await page.locator("[data-crop-accept]").tap();
    await page.waitForFunction(url => document.querySelector("[data-crop-result]").src !== url && !document.querySelector("[data-crop-accept]").disabled, initialUrl);
    await assertWholeCropVisible(page);
    assert.equal(await page.locator("[data-crop-accept]").textContent(), "אשר", "show the result before saving it");
    assert.equal(await page.evaluate(() => window.cropMessages.filter(m => m.type === "straighten").length), 1);
    assert.equal(await page.evaluate(() => window.scanRequests.length), 0);
    await mkdir("test-artifacts", { recursive: true });
    await page.screenshot({ path: `test-artifacts/manual-perspective-${engine.name()}.png`, fullPage: true });
    const correctedUrl = await page.locator("[data-crop-result]").getAttribute("src");
    await page.locator("[data-crop-undo]").tap();
    await page.waitForFunction(url => document.querySelector("[data-crop-result]").src !== url && !document.querySelector("[data-crop-accept]").disabled, correctedUrl);
    const restoredBytes = await page.evaluate(async () => [...new Uint8Array(await window.cropBlobs.get(document.querySelector("[data-crop-result]").src).arrayBuffer())]);
    assert.deepEqual(restoredBytes, initialBytes, "Back restores the exact image before manual straightening");
    await page.locator("[data-crop-straighten]").tap();
    await page.locator('[data-crop-corner="0"]').press("Shift+ArrowRight");
    await page.locator("[data-crop-undo]").tap();
    assert.equal(await page.locator("[data-crop-straighten]").getAttribute("aria-pressed"), "false", "Back also cancels unapplied alignment");
    assert.equal(await page.evaluate(() => window.cropMessages.filter(m => m.type === "straighten").length), 1);
    await page.locator("[data-crop-original]").tap();
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

  test(`${engine.name()}: missing boundaries and worker failure keep the full-photo escape usable`, { timeout: 60000 }, async t => {
    const page = await scannerPage(t, engine);
    await page.evaluate(() => window.openScanner());
    await page.evaluate(() => window.chooseScanPhoto("gallery-file", "none"));
    await page.waitForFunction(() => document.querySelector("[data-crop-status]").textContent.includes("לא זוהו גבולות"));
    await assertWholeCropVisible(page);
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
