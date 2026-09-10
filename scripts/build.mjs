import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
await rm("dist", { recursive: true, force: true });
await mkdir("dist/assets", { recursive: true });
await cp("public", "dist", { recursive: true });
await build({
  entryPoints: ["src/app.js"],
  bundle: true,
  minify: true,
  format: "esm",
  target: ["safari16", "chrome110"],
  outfile: "dist/assets/app.js",
  logLevel: "info",
});
await cp("src/styles.css", "dist/assets/app.css");
console.log("Firebase Hosting build ready: dist/");
