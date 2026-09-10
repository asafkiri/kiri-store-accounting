// Isolated browser regression check. No Firebase, real accounts or SMS are used.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const page = `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Browser API regression check</title>
<h1>Native browser fetch check</h1>
<p>This local fixture uses a fictional token and an isolated test endpoint.</p>
<pre id="result">Running…</pre>
<script type="module">
import { Api } from '/api-client.js';
const user = { getIdToken: async () => 'fictional-browser-test-token' };
const results = [];
const legacy = { fetch: window.fetch };
try {
  await legacy.fetch('/ping');
  results.push('Legacy receiver: accepted by this browser');
} catch (error) {
  results.push('Legacy receiver: ' + error.name + ': ' + error.message);
}
async function check(label, api) {
  try {
    const result = await api.request('me');
    results.push(label + ': ' + (result.authorized === true ? 'PASS' : 'FAIL'));
  } catch (error) {
    results.push(label + ': FAIL (' + error.code + ')');
  }
}
await check('Current Api default', new Api(user));
await check('Explicitly bound native fetch', new Api(user, window.fetch.bind(window)));
document.querySelector('#result').textContent = results.join('\\n');
</script></html>`;

export function createBrowserCheckServer() {
  return createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET") {
      res.writeHead(405);
      return res.end();
    }
    if (req.url === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(page);
    }
    if (req.url === "/api-client.js") {
      res.setHeader("Content-Type", "text/javascript");
      return res.end(await readFile(new URL("../src/api.js", import.meta.url)));
    }
    if (
      [
        "/image-upload.js",
        "/scan.js",
        "/forms.js",
        "/supplier-picker.js",
        "/supplier-name.js",
        "/ui.js",
        "/format.js",
        "/api.js",
        "/styles.css",
      ].includes(req.url)
    ) {
      res.setHeader(
        "Content-Type",
        req.url.endsWith(".css") ? "text/css" : "text/javascript",
      );
      return res.end(
        await readFile(new URL("../src" + req.url, import.meta.url)),
      );
    }
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/ping") return res.end('{"ok":true}');
    if (req.url === "/api/v1/me") {
      if (req.headers.authorization !== "Bearer fictional-browser-test-token") {
        res.writeHead(401);
        return res.end(
          '{"error":{"code":"AUTH_REQUIRED","message":"Test token required"}}',
        );
      }
      return res.end('{"authorized":true,"uid":"browser-test-user"}');
    }
    res.writeHead(404);
    res.end('{"error":{"code":"NOT_FOUND"}}');
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  createBrowserCheckServer().listen(4321, "127.0.0.1", () => {
    console.log(
      "Open http://127.0.0.1:4321 in a real browser; both Api checks must PASS.",
    );
  });
}
