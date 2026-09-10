import { build } from "esbuild";
import { resolve } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

// Bundle the real module with boundary doubles, without changing production APIs.
export async function loadModule(entry, mocks) {
  const result = await build({
    entryPoints: [resolve(entry)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    plugins: [
      {
        name: "test-boundaries",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) =>
            Object.hasOwn(mocks, args.path)
              ? { path: args.path, namespace: "test-boundary" }
              : undefined,
          );
          build.onLoad(
            { filter: /.*/, namespace: "test-boundary" },
            (args) => ({
              contents: mocks[args.path],
              loader: "js",
              resolveDir: process.cwd(),
            }),
          );
        },
      },
    ],
  });
  const dir = await mkdtemp(resolve(tmpdir(), "kiri-test-"));
  const file = resolve(dir, "module.mjs");
  try {
    await writeFile(file, result.outputFiles[0].text);
    return await import(pathToFileURL(file).href);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
