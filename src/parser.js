import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";

// Returns { object: THREE.Object3D, units: 'mm'|'in'|'cm'|'m'|'unknown' }
//
// The returned object is a group whose children represent individual parts
// of the assembly. Per file type we use the best splitter we have:
//
//   - ASCII STL: each `solid ... endsolid` block becomes its own part
//     (Inventor / Fusion / SolidWorks "one solid per part" export option).
//   - Binary STL: edge-shared connectivity. Two triangles are unioned only
//     when they share a manifold edge (an edge with exactly two triangles),
//     so parts that touch in CAD but are still distinct closed manifolds
//     end up as separate components.
//   - OBJ: each `o` / `g` directive becomes its own part. Falls back to
//     edge-shared connectivity if the OBJ has a single mesh.
//   - STEP: occt-import-js returns one mesh per face / per shape; we keep
//     that structure and pass through any per-mesh colors.

const yieldUI = () => new Promise((r) => setTimeout(r, 0));

// ---------- Safety budgets ----------
// macOS Metal/ANGLE will crash the GPU driver (and sometimes the kernel)
// when WebGL is asked to allocate buffers far above its limit. We refuse
// or warn before that point. Numbers are conservative: a typical Mac
// integrated GPU has 1-2 GB usable VRAM via WebGL, and we want to leave
// headroom for shading and the ghost-outline buffer.
export const SAFETY = {
  WARN_TRIANGLES: 600_000,
  REFUSE_TRIANGLES: 4_000_000,
  WARN_UNCOMPRESSED_MB: 200,
  REFUSE_UNCOMPRESSED_MB: 800,
};

// Cancellation token shared with main.js. Each user-initiated load
// increments .id; the parser checks .id between yields and throws
// `ParseCancelled` if the user pressed the Cancel button.
export const parserCancel = { id: 0 };
export class ParseCancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "ParseCancelled";
  }
}
export function cancelParse() {
  parserCancel.id++;
  cancelActiveStepWorker();
}
const checkCancel = (token) => {
  if (parserCancel.id !== token) throw new ParseCancelled();
};

export async function parseCadFile(file, { onProgress, unitHint } = {}) {
  const token = parserCancel.id;
  const t0 = performance.now();
  const name = file.name.toLowerCase();
  const ext = name.split(".").pop();
  const report = (m) => {
    console.log(`[parser] ${m}`);
    onProgress?.(m);
  };
  report(`Reading ${file.name} (${(file.size / 1e6).toFixed(2)} MB)`);
  await yieldUI();
  checkCancel(token);

  let assembly;
  let detectedUnits = unitHint && unitHint !== "auto" ? unitHint : "unknown";

  if (ext === "stl") {
    const buffer = await file.arrayBuffer();
    report("Decoding STL");
    await yieldUI();
    assembly = await parseStl(buffer, report);
  } else if (ext === "obj") {
    const text = await file.text();
    report("Decoding OBJ");
    await yieldUI();
    const loader = new OBJLoader();
    const obj = loader.parse(text);
    report("Indexing parts");
    await yieldUI();
    assembly = await collectObjGroups(obj, report);
  } else if (ext === "step" || ext === "stp") {
    report("Loading STEP decoder (≈5 MB WASM, first time only)");
    await yieldUI();
    assembly = await parseStepFile(file, report);
    if (detectedUnits === "unknown") detectedUnits = "mm";
  } else if (ext === "zip") {
    report("Reading ZIP archive");
    await yieldUI();
    const inner = await parseZip(file, report, unitHint);
    assembly = inner.assembly;
    if (detectedUnits === "unknown") detectedUnits = inner.units;
  } else {
    throw new Error(
      `Unsupported file type ".${ext}". Use STL, OBJ, STEP, or a ZIP that contains them.`,
    );
  }

  if (!assembly || assembly.children.length === 0) {
    throw new Error("No geometry found in file");
  }

  if (detectedUnits === "unknown") {
    const bbox = new THREE.Box3().setFromObject(assembly);
    const size = bbox.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 80) detectedUnits = "mm";
    else if (maxDim > 8) detectedUnits = "cm";
    else if (maxDim > 0.05) detectedUnits = "in";
    else detectedUnits = "m";
  }

  const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
  report(
    `Parsed ${assembly.children.length} parts in ${elapsed}s · detected units: ${detectedUnits}`,
  );
  return { object: assembly, units: detectedUnits };
}

// ---------- STL ----------
async function parseStl(buffer, report) {
  // ASCII STL files start with the keyword `solid` followed by a name.
  // Binary STL files start with a 80-byte header, then a uint32 triangle
  // count. We sniff the first few bytes to decide which path to take.
  const bytes = new Uint8Array(buffer);
  const head = new TextDecoder("utf-8").decode(bytes.slice(0, 256));
  const isAscii =
    head.trimStart().toLowerCase().startsWith("solid") &&
    head.toLowerCase().includes("facet");

  if (isAscii) {
    report("ASCII STL · splitting by `solid` blocks");
    await yieldUI();
    return parseAsciiStlSolids(new TextDecoder("utf-8").decode(bytes), report);
  }

  // Binary STL: parse via STLLoader, then run edge-shared splitter
  const loader = new STLLoader();
  const geom = loader.parse(buffer);
  const triCount =
    (geom.getIndex()?.count ?? geom.getAttribute("position").count) / 3;
  report(
    `Decoded ${Math.round(triCount).toLocaleString()} triangles · splitting parts`,
  );
  await yieldUI();
  return await splitByManifold(geom, report);
}

// Parse ASCII STL preserving multi-solid structure. Each `solid <name> ... endsolid`
// block becomes its own mesh in the returned group.
async function parseAsciiStlSolids(text, report) {
  const assembly = new THREE.Group();
  // Be lenient about whitespace and CRLF; the body can be huge so use a regex
  // over the whole string (no global flag with split, but exec with /g is fine).
  const re = /^\s*solid\s+([^\n\r]*)([\s\S]*?)^\s*endsolid\b[^\n]*/gim;
  let m;
  let i = 0;
  const matches = [];
  while ((m = re.exec(text)) !== null) matches.push(m);

  if (matches.length === 0) {
    // No structured solids found; fall back to STLLoader + edge split
    report("ASCII STL had no `solid` blocks; falling back to edge split");
    await yieldUI();
    const enc = new TextEncoder();
    const geom = new STLLoader().parse(enc.encode(text).buffer);
    return splitByManifold(geom, report);
  }

  for (const match of matches) {
    const name = (match[1] || `part_${i + 1}`).trim();
    const body = match[2];
    const tris = parseFacetsInBody(body);
    if (tris.length === 0) continue;

    const positions = new Float32Array(tris.length * 9);
    for (let t = 0; t < tris.length; t++) {
      const tri = tris[t];
      for (let v = 0; v < 3; v++) {
        positions[t * 9 + v * 3] = tri[v * 3];
        positions[t * 9 + v * 3 + 1] = tri[v * 3 + 1];
        positions[t * 9 + v * 3 + 2] = tri[v * 3 + 2];
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    g.computeVertexNormals();
    const mesh = makePartMesh(g);
    mesh.userData.sourceName = name;
    assembly.add(mesh);

    i++;
    if (i % 16 === 0) {
      report(`Parsed solid ${i} / ${matches.length} (${name})`);
      await yieldUI();
    }
  }
  report(`Loaded ${assembly.children.length} solid block(s)`);
  await yieldUI();
  return assembly;
}

function parseFacetsInBody(body) {
  // Very fast facet parser: scans `vertex x y z` lines, three per triangle.
  const tris = [];
  const re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
  let buf = [];
  let m;
  while ((m = re.exec(body)) !== null) {
    buf.push(+m[1], +m[2], +m[3]);
    if (buf.length === 9) {
      tris.push(buf);
      buf = [];
    }
  }
  return tris;
}

// ---------- OBJ ----------
async function collectObjGroups(root, report) {
  const assembly = new THREE.Group();
  const meshes = [];
  root.traverse((c) => {
    if (c.isMesh) meshes.push(c);
  });
  if (meshes.length === 0) return assembly;
  if (meshes.length === 1) {
    return splitByManifold(meshes[0].geometry, report);
  }
  for (let i = 0; i < meshes.length; i++) {
    const m = meshes[i];
    const geom = m.geometry.clone();
    geom.applyMatrix4(m.matrixWorld);
    geom.computeVertexNormals();
    const partMesh = makePartMesh(geom);
    if (m.material?.color) {
      partMesh.userData.sourceColor = m.material.color.getHex();
    }
    if (m.name) partMesh.userData.sourceName = m.name;
    assembly.add(partMesh);
    if (i % 25 === 0) {
      report(`Loaded part ${i + 1} / ${meshes.length}`);
      await yieldUI();
    }
  }
  return assembly;
}

// ---------- Edge-shared (manifold) connectivity ----------
//
// Two triangles belong to the same component iff there's a chain of triangles
// between them where each adjacent pair shares an edge that has exactly two
// triangles in the whole mesh. This correctly separates parts that touch
// face-to-face in CAD (those shared edges have 4+ triangles, so we don't
// union across them) while still treating each part's closed surface as one
// component.
async function splitByManifold(geometry, report) {
  const assembly = new THREE.Group();
  const pos = geometry.getAttribute("position");
  const idx = geometry.getIndex();
  const triangleCount = idx ? idx.count / 3 : pos.count / 3;

  if (triangleCount > 800_000) {
    report(
      `Triangle count (${Math.round(triangleCount).toLocaleString()}) is very high — keeping as a single mesh`,
    );
    geometry.computeVertexNormals();
    assembly.add(makePartMesh(geometry));
    return assembly;
  }

  report("Merging duplicate vertices");
  await yieldUI();
  const { mergedPositions, oldToNew, mergedCount } = await mergeVertices(
    pos,
    idx,
  );

  // Each triangle's 3 merged vertex indices
  const triV = new Int32Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    triV[t * 3] = oldToNew[i0];
    triV[t * 3 + 1] = oldToNew[i1];
    triV[t * 3 + 2] = oldToNew[i2];
  }

  report("Building edge map");
  await yieldUI();
  // Map each undirected edge (low, high) to up to 2 incident triangles. If a
  // third triangle wants to claim the edge, the edge is marked non-manifold
  // (sentinel value -1) so we never union across it.
  // To keep memory tight, we use two TypedArrays keyed on a hash of (low, high).
  const edgeBucketCount = nextPow2(Math.max(triangleCount * 3, 64));
  const edgeMask = edgeBucketCount - 1;
  const edgeLow = new Int32Array(edgeBucketCount).fill(-1);
  const edgeHigh = new Int32Array(edgeBucketCount).fill(-1);
  const edgeT1 = new Int32Array(edgeBucketCount).fill(-1);
  const edgeT2 = new Int32Array(edgeBucketCount).fill(-1);
  const edgeManifold = new Uint8Array(edgeBucketCount); // 0 = unset, 1 = manifold, 2 = non-manifold

  const hashEdge = (low, high) => {
    let h = low * 73856093;
    h = (h ^ (high * 19349663)) | 0;
    return h & edgeMask;
  };

  const addEdge = (low, high, tri) => {
    let s = hashEdge(low, high);
    while (true) {
      if (edgeLow[s] === -1) {
        edgeLow[s] = low;
        edgeHigh[s] = high;
        edgeT1[s] = tri;
        edgeManifold[s] = 1;
        return;
      }
      if (edgeLow[s] === low && edgeHigh[s] === high) {
        if (edgeManifold[s] === 1) {
          edgeT2[s] = tri;
          edgeManifold[s] = 1; // still manifold
        } else if (edgeManifold[s] === 1 && edgeT2[s] !== -1) {
          edgeManifold[s] = 2; // third triangle => non-manifold
        }
        if (edgeT2[s] !== -1 && edgeT2[s] !== tri) {
          edgeManifold[s] = 2;
        } else if (edgeT2[s] === -1) {
          edgeT2[s] = tri;
        }
        return;
      }
      s = (s + 1) & edgeMask;
    }
  };

  for (let t = 0; t < triangleCount; t++) {
    const a = triV[t * 3],
      b = triV[t * 3 + 1],
      c = triV[t * 3 + 2];
    for (const [u, v] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const low = u < v ? u : v;
      const high = u < v ? v : u;
      addEdge(low, high, t);
    }
    if ((t & 0xffff) === 0 && t > 0) {
      report(
        `Building edge map · ${Math.round(t).toLocaleString()} / ${Math.round(triangleCount).toLocaleString()}`,
      );
      await yieldUI();
    }
  }

  report("Connecting components");
  await yieldUI();
  // Union-find on triangle indices via 2-manifold edges only.
  const parent = new Int32Array(triangleCount);
  for (let i = 0; i < triangleCount; i++) parent[i] = i;
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a, b) => {
    const ra = find(a),
      rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let s = 0; s < edgeBucketCount; s++) {
    if (edgeManifold[s] !== 1) continue;
    const t1 = edgeT1[s];
    const t2 = edgeT2[s];
    if (t1 !== -1 && t2 !== -1) union(t1, t2);
  }

  report("Grouping triangles");
  await yieldUI();
  const buckets = new Map();
  for (let t = 0; t < triangleCount; t++) {
    const r = find(t);
    let list = buckets.get(r);
    if (!list) {
      list = [];
      buckets.set(r, list);
    }
    list.push(t);
  }

  // Drop tiny stray buckets (probably stray non-manifold triangles) into the
  // biggest neighbour. We treat anything <10 triangles as noise UNLESS the
  // mesh is small (then keep everything).
  if (triangleCount > 200) {
    const small = [];
    for (const [r, tris] of buckets) {
      if (tris.length < 10) small.push(r);
    }
    for (const r of small) buckets.delete(r);
  }

  report(`Found ${buckets.size} component(s) · building meshes`);
  await yieldUI();
  let bi = 0;
  for (const tris of buckets.values()) {
    bi++;
    const sub = buildSubGeometry(mergedPositions, triV, tris);
    sub.computeVertexNormals();
    assembly.add(makePartMesh(sub));
    if (bi % 16 === 0) {
      report(`Building part ${bi} / ${buckets.size}`);
      await yieldUI();
    }
  }
  return assembly;
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

async function mergeVertices(pos, idx) {
  let maxAbs = 0;
  for (let i = 0; i < pos.count; i++) {
    const v = Math.max(
      Math.abs(pos.getX(i)),
      Math.abs(pos.getY(i)),
      Math.abs(pos.getZ(i)),
    );
    if (v > maxAbs) maxAbs = v;
  }
  // Tight enough that we don't fuse genuinely-distinct vertices but loose
  // enough to merge floating-point duplicates from the exporter.
  const tol = Math.max(1e-5 * Math.max(maxAbs, 1), 1e-6);
  const inv = 1 / tol;

  let capacity = 1;
  while (capacity < pos.count * 2) capacity <<= 1;
  const mask = capacity - 1;
  const slotsQx = new Int32Array(capacity);
  const slotsQy = new Int32Array(capacity);
  const slotsQz = new Int32Array(capacity);
  const slotsMap = new Int32Array(capacity).fill(-1);

  const mergedX = [];
  const mergedY = [];
  const mergedZ = [];
  const oldToNew = new Int32Array(pos.count);

  const hash3 = (qx, qy, qz) => {
    let h = qx * 73856093;
    h = (h ^ (qy * 19349663)) | 0;
    h = (h ^ (qz * 83492791)) | 0;
    return h & mask;
  };

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i),
      y = pos.getY(i),
      z = pos.getZ(i);
    const qx = Math.round(x * inv) | 0;
    const qy = Math.round(y * inv) | 0;
    const qz = Math.round(z * inv) | 0;

    let s = hash3(qx, qy, qz);
    while (slotsMap[s] !== -1) {
      if (slotsQx[s] === qx && slotsQy[s] === qy && slotsQz[s] === qz) break;
      s = (s + 1) & mask;
    }
    if (slotsMap[s] === -1) {
      const newIdx = mergedX.length;
      mergedX.push(x);
      mergedY.push(y);
      mergedZ.push(z);
      slotsQx[s] = qx;
      slotsQy[s] = qy;
      slotsQz[s] = qz;
      slotsMap[s] = newIdx;
    }
    oldToNew[i] = slotsMap[s];
  }

  const mergedCount = mergedX.length;
  const mergedPositions = new Float32Array(mergedCount * 3);
  for (let i = 0; i < mergedCount; i++) {
    mergedPositions[i * 3] = mergedX[i];
    mergedPositions[i * 3 + 1] = mergedY[i];
    mergedPositions[i * 3 + 2] = mergedZ[i];
  }
  return { mergedPositions, oldToNew, mergedCount };
}

function buildSubGeometry(mergedPositions, triV, triIndices) {
  const used = new Map();
  const newPositions = [];
  const newIndices = [];
  for (const t of triIndices) {
    for (let k = 0; k < 3; k++) {
      const v = triV[t * 3 + k];
      let mapped = used.get(v);
      if (mapped === undefined) {
        mapped = newPositions.length / 3;
        newPositions.push(
          mergedPositions[v * 3],
          mergedPositions[v * 3 + 1],
          mergedPositions[v * 3 + 2],
        );
        used.set(v, mapped);
      }
      newIndices.push(mapped);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(newPositions, 3),
  );
  g.setIndex(newIndices);
  return g;
}

function makePartMesh(geometry) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0x8b95b8,
    roughness: 0.42,
    metalness: 0.32,
    flatShading: false,
  });
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ---------- STEP parsing ----------
//
// occt-import-js runs in a Web Worker (see step.worker.js). We retain a
// handle to the worker so the user-visible Cancel button can terminate it
// without freezing the page.
let activeStepWorker = null;

export function cancelActiveStepWorker() {
  if (activeStepWorker) {
    try {
      activeStepWorker.terminate();
    } catch (_) {
      /* worker may already be gone */
    }
    activeStepWorker = null;
  }
}

async function parseStepFile(file, report) {
  let worker;
  try {
    worker = new Worker(new URL("./step.worker.js", import.meta.url), {
      type: "classic",
    });
  } catch (err) {
    console.error(err);
    throw new Error(
      "Couldn't start the STEP decoder worker. " +
        "Try serving the site over http(s) (e.g. `python3 scripts/serve.py`) instead of opening the file directly.",
    );
  }
  activeStepWorker = worker;

  const buffer = await file.arrayBuffer();
  const meshes = await new Promise((resolve, reject) => {
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "progress") {
        report?.(m.text);
      } else if (m.type === "done") {
        resolve(m.meshes);
      } else if (m.type === "error") {
        reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      reject(new Error(e.message || "STEP worker crashed"));
    };
    worker.postMessage({ type: "parse", buffer }, [buffer]);
  }).finally(() => {
    if (activeStepWorker === worker) activeStepWorker = null;
    worker.terminate();
  });

  report?.(`Building ${meshes.length} mesh(es)`);
  await yieldUI();
  const assembly = new THREE.Group();
  for (let i = 0; i < meshes.length; i++) {
    const m = meshes[i];
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(m.position, 3));
    if (m.normal)
      g.setAttribute("normal", new THREE.BufferAttribute(m.normal, 3));
    if (m.index) g.setIndex(new THREE.BufferAttribute(m.index, 1));
    if (!m.normal) g.computeVertexNormals();
    const mesh = makePartMesh(g);
    if (m.name) mesh.userData.sourceName = m.name;
    if (m.color) {
      // STEP colors come through as [r, g, b] floats in 0..1
      mesh.userData.sourceColor = new THREE.Color(
        m.color[0],
        m.color[1],
        m.color[2],
      ).getHex();
    }
    assembly.add(mesh);
    if (i % 16 === 0) {
      report?.(`Building mesh ${i + 1} / ${meshes.length}`);
      await yieldUI();
    }
  }
  return assembly;
}

// ---------- ZIP archive parsing ----------
//
// Onshape's "Download → Other formats → STL (one file per part)" emits a ZIP
// containing one STL per component. We open the archive on the fly with
// fflate (a tiny ESM library loaded from a CDN), parse each member through
// the appropriate loader, and merge the resulting parts into one assembly.

let fflatePromise = null;
async function loadFflate() {
  if (fflatePromise) return fflatePromise;
  fflatePromise = import(
    /* @vite-ignore */ "https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js"
  );
  return fflatePromise;
}

async function parseZip(file, report, unitHint) {
  const token = parserCancel.id;
  const fflate = await loadFflate();
  const buffer = new Uint8Array(await file.arrayBuffer());
  report("Unzipping archive");
  await yieldUI();
  checkCancel(token);
  const entries = await new Promise((resolve, reject) => {
    fflate.unzip(buffer, (err, unzipped) => {
      if (err) reject(err);
      else resolve(unzipped);
    });
  });
  checkCancel(token);

  const supported = (name) =>
    /\.(stl|obj|step|stp)$/i.test(name) && !name.startsWith("__MACOSX/");
  const members = Object.keys(entries).filter(supported);
  if (members.length === 0) {
    throw new Error("ZIP did not contain any STL/OBJ/STEP files");
  }

  // Pre-flight safety: sum uncompressed bytes and (for binary STL members)
  // exact triangle counts. We can read each STL's triangle count without
  // decoding the geometry, so this is O(member count), not O(geometry).
  let totalUncompressed = 0;
  let estimatedTris = 0;
  for (const name of members) {
    const b = entries[name];
    totalUncompressed += b.byteLength;
    // Binary STL: triangle count at byte offset 80
    if (b.byteLength >= 84) {
      // Skip ASCII members; we'll count them on the fly.
      const headByte = b[0];
      if (headByte !== 0x73 /* 's' */ && headByte !== 0x20 /* space */) {
        estimatedTris += new DataView(b.buffer, b.byteOffset, 84).getUint32(80, true);
      }
    }
  }
  const uncompressedMB = totalUncompressed / (1024 * 1024);
  report(
    `Archive has ${members.length} CAD file(s) · ${uncompressedMB.toFixed(1)} MB · ≈${estimatedTris.toLocaleString()} triangles`,
  );
  await yieldUI();
  checkCancel(token);

  // Hard refuse anything that's certain to exhaust the GPU or browser memory.
  if (
    uncompressedMB > SAFETY.REFUSE_UNCOMPRESSED_MB ||
    estimatedTris > SAFETY.REFUSE_TRIANGLES
  ) {
    throw new Error(
      `Archive is too large for safe in-browser rendering (${uncompressedMB.toFixed(0)} MB / ` +
        `${estimatedTris.toLocaleString()} triangles). The cap is ` +
        `${SAFETY.REFUSE_UNCOMPRESSED_MB} MB / ${SAFETY.REFUSE_TRIANGLES.toLocaleString()} triangles ` +
        `to protect the GPU driver. Re-export with a coarser STL resolution (in Onshape: ` +
        `Download → STL → Resolution: Coarse), or export only the subassembly you need.`,
    );
  }
  if (
    uncompressedMB > SAFETY.WARN_UNCOMPRESSED_MB ||
    estimatedTris > SAFETY.WARN_TRIANGLES
  ) {
    report(
      `Heads up: ${uncompressedMB.toFixed(0)} MB / ${estimatedTris.toLocaleString()} triangles — ` +
        `loading may be slow. Use the Cancel button if it hangs.`,
    );
    await yieldUI();
  }

  const assembly = new THREE.Group();
  let units = "unknown";

  // Fast path: every member is a single-part STL (Onshape's "one file per
  // part" export). Decode each STL's geometry directly into one mesh per
  // member with no splitting or vertex merging.
  const allStl = members.every((n) => /\.stl$/i.test(n));

  if (allStl) {
    const t0 = performance.now();
    let totalTri = 0;
    const step = Math.max(1, Math.floor(members.length / 12));
    for (let i = 0; i < members.length; i++) {
      const memberName = members[i];
      const memberBytes = entries[memberName];
      const { mesh, triangles } = decodeStlAsSingleMesh(
        memberBytes,
        memberName,
      );
      assembly.add(mesh);
      totalTri += triangles;
      if (i % step === 0 || i === members.length - 1) {
        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        report(
          `Parsing parts · ${i + 1} / ${members.length} · ${totalTri.toLocaleString()} triangles · ${elapsed}s`,
        );
        await yieldUI();
        checkCancel(token);
        // If triangle count balloons past the hard cap mid-parse (e.g. lots
        // of ASCII STL members we couldn't pre-count), bail before we crash
        // the GPU on the next allocation.
        if (totalTri > SAFETY.REFUSE_TRIANGLES) {
          throw new Error(
            `Triangle count passed ${SAFETY.REFUSE_TRIANGLES.toLocaleString()} mid-parse — aborting to protect the GPU. ` +
              `Re-export with a coarser STL resolution.`,
          );
        }
      }
    }
  } else {
    // Mixed-format ZIP (e.g. a mix of STEP and STL): fall back to the full
    // parser per member.
    for (let i = 0; i < members.length; i++) {
      const memberName = members[i];
      const memberBytes = entries[memberName];
      report(`Parsing ${memberName} (${i + 1} / ${members.length})`);
      await yieldUI();
      const innerFile = new File([memberBytes], memberName, {
        type: "application/octet-stream",
      });
      const inner = await parseCadFile(innerFile, {
        onProgress: (m) => report(`${memberName}: ${m}`),
        unitHint,
      });
      if (units === "unknown") units = inner.units;
      inner.object.traverse((c) => {
        if (c.isMesh && !c.userData.sourceName) {
          c.userData.sourceName = memberName.replace(/\.[^.]+$/, "");
        }
      });
      while (inner.object.children.length) {
        assembly.add(inner.object.children[0]);
      }
    }
  }

  if (units === "unknown" && (!unitHint || unitHint === "auto")) {
    const bbox = new THREE.Box3().setFromObject(assembly);
    const size = bbox.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 80) units = "mm";
    else if (maxDim > 8) units = "cm";
    else if (maxDim > 0.05) units = "in";
    else units = "m";
  } else if (unitHint && unitHint !== "auto") {
    units = unitHint;
  }

  return { assembly, units };
}

// Decode an STL byte-buffer (ASCII or binary) into a single Three.js mesh.
// No splitting, no vertex merging — used by the ZIP fast path where we
// already know each file is one part.
function decodeStlAsSingleMesh(bytes, name) {
  const head = bytes.subarray(0, Math.min(256, bytes.length));
  const headText = new TextDecoder("utf-8", { fatal: false }).decode(head);
  const looksAscii =
    headText.trimStart().toLowerCase().startsWith("solid") &&
    headText.toLowerCase().includes("facet");

  let geometry;
  let triangles;
  if (looksAscii) {
    ({ geometry, triangles } = decodeAsciiStlGeometry(bytes));
  } else {
    ({ geometry, triangles } = decodeBinaryStlGeometry(bytes));
  }
  geometry.computeVertexNormals();
  const mesh = makePartMesh(geometry);
  mesh.userData.sourceName = name.replace(/\.[^.]+$/, "");
  return { mesh, triangles };
}

function decodeBinaryStlGeometry(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const triCount = dv.getUint32(80, true);
  const positions = new Float32Array(triCount * 9);
  let off = 84;
  for (let i = 0; i < triCount; i++) {
    off += 12; // skip facet normal
    for (let v = 0; v < 9; v++) {
      positions[i * 9 + v] = dv.getFloat32(off, true);
      off += 4;
    }
    off += 2; // skip the "attribute byte count" trailer
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return { geometry: g, triangles: triCount };
}

function decodeAsciiStlGeometry(bytes) {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const positions = [];
  const re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    positions.push(+m[1], +m[2], +m[3]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  return { geometry: g, triangles: positions.length / 9 };
}
