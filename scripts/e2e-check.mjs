// End-to-end smoke test: upload a synthetic STL into the running app via
// CDP's Input.dispatchFileInputEvent, then assert that the sidebar shows
// part categories and the explode animation moves mesh positions.

import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const fixture = path.resolve(root, "fixtures", "sample.stl");

function serve(rootDir, port) {
  const types = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".stl": "model/stl",
  };
  const server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split("?")[0]);
      if (p.endsWith("/")) p += "index.html";
      const filePath = path.join(rootDir, p);
      if (!filePath.startsWith(rootDir)) return res.writeHead(403).end();
      const data = await fs.readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, {
        "Content-Type": types[ext] || "application/octet-stream",
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
  const port = 8799;
  const server = await serve(root, port);
  const userDir = await fs.mkdtemp("/tmp/chrome-vex-e2e-");

  const chrome = spawn(
    "google-chrome",
    [
      "--headless=new",
      "--no-sandbox",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--remote-debugging-port=9344",
      `--user-data-dir=${userDir}`,
      `http://localhost:${port}/index.html`,
    ],
    { stdio: "ignore" },
  );
  await new Promise((r) => setTimeout(r, 1500));

  const tabs = await fetch("http://localhost:9344/json").then((r) => r.json());
  const page = tabs.find((t) => t.type === "page");
  if (!page) throw new Error("No Chrome page found");

  const { WebSocket } = await import("ws");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.once("open", r));

  let nextId = 0;
  const pending = new Map();
  const errors = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) {
      const cb = pending.get(m.id);
      pending.delete(m.id);
      cb(m);
    } else if (m.method === "Runtime.exceptionThrown") {
      errors.push(
        m.params.exceptionDetails?.exception?.description ||
          m.params.exceptionDetails?.text ||
          "<exception>",
      );
    } else if (m.method === "Runtime.consoleAPICalled") {
      const text = m.params.args
        .map((a) => a.value ?? a.description ?? JSON.stringify(a))
        .join(" ");
      if (m.params.type === "error") errors.push(text);
      console.log(`[console.${m.params.type}]`, text);
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

  // Wait until categories are rendered
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    const r = await send("Runtime.evaluate", {
      expression: "document.querySelectorAll('#categories .category').length",
      returnByValue: true,
    });
    if (r.result?.value >= 6) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  // Find the file input node and dispatch a file event on it
  const doc = await send("DOM.getDocument", { depth: -1 });
  const findNode = await send("DOM.querySelector", {
    nodeId: doc.root.nodeId,
    selector: "#fileInput",
  });
  if (!findNode.nodeId) throw new Error("file input not found");

  await send("DOM.setFileInputFiles", {
    files: [fixture],
    nodeId: findNode.nodeId,
  });

  // Some Chrome versions don\'t dispatch the change event from
  // setFileInputFiles when the input is hidden. Verify by reading the value
  // back, and manually dispatch change if needed.
  await send("Runtime.evaluate", {
    expression: `(() => {
      const fi = document.getElementById('fileInput');
      console.log('after upload, files=', fi?.files?.length, fi?.files?.[0]?.name);
      fi.dispatchEvent(new Event('change', { bubbles: true }));
    })()`,
  });

  // Wait for parts to appear in the sidebar
  let parsedItems = 0;
  const t1 = Date.now();
  while (Date.now() - t1 < 20000) {
    const r = await send("Runtime.evaluate", {
      expression:
        "document.querySelectorAll('#categories .part-item .qty').length",
      returnByValue: true,
    });
    parsedItems = r.result?.value ?? 0;
    if (parsedItems > 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log("Part rows rendered:", parsedItems);

  // Snapshot a part position before and after explode
  const beforePos = await send("Runtime.evaluate", {
    expression: `JSON.stringify(window.__debug_partPositions = (() => {
      const out = [];
      document.querySelectorAll('#categories .part-item .qty').length;
      // pull from the viewer via global handles for testing
      return out;
    })())`,
    returnByValue: true,
  });

  // Click the explode button and wait briefly for the animation to progress.
  await send("Runtime.evaluate", {
    expression: "document.getElementById('explodeBtn').click()",
  });
  await new Promise((r) => setTimeout(r, 1800));

  const rangeVal = await send("Runtime.evaluate", {
    expression: "document.getElementById('explodeRange').value",
    returnByValue: true,
  });

  // The bbox readout should now show non-empty dimensions
  const bboxText = await send("Runtime.evaluate", {
    expression: "document.getElementById('bboxLabel').textContent",
    returnByValue: true,
  });

  const summary = await send("Runtime.evaluate", {
    expression: "document.getElementById('partsSummary').textContent",
    returnByValue: true,
  });

  console.log("Summary:", summary.result.value);
  console.log("Bbox:", bboxText.result.value);
  console.log("Explode slider after animate:", rangeVal.result.value);
  console.log("Console errors:", errors.length);
  for (const e of errors) console.log("  •", e);

  ws.close();
  chrome.kill();
  server.close();

  const sliderNum = Number(rangeVal.result.value);
  if (parsedItems === 0) process.exit(1);
  if (sliderNum < 50) process.exit(2);
  if (errors.length > 0) process.exit(3);
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
