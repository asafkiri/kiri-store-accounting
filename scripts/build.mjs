import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
await rm("dist", { recursive: true, force: true });
await mkdir("dist/assets", { recursive: true });
await cp("public", "dist", { recursive: true });
const worker = await build({
  entryPoints: ["src/scan-worker.js"],
  bundle: true,
  minify: true,
  format: "esm",
  target: ["safari16", "chrome110"],
  outdir: "dist/assets",
  entryNames: "[name]-[hash]",
  metafile: true,
});
const workerName = Object.keys(worker.metafile.outputs)[0].split("/").at(-1);
await build({
  entryPoints: ["src/app.js"],
  bundle: true,
  minify: true,
  format: "esm",
  target: ["safari16", "chrome110"],
  outdir: "dist/assets",
  splitting: true,
  define: { SCAN_WORKER_URL: JSON.stringify("./" + workerName) },
  logLevel: "info",
});
await cp("src/styles.css", "dist/assets/app.css");
console.log("Firebase Hosting build ready: dist/");
