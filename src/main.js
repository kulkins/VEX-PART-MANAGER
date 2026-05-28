import { parseCadFile, cancelActiveStepWorker } from "./parser.js";
import { classifyAssembly } from "./classifier.js";
import { CATEGORIES, buildBulkVexUrl, buildBulkRoboUrl } from "./partsdb.js";
import { Sidebar, showToast } from "./ui.js";

const els = {
  dropzone: document.getElementById("dropzone"),
  fileInput: document.getElementById("fileInput"),
  canvas: document.getElementById("canvas3d"),
  loading: document.getElementById("loadingOverlay"),
  loadingMsg: document.getElementById("loadingMsg"),
  loadingDetail: document.getElementById("loadingDetail"),
  cancelLoadingBtn: document.getElementById("cancelLoadingBtn"),
  sidebar: document.getElementById("categories"),
  summary: document.getElementById("partsSummary"),
  hud: document.getElementById("viewerHud"),
  fileName: document.getElementById("fileNameLabel"),
  partCount: document.getElementById("partCountLabel"),
  bbox: document.getElementById("bboxLabel"),
  ghostToggle: document.getElementById("ghostToggle"),
  colorNaturalRadio: document.getElementById("colorNatural"),
  colorCategoryRadio: document.getElementById("colorCategory"),
  wireToggle: document.getElementById("wireToggle"),
  rotateToggle: document.getElementById("autoRotateToggle"),
  explodeRange: document.getElementById("explodeRange"),
  explodeBtn: document.getElementById("explodeBtn"),
  resetBtn: document.getElementById("resetBtn"),
  clearBtn: document.getElementById("clearBtn"),
  openVexBtn: document.getElementById("openVexBtn"),
  openRoboBtn: document.getElementById("openRoboBtn"),
  exportBtn: document.getElementById("exportBtn"),
  unitsSelect: document.getElementById("unitsSelect"),
  selectionInfo: document.getElementById("selectionInfo"),
  selName: document.getElementById("selName"),
  selMeta: document.getElementById("selMeta"),
  selVexLink: document.getElementById("selVexLink"),
  selRoboLink: document.getElementById("selRoboLink"),
  closeSelection: document.getElementById("closeSelection"),
};

let currentLoadToken = 0;

// Initialize the sidebar BEFORE the viewer so that even if WebGL fails to
// initialize (headless / unsupported GPU) the parts UI still works.
const sidebar = new Sidebar(els.sidebar, els.summary);
sidebar.render({ items: [], byCategory: emptyByCategory() });

// Bind file/drop listeners synchronously so an early file selection isn\'t
// missed while the viewer module is still downloading.
bindDropzone();

let viewer = null;
let viewerReady = false;
try {
  // Probe WebGL up front so we can show a friendly message if it isn't
  // available, rather than letting Three.js throw a noisy stack.
  const probe = document.createElement("canvas");
  const gl =
    probe.getContext("webgl2") ||
    probe.getContext("webgl") ||
    probe.getContext("experimental-webgl");
  if (!gl) throw new Error("This browser/environment does not expose WebGL");

  const { Viewer } = await import("./viewer.js");
  viewer = new Viewer(els.canvas);
  viewerReady = true;
} catch (err) {
  console.warn("3D viewer disabled:", err);
  showWebGLDisabled(err.message || String(err));
}

let currentClassification = null;
let isExploded = false;

function emptyByCategory() {
  const m = new Map();
  for (const id of Object.keys(CATEGORIES)) m.set(id, []);
  return m;
}

function showWebGLDisabled(reason) {
  // Replace the dropzone interior so the user still understands the app.
  const inner = els.dropzone.querySelector(".dropzone-inner");
  if (inner) {
    inner.innerHTML = `
      <div class="dropzone-icon">⚠</div>
      <h2>3D viewer unavailable</h2>
      <p class="muted">${escapeHtml(reason)}</p>
      <p>You can still drop a CAD file to generate a parts list and order links — the 3D model just won't render here.</p>
      <label class="btn primary">
        <input id="fileInputFallback" type="file" accept=".stl,.obj,.step,.stp,.STL,.OBJ,.STEP,.STP" hidden />
        Choose file
      </label>
    `;
    const fb = inner.querySelector("#fileInputFallback");
    fb?.addEventListener("change", async () => {
      const f = fb.files?.[0];
      if (f) await loadFile(f);
      fb.value = "";
    });
  }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

// ---------- File handling ----------
function bindDropzone() {
  const dz = els.dropzone;
  dz.addEventListener("dragover", (e) => {
    e.preventDefault();
    dz.classList.add("dragover");
  });
  dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
  dz.addEventListener("drop", async (e) => {
    e.preventDefault();
    dz.classList.remove("dragover");
    const file = e.dataTransfer?.files?.[0];
    if (file) await loadFile(file);
  });
  // Whole-window drop also works once the dropzone is hidden
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", async (e) => {
    e.preventDefault();
    if (!els.dropzone.classList.contains("hidden")) return;
    const file = e.dataTransfer?.files?.[0];
    if (file) await loadFile(file);
  });

  els.fileInput.addEventListener("change", async () => {
    const f = els.fileInput.files?.[0];
    if (f) await loadFile(f);
    els.fileInput.value = "";
  });
}

async function loadFile(file) {
  // Refuse / warn about files that are very likely to exhaust browser memory
  // before we even start. STEP tessellation in WASM needs ~5–10x the file
  // size in RAM, so we warn at 50 MB and hard-refuse at 200 MB.
  const sizeMB = file.size / (1024 * 1024);
  const ext = file.name.toLowerCase().split(".").pop();
  if (ext === "step" || ext === "stp") {
    if (sizeMB > 200) {
      showToast(
        `STEP file is ${sizeMB.toFixed(0)} MB — too large for in-browser tessellation. Export as STL from your CAD program and try again.`,
        { error: true, duration: 8000 },
      );
      return;
    }
    if (sizeMB > 50) {
      const ok = window.confirm(
        `This STEP file is ${sizeMB.toFixed(0)} MB.\n\n` +
          "STEP files need to be tessellated in the browser, which can take " +
          "several minutes and may run the tab out of memory above ~50 MB.\n\n" +
          "For files this large, the recommended workflow is:\n" +
          "  • Export your CAD as STL\n" +
          "  • Then drop the STL here\n\n" +
          "Click OK to attempt to parse the STEP anyway, or Cancel and export STL.",
      );
      if (!ok) return;
    }
  } else if (sizeMB > 300) {
    const ok = window.confirm(
      `This ${ext.toUpperCase()} file is ${sizeMB.toFixed(0)} MB. Parsing may run the tab out of memory. Continue anyway?`,
    );
    if (!ok) return;
  }

  const myToken = ++currentLoadToken;
  showLoading("Loading…", `Reading ${file.name}`);
  try {
    const unitHint = els.unitsSelect.value;
    const { object, units } = await parseCadFile(file, {
      unitHint,
      onProgress: (msg) => {
        if (myToken !== currentLoadToken) return;
        els.loadingMsg.textContent = "Working…";
        els.loadingDetail.textContent = msg;
      },
    });
    if (myToken !== currentLoadToken) return;

    els.loadingMsg.textContent = "Classifying parts…";
    els.loadingDetail.textContent = "";
    await new Promise((r) => setTimeout(r, 16));
    const classification = classifyAssembly(object, units);
    currentClassification = classification;

    if (viewerReady) {
      const colorMap = new Map();
      for (const id of Object.keys(CATEGORIES)) {
        colorMap.set(id, CATEGORIES[id].color);
      }
      viewer.loadAssembly(object, colorMap);
      viewer.setSelectHandler(handleMeshSelected);
    }

    sidebar.render(classification);
    sidebar.onItemClick = (item) => {
      if (!viewerReady) return;
      const m = item.meshes[0];
      viewer.highlight(m);
      viewer.frame();
      handleMeshSelected(m);
    };

    els.dropzone.classList.add("hidden");
    if (viewerReady) {
      els.hud.hidden = false;
      els.explodeBtn.disabled = false;
    }
    els.clearBtn.disabled = false;
    els.openVexBtn.disabled = false;
    els.openRoboBtn.disabled = false;
    els.exportBtn.disabled = false;
    els.fileName.textContent = file.name;
    els.partCount.textContent = `${classification.items.reduce(
      (s, i) => s + i.quantity,
      0,
    )} parts`;
    els.bbox.textContent = boundingBoxString(object, units);

    isExploded = false;
    els.explodeRange.value = "0";
    setExplodeButtonLabel(false);
    hideLoading();
    showToast(`Loaded ${classification.items.length} unique parts`);
  } catch (err) {
    console.error(err);
    hideLoading();
    showToast(err.message || "Failed to load file", { error: true });
  }
}

function boundingBoxString(object, units) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  object.traverse((c) => {
    if (!c.isMesh) return;
    c.geometry.computeBoundingBox();
    const bb = c.geometry.boundingBox;
    min[0] = Math.min(min[0], bb.min.x);
    min[1] = Math.min(min[1], bb.min.y);
    min[2] = Math.min(min[2], bb.min.z);
    max[0] = Math.max(max[0], bb.max.x);
    max[1] = Math.max(max[1], bb.max.y);
    max[2] = Math.max(max[2], bb.max.z);
  });
  const dims = max.map((v, i) => v - min[i]);
  const inchScale =
    { in: 1, mm: 1 / 25.4, cm: 1 / 2.54, m: 39.3701 }[units] || 1;
  const inDims = dims.map((d) => d * inchScale);
  return inDims.map((d) => `${d.toFixed(1)}″`).join(" × ");
}

// ---------- HUD interactions ----------
els.ghostToggle.addEventListener("change", () => {
  // Unchecked = automatic (fades in as explode increases); checked =
  // force always-visible. We never use a hard "hide" because the auto
  // mode already keeps it invisible while assembled.
  viewer?.setGhostVisible(els.ghostToggle.checked ? true : null);
});

els.colorNaturalRadio?.addEventListener("change", () => {
  if (els.colorNaturalRadio.checked) viewer?.setColorMode("natural");
});
els.colorCategoryRadio?.addEventListener("change", () => {
  if (els.colorCategoryRadio.checked) viewer?.setColorMode("category");
});
els.wireToggle.addEventListener("change", () =>
  viewer?.setWireframe(els.wireToggle.checked),
);
els.rotateToggle.addEventListener("change", () =>
  viewer?.setAutoRotate(els.rotateToggle.checked),
);
els.explodeRange.addEventListener("input", () => {
  if (!viewer) return;
  const v = Number(els.explodeRange.value) / 100;
  viewer.setExplode(v);
  isExploded = v > 0.5;
  setExplodeButtonLabel(isExploded);
});

els.explodeBtn.addEventListener("click", () => {
  if (!viewer) return;
  isExploded = !isExploded;
  const target = isExploded ? 1 : 0;
  viewer.animateExplode(target, 1400);
  const start = performance.now();
  const from = Number(els.explodeRange.value);
  const to = isExploded ? 100 : 0;
  const dur = 1400;
  const tick = () => {
    const t = Math.min(1, (performance.now() - start) / dur);
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    els.explodeRange.value = String(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  setExplodeButtonLabel(isExploded);
});

function setExplodeButtonLabel(exploded) {
  els.explodeBtn.querySelector(".btn-label").textContent = exploded
    ? "Assemble"
    : "Explode";
}

els.resetBtn.addEventListener("click", () => viewer?.frame());
els.clearBtn.addEventListener("click", () => {
  viewer?.clear();
  sidebar.render({ items: [], byCategory: emptyByCategory() });
  currentClassification = null;
  els.dropzone.classList.remove("hidden");
  els.hud.hidden = true;
  els.selectionInfo.hidden = true;
  els.explodeBtn.disabled = true;
  els.clearBtn.disabled = true;
  els.openVexBtn.disabled = true;
  els.openRoboBtn.disabled = true;
  els.exportBtn.disabled = true;
  els.explodeRange.value = "0";
  setExplodeButtonLabel(false);
});

// ---------- Selection info ----------
function handleMeshSelected(mesh) {
  if (!mesh) {
    els.selectionInfo.hidden = true;
    sidebar.highlightMesh(null);
    return;
  }
  const ud = mesh.userData;
  const item = sidebar.itemsByMesh.get(mesh);
  els.selName.textContent = ud.partName || "Part";
  const dims = ud.features?.dims
    ?.map((d) => (d >= 1 ? d.toFixed(2) : d.toFixed(3)))
    .join(" × ");
  els.selMeta.textContent = `${dims ? dims + " in" : ""} · ${Math.round(
    (ud.confidence || 0) * 100,
  )}% match · ${CATEGORIES[ud.category]?.label || "Unknown"}`;

  if (item?.part) {
    els.selVexLink.href = item.part.vexUrl;
    els.selRoboLink.href = item.part.roboUrl;
    els.selVexLink.style.display = "";
    els.selRoboLink.style.display = "";
  } else {
    els.selVexLink.style.display = "none";
    els.selRoboLink.style.display = "none";
  }
  els.selectionInfo.hidden = false;
  sidebar.highlightMesh(mesh);
}
els.closeSelection.addEventListener("click", () => {
  els.selectionInfo.hidden = true;
  viewer?.highlight(null);
  sidebar.highlightMesh(null);
});

// ---------- Bulk order ----------
els.openVexBtn.addEventListener("click", () => {
  if (!currentClassification) return;
  const items = currentClassification.items.filter((i) => i.part);
  if (items.length === 0) return showToast("No identified parts to order");
  window.open(buildBulkVexUrl(items), "_blank", "noopener");
});
els.openRoboBtn.addEventListener("click", () => {
  if (!currentClassification) return;
  const items = currentClassification.items.filter((i) => i.part);
  if (items.length === 0) return showToast("No identified parts to order");
  window.open(buildBulkRoboUrl(items), "_blank", "noopener");
});

els.exportBtn.addEventListener("click", () => {
  if (!currentClassification) return;
  const rows = [
    ["Part", "Category", "Quantity", "Confidence", "VEX URL", "Robosource URL"],
  ];
  for (const it of currentClassification.items) {
    rows.push([
      it.name,
      CATEGORIES[it.categoryId]?.label || "Unknown",
      it.quantity,
      (it.avgConfidence * 100).toFixed(0) + "%",
      it.part?.vexUrl || "",
      it.part?.roboUrl || "",
    ]);
  }
  const csv = rows
    .map((r) =>
      r
        .map((v) => {
          const s = String(v);
          return s.includes(",") || s.includes('"')
            ? `"${s.replace(/"/g, '""')}"`
            : s;
        })
        .join(","),
    )
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "vex-parts-list.csv";
  a.click();
  URL.revokeObjectURL(url);
});

// ---------- Loading helpers ----------
function showLoading(msg, detail = "") {
  els.loading.hidden = false;
  els.loadingMsg.textContent = msg;
  if (els.loadingDetail) els.loadingDetail.textContent = detail;
}
function hideLoading() {
  els.loading.hidden = true;
}

els.cancelLoadingBtn?.addEventListener("click", () => {
  currentLoadToken++;
  cancelActiveStepWorker();
  hideLoading();
  showToast("Cancelled", { error: true });
});
