// Quick headless smoke test: open the page in Chrome via the DevTools
// Protocol, wait for the sidebar to render the category list, and report any
// console errors. Used for CI sanity checking; not shipped as part of the app.

import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function serve(rootDir, port) {
  const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
  };
  const server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split("?")[0]);
      if (p.endsWith("/")) p += "index.html";
      const filePath = path.join(rootDir, p);
      if (!filePath.startsWith(rootDir)) {
        res.writeHead(403);
        res.end();
        return;
      }
      const data = await fs.readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, {
        "Content-Type": types[ext] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(data);
    } catch (err) {
      res.writeHead(404);
      res.end(String(err.message));
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

async function main() {
  const port = 8788;
  const server = await serve(root, port);

  const userDir = await fs.mkdtemp("/tmp/chrome-vex-");
  const chrome = spawn(
    "google-chrome",
    [
      "--headless=new",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--no-sandbox",
      "--remote-debugging-port=9333",
      `--user-data-dir=${userDir}`,
      `http://localhost:${port}/index.html`,
    ],
    { stdio: "ignore" },
  );

  // Give Chrome a moment to bind the debugger port
  await new Promise((r) => setTimeout(r, 1500));

  // Locate the page target
  const tabs = await fetch("http://localhost:9333/json").then((r) => r.json());
  const page = tabs.find((t) => t.type === "page");
  if (!page) throw new Error("No Chrome page found");

  const WebSocket = (await import("ws")).WebSocket;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.once("open", r));

  let id = 0;
  const pending = new Map();
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else {
      handleEvent(m);
    }
  });
  const errors = [];
  function handleEvent(m) {
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      errors.push(
        m.params.args.map((a) => a.value || a.description).join(" "),
      );
    }
    if (m.method === "Runtime.exceptionThrown") {
      errors.push(
        m.params.exceptionDetails?.exception?.description ||
          m.params.exceptionDetails?.text ||
          "<exception>",
      );
    }
  }
  function send(method, params = {}) {
    return new Promise((resolve) => {
      const myId = ++id;
      pending.set(myId, resolve);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });
  }

  await send("Runtime.enable");
  await send("Page.enable");

  // Wait up to 20s for the sidebar to render category nodes
  const start = Date.now();
  let categoryCount = 0;
  while (Date.now() - start < 20000) {
    const res = await send("Runtime.evaluate", {
      expression:
        "document.querySelectorAll('#categories .category').length",
      returnByValue: true,
    });
    categoryCount = res.result?.result?.value ?? 0;
    if (categoryCount >= 6) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  // The loading overlay must NOT be visible until the user uploads a file.
  // Catches the CSS specificity bug where .loading-overlay { display: flex }
  // overrode the [hidden] attribute.
  const overlayVis = await send("Runtime.evaluate", {
    expression: `(() => {
      const el = document.getElementById('loadingOverlay');
      const cs = getComputedStyle(el);
      return { display: cs.display, hidden: el.hidden };
    })()`,
    returnByValue: true,
  });
  const overlay = overlayVis?.result?.result?.value || {};
  console.log("Loading overlay state:", overlay);

  console.log("Categories rendered:", categoryCount);
  console.log("Console errors:", errors.length);
  for (const e of errors) console.log("  •", e);

  ws.close();
  chrome.kill();
  server.close();

  if (categoryCount < 6) process.exit(1);
  if (errors.length > 0) process.exit(2);
  if (overlay.display !== "none") {
    console.error("Loading overlay is visible on initial page load");
    process.exit(4);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
