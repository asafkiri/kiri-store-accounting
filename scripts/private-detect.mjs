// Local-only check of the document-boundary detector on private photographs.
// The photos live in PRIVATE_FIXTURES, a directory that must be outside the
// repository: nothing here is read from or written into the repository, and
// the script skips itself when the variable is not set (CI). Each image is
// decoded by headless Chromium exactly as the app does (EXIF orientation
// applied, white fill, area-scaled to a long edge of 320 and 1000), run through
// detectDocument from src/scan-worker.js, and compared with truth.json when it
// lists the file. The result is a plain-text table plus <name>-detect.png next
// to each photo with the detected quad (green) and the truth quad (magenta).
import { createServer } from "node:http";
import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const IMAGE_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const SCRIPT_TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json" };
const SIZES = [320, 1000], RUNS = 3, OUTPUT_SUFFIX = "-detect.png";
const repo = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));

function fail(message) {
  console.error("error: " + message);
  process.exit(1);
}
const insideRepo = path => path === repo || path.startsWith(repo + sep);

// --- Locate and validate the private directory -------------------------------
const given = process.env.PRIVATE_FIXTURES;
if (!given) {
  console.log("skipped: PRIVATE_FIXTURES not set");
  process.exit(0);
}
let dir;
try { dir = await realpath(resolve(given)); }
catch { fail(`PRIVATE_FIXTURES directory does not exist: ${given}`); }
if (insideRepo(dir)) fail(`PRIVATE_FIXTURES resolves to ${dir}, which is inside the repository ${repo}. Private photos must stay outside the repository; move them elsewhere.`);
if (!(await stat(dir)).isDirectory()) fail(`PRIVATE_FIXTURES is not a directory: ${dir}`);

const names = (await readdir(dir))
  .filter(name => IMAGE_TYPES[extname(name).toLowerCase()] && !name.toLowerCase().endsWith(OUTPUT_SUFFIX))
  .sort();
if (!names.length) fail(`no image files (.jpg/.jpeg/.png/.webp) in ${dir}`);

let truth = {};
try { truth = JSON.parse(await readFile(join(dir, "truth.json"), "utf8")); }
catch (error) { if (error.code !== "ENOENT") fail(`cannot read truth.json: ${error.message}`); }
if (!truth || typeof truth !== "object" || Array.isArray(truth)) fail("truth.json must be an object of { \"<filename>\": [[x,y],[x,y],[x,y],[x,y]] }");
const truthFor = name => {
  const quad = truth[name];
  if (quad == null) return null;
  const valid = Array.isArray(quad) && quad.length === 4 &&
    quad.every(p => Array.isArray(p) && p.length === 2 && p.every(v => Number.isFinite(v) && v >= 0 && v <= 1));
  if (!valid) fail(`truth.json: "${name}" must be four [x,y] pairs normalised to 0..1 (TL,TR,BR,BL)`);
  return quad.map(([x, y]) => ({ x, y }));
};
for (const name of Object.keys(truth)) if (!names.includes(name)) console.log(`note: truth.json entry "${name}" has no matching image file`);

// --- Local server: src/ at /, test/ at /test/, the private photos at /private/ -
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><title>private-detect</title><body></body></html>`;
async function fileFrom(root, relative) {
  const file = resolve(root, "." + sep + relative);
  if (!file.startsWith(root + sep)) throw Error("outside root");
  return readFile(file);
}
const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") { res.writeHead(405); return res.end(); }
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
    if (pathname === "/") { res.setHeader("Content-Type", "text/html; charset=utf-8"); return res.end(page); }
    let body, type;
    if (pathname.startsWith("/private/")) {
      const name = pathname.slice("/private/".length);
      if (!names.includes(name)) throw Error("not a listed image");
      type = IMAGE_TYPES[extname(name).toLowerCase()]; body = await fileFrom(dir, name);
    } else if (pathname.startsWith("/test/")) {
      type = SCRIPT_TYPES[extname(pathname)]; body = await fileFrom(join(repo, "test"), pathname.slice("/test/".length));
    } else {
      type = SCRIPT_TYPES[extname(pathname)]; body = await fileFrom(join(repo, "src"), pathname.slice(1));
    }
    if (!type) throw Error("unsupported type");
    res.setHeader("Content-Type", type); res.end(body);
  } catch { res.writeHead(404); res.end("Not found"); }
});
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;

// --- Runs inside the page: decode, detect, measure, compare, draw -------------
async function analyseInPage({ url, truth, sizes, runs }) {
  const { detectDocument } = await import("/scan-worker.js");
  let cornerDeviation = null;
  try { cornerDeviation = (await import("/test/scanner-fixtures.mjs")).cornerDeviation || null; } catch {}
  const deviationSource = cornerDeviation ? "test/scanner-fixtures.mjs" : "local fallback";
  // Same formula as the fixture helper, used until that export exists:
  // per-corner distance in pixels over the long edge, and for found corners
  // strictly inside the truth quad their minimal distance to its edges.
  cornerDeviation ??= (found, truth, width, height) => {
    const px = p => ({ x: p.x * (width - 1), y: p.y * (height - 1) }), long = Math.max(width, height);
    const f = found.map(px), t = truth.map(px);
    const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const segmentDistance = (p, a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
      const u = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
      return Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy);
    };
    const max = Math.max(...f.map((p, i) => Math.hypot(p.x - t[i].x, p.y - t[i].y))) / long * 100;
    let maxInward = 0;
    for (const p of f) {
      const signs = t.map((a, i) => Math.sign(cross(a, t[(i + 1) % 4], p)));
      if (!(signs.every(s => s > 0) || signs.every(s => s < 0))) continue;
      maxInward = Math.max(maxInward, Math.min(...t.map((a, i) => segmentDistance(p, a, t[(i + 1) % 4]))) / long * 100);
    }
    return { max, maxInward };
  };
  const response = await fetch(url);
  if (!response.ok) throw Error(`HTTP ${response.status} for ${url}`);
  const bitmap = await createImageBitmap(await response.blob(), { imageOrientation: "from-image" });
  // Mirrors pixelsFromImage in src/scan.js: white fill, no upscaling.
  const pixels = maxEdge => {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height)), canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const pen = canvas.getContext("2d", { willReadFrequently: true });
    pen.fillStyle = "white"; pen.fillRect(0, 0, canvas.width, canvas.height);
    pen.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const image = pen.getImageData(0, 0, canvas.width, canvas.height);
    canvas.width = canvas.height = 1;
    return image;
  };
  const copy = image => new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  const median = values => {
    const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  const draw = (image, found, truth) => {
    const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
    const pen = canvas.getContext("2d"); pen.putImageData(image, 0, 0);
    const quad = (points, color) => {
      if (!points) return;
      const at = p => [p.x * (image.width - 1), p.y * (image.height - 1)];
      pen.strokeStyle = pen.fillStyle = color; pen.lineWidth = 3; pen.lineJoin = "round";
      pen.beginPath(); points.forEach((p, i) => pen[i ? "lineTo" : "moveTo"](...at(p))); pen.closePath(); pen.stroke();
      for (const p of points) { pen.beginPath(); pen.arc(...at(p), 5, 0, Math.PI * 2); pen.fill(); }
    };
    quad(truth, "#ff00ff"); quad(found, "#00ff00");
    return canvas.toDataURL("image/png");
  };
  const results = [];
  let overlay = null;
  for (const size of sizes) {
    const image = pixels(size), times = [];
    let detection = null;
    for (let run = 0; run < runs; run++) {
      const fresh = copy(image), started = performance.now(), result = detectDocument(fresh);
      times.push(performance.now() - started);
      detection ??= result;
    }
    const deviation = detection.corners && truth ? cornerDeviation(detection.corners, truth, image.width, image.height) : null;
    results.push({ size, width: image.width, height: image.height, corners: detection.corners, confidence: detection.confidence,
      reason: detection.reason, borderSides: detection.borderSides, polarity: detection.polarity, deviation, ms: median(times) });
    if (size === Math.max(...sizes)) overlay = draw(image, detection.corners, truth);
  }
  bitmap.close();
  return { results, overlay, deviationSource };
}

// --- Drive the browser and print the table -----------------------------------
const rows = [], written = [];
let deviationSource = null, exitCode = 0;
const browser = await chromium.launch();
try {
  const tab = await browser.newPage();
  const pageErrors = [];
  tab.on("pageerror", error => pageErrors.push(error.message));
  await tab.goto(origin + "/");
  for (const name of names) {
    const url = "/private/" + encodeURIComponent(name), quad = truthFor(name);
    let analysis;
    try { analysis = await tab.evaluate(analyseInPage, { url, truth: quad, sizes: SIZES, runs: RUNS }); }
    catch (error) { throw Error(`${name}: ${error.message}${pageErrors.length ? " (page errors: " + pageErrors.join("; ") + ")" : ""}`); }
    deviationSource = analysis.deviationSource;
    for (const result of analysis.results) rows.push({ name, ...result });
    const output = join(dir, basename(name, extname(name)) + OUTPUT_SUFFIX);
    if (insideRepo(output)) throw Error(`refusing to write inside the repository: ${output}`);
    await writeFile(output, Buffer.from(analysis.overlay.split(",")[1], "base64"));
    written.push(output);
  }
} catch (error) {
  console.error("error: " + (error.message || error));
  exitCode = 1;
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(done => server.close(done));
}
if (exitCode) process.exit(exitCode);

const point = p => `(${p.x.toFixed(3)},${p.y.toFixed(3)})`;
const columns = [
  ["file", row => row.name],
  ["size", row => String(row.size), "right"],
  ["w×h", row => `${row.width}×${row.height}`],
  ["corners TL TR BR BL", row => row.corners ? row.corners.map(point).join(" ") : "null"],
  ["conf", row => row.confidence.toFixed(3), "right"],
  ["reason", row => row.reason ?? "-"],
  ["sides", row => String(row.borderSides), "right"],
  ["polarity", row => row.polarity && typeof row.polarity === "object"
    ? Object.entries(row.polarity).map(([key, value]) => `${key}:${value > 0 ? "+" : ""}${value}`).join(" ")
    : row.polarity ?? "-"],
  ["dev%", row => row.deviation ? row.deviation.max.toFixed(2) : "-", "right"],
  ["inward%", row => row.deviation ? row.deviation.maxInward.toFixed(2) : "-", "right"],
  ["ms", row => row.ms.toFixed(1), "right"],
];
const cells = rows.map(row => columns.map(([, format]) => String(format(row))));
const widths = columns.map(([title], i) => Math.max(title.length, ...cells.map(line => line[i].length)));
const pad = (text, i) => columns[i][2] === "right" ? text.padStart(widths[i]) : text.padEnd(widths[i]);
console.log(`private-detect: ${names.length} image(s) in ${dir}`);
console.log(`cornerDeviation: ${deviationSource}; dev%/inward% are percent of the long edge; ms = median of ${RUNS} runs on fresh ImageData copies`);
console.log(columns.map(([title], i) => pad(title, i)).join("  ").trimEnd());
console.log(widths.map(width => "-".repeat(width)).join("  "));
for (const line of cells) console.log(line.map(pad).join("  ").trimEnd());
for (const output of written) console.log(`wrote ${output}`);
