// STEP parser worker.
//
// occt-import-js (OpenCascade compiled to WebAssembly) does the heavy
// tessellation off the main thread so the page stays responsive. The
// worker now:
//   - Accepts a Quality preset and tunes OpenCascade's tessellation
//     deflection accordingly. The default settings give very high-quality
//     output but are very slow on big STEPs; coarser deflection runs
//     several times faster and produces fewer triangles.
//   - Streams each tessellated mesh back to the main thread via a
//     separate postMessage (with transferable buffers) instead of
//     collecting everything into one giant payload at the end. The main
//     thread can start building Three.js geometry while the worker is
//     still busy with the remaining shapes.
//   - Reports tessellation timing and per-mesh progress in the loading
//     overlay so long STEPs feel less like a frozen tab.

let occtPromise = null;
const BASE = "https://cdn.jsdelivr.net/npm/occt-import-js@0.0.22/dist/";

function loadOcct() {
  if (occtPromise) return occtPromise;
  occtPromise = new Promise((resolve, reject) => {
    try {
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

// Tessellation deflection in OpenCascade. Lower = finer = slower.
// `bounding_box_ratio` means the linear value is a fraction of the
// shape's bounding box, so it's scale-invariant.
const DEFLECTION = {
  high:   { linear: 0.001, angular: 0.4 },
  medium: { linear: 0.005, angular: 0.7 },
  low:    { linear: 0.020, angular: 1.2 },
  auto:   { linear: 0.005, angular: 0.7 },
};

self.onmessage = async (event) => {
  const msg = event.data;
  if (msg.type !== "parse") return;
  const { buffer, quality = "auto", autoSizeMB = 0 } = msg;

  try {
    self.postMessage({
      type: "progress",
      text: "Loading STEP decoder (≈5 MB WASM, first time only)",
    });
    const occt = await loadOcct();

    // For "auto", scale deflection by file size. Big STEPs get coarser
    // tessellation, otherwise OpenCascade can sit for minutes on a single
    // 80 MB part.
    let q = quality;
    if (q === "auto") {
      if (autoSizeMB > 80) q = "low";
      else if (autoSizeMB > 25) q = "medium";
      else q = "high";
    }
    const defl = DEFLECTION[q] || DEFLECTION.medium;

    self.postMessage({
      type: "progress",
      text: `Tessellating STEP (quality: ${q})`,
    });

    const t0 = performance.now();
    const params = {
      linearUnit: "mm",
      linearDeflectionType: "bounding_box_ratio",
      linearDeflection: defl.linear,
      angularDeflection: defl.angular,
    };
    const result = occt.ReadStepFile(new Uint8Array(buffer), params);
    const tessTime = ((performance.now() - t0) / 1000).toFixed(2);

    if (!result || !result.success) {
      self.postMessage({
        type: "error",
        message: "Could not parse STEP file",
      });
      return;
    }

    const meshes = result.meshes || [];
    self.postMessage({
      type: "progress",
      text: `Tessellated ${meshes.length} mesh(es) in ${tessTime}s · streaming back`,
    });
    self.postMessage({ type: "meshcount", count: meshes.length });

    // Stream meshes one at a time. Transferable buffers make each
    // postMessage essentially free, and the main thread can begin
    // building Three.js objects as soon as the first message arrives.
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      const pos = new Float32Array(m.attributes.position.array);
      const norm = m.attributes.normal
        ? new Float32Array(m.attributes.normal.array)
        : null;
      const idx = m.index ? new Uint32Array(m.index.array) : null;

      const transfer = [pos.buffer];
      if (norm) transfer.push(norm.buffer);
      if (idx) transfer.push(idx.buffer);

      self.postMessage(
        {
          type: "mesh",
          index: i,
          total: meshes.length,
          name: m.name || null,
          color: m.color || null,
          position: pos,
          normal: norm,
          indexArray: idx,
        },
        transfer,
      );
    }
    self.postMessage({ type: "done", total: meshes.length });
  } catch (err) {
    self.postMessage({
      type: "error",
      message: err?.message || String(err),
    });
  }
};
