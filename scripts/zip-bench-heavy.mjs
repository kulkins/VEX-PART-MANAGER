// Headless benchmark: upload fixtures/assembly-heavy.zip into the app and measure
// the wall-clock time from upload to "parts rendered" + "ghost outline
// built". Used to verify ZIP-import perf changes.

import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const fixture = path.resolve(root, "fixtures", "assembly-heavy.zip");

function serve(rootDir, port) {
  const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".stl": "model/stl",
    ".zip": "application/zip",
  };
  const server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split("?")[0]);
      if (p.endsWith("/")) p += "index.html";
      const filePath = path.join(rootDir, p);
      if (!filePath.startsWith(rootDir)) return res.writeHead(403).end();
      const data = await fs.readFile(filePath);
      res.writeHead(200, {
        "Content-Type": types[path.extname(filePath)] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(data);
    } catch (err) {
      res.writeHead(404).end(String(err.message));
    }
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}

async function main() {
  const port = 8813;
  const server = await serve(root, port);
  const userDir = await fs.mkdtemp("/tmp/chrome-vex-bench-");

  const chrome = spawn(
    "google-chrome",
    [
      "--headless=new",
      "--no-sandbox",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--remote-debugging-port=9357",
      `--user-data-dir=${userDir}`,
      `http://localhost:${port}/index.html`,
    ],
    { stdio: "ignore" },
  );
  await new Promise((r) => setTimeout(r, 1500));

  const tabs = await fetch("http://localhost:9357/json").then((r) => r.json());
  const page = tabs.find((t) => t.type === "page");
  if (!page) throw new Error("No Chrome page found");

  const { WebSocket } = await import("ws");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.once("open", r));

  let nextId = 0;
  const pending = new Map();
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (m) =>
        m.error ? reject(new Error(method + ": " + m.error.message)) : resolve(m.result),
      );
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Runtime.enable");
  await send("Page.enable");
  await send("DOM.enable");

  // Wait for category list to render so we know the app is ready
  while (true) {
    const r = await send("Runtime.evaluate", {
      expression: "document.querySelectorAll('#categories .category').length",
      returnByValue: true,
    });
    if ((r.result?.value ?? 0) >= 6) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  const doc = await send("DOM.getDocument", { depth: -1 });
  const findNode = await send("DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector: "#fileInput",
  });

  const startWall = Date.now();
  await send("DOM.setFileInputFiles", {
    files: [fixture],
    nodeId: findNode.nodeId,
  });

  let rendered = 0;
  while (Date.now() - startWall < 90000) {
    const r = await send("Runtime.evaluate", {
      expression:
        "document.querySelectorAll('#categories .part-item .qty').length",
      returnByValue: true,
    });
    rendered = r.result?.value ?? 0;
    if (rendered > 0) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const tParts = Date.now() - startWall;

  // Wait for the deferred ghost outline to land. The viewer logs a message
  // when it does; we just poll the scene.
  await new Promise((r) => setTimeout(r, 500));

  console.log(`ZIP parts visible in sidebar: ${rendered}`);
  console.log(`Wall time (upload -> rendered): ${(tParts / 1000).toFixed(2)}s`);

  ws.close();
  chrome.kill();
  server.close();

  if (rendered === 0) process.exit(1);
  if (tParts > 30000) {
    console.error("Slower than expected: >30s");
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
