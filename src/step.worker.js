// STEP parser worker.
//
// occt-import-js is a synchronous WASM module that can run for many seconds
// (or minutes) on large STEP files. Doing that work on the main thread
// freezes the page and renders the Cancel button useless. We move it here:
// the worker loads occt-import-js via importScripts, parses the STEP buffer,
// and posts back a transferable mesh-list. The main thread can terminate
// the worker at any time to cancel.

let occtPromise = null;

const BASE = "https://cdn.jsdelivr.net/npm/occt-import-js@0.0.22/dist/";

function loadOcct() {
  if (occtPromise) return occtPromise;
  occtPromise = new Promise((resolve, reject) => {
    try {
      // occt-import-js publishes a UMD bundle that defines `occtimportjs`
      // on the global object when loaded.
      // eslint-disable-next-line no-undef
      importScripts(BASE + "occt-import-js.js");
      const factory = self.occtimportjs;
      if (!factory) {
        reject(new Error("occt-import-js loaded but global is missing"));
        return;
      }
      factory({ locateFile: (n) => BASE + n })
        .then(resolve)
        .catch(reject);
    } catch (err) {
      reject(err);
    }
  }).catch((err) => {
    occtPromise = null;
    throw err;
  });
  return occtPromise;
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type !== "parse") return;
  const buffer = msg.buffer;
  try {
    self.postMessage({ type: "progress", text: "Loading STEP decoder (≈5 MB WASM, first time only)" });
    const occt = await loadOcct();
    self.postMessage({ type: "progress", text: "Tessellating STEP geometry" });

    const result = occt.ReadStepFile(new Uint8Array(buffer), null);
    if (!result || !result.success) {
      self.postMessage({ type: "error", message: "Could not parse STEP file" });
      return;
    }

    const meshes = [];
    const transfer = [];
    for (let i = 0; i < (result.meshes || []).length; i++) {
      const m = result.meshes[i];
      const pos = new Float32Array(m.attributes.position.array);
      const norm = m.attributes.normal
        ? new Float32Array(m.attributes.normal.array)
        : null;
      const idx = m.index ? new Uint32Array(m.index.array) : null;
      meshes.push({
        name: m.name || null,
        position: pos,
        normal: norm,
        index: idx,
      });
      transfer.push(pos.buffer);
      if (norm) transfer.push(norm.buffer);
      if (idx) transfer.push(idx.buffer);

      if (i % 10 === 0) {
        self.postMessage({
          type: "progress",
          text: `Tessellating · mesh ${i + 1} / ${result.meshes.length}`,
        });
      }
    }
    self.postMessage({ type: "done", meshes }, transfer);
  } catch (err) {
    self.postMessage({
      type: "error",
      message: err?.message || String(err),
    });
  }
};
