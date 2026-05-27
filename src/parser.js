import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";

// Returns { object: THREE.Object3D, units: 'mm'|'in'|'cm'|'m'|'unknown' }
//
// The returned object is a group whose children represent individual parts
// of the assembly. For monolithic meshes we split connected components so
// each piece can be classified and animated independently.

const yieldUI = () => new Promise((r) => setTimeout(r, 0));

export async function parseCadFile(file, { onProgress, unitHint } = {}) {
  const t0 = performance.now();
  const name = file.name.toLowerCase();
  const ext = name.split(".").pop();
  const report = (m) => {
    console.log(`[parser] ${m}`);
    onProgress?.(m);
  };
  report(`Reading ${file.name} (${(file.size / 1e6).toFixed(2)} MB)`);
  await yieldUI();

  let assembly;
  let detectedUnits = unitHint && unitHint !== "auto" ? unitHint : "unknown";

  if (ext === "stl") {
    const buffer = await file.arrayBuffer();
    report("Decoding STL");
    await yieldUI();

    const loader = new STLLoader();
    const geometry = loader.parse(buffer);
    const triCount =
      (geometry.getIndex()?.count ?? geometry.getAttribute("position").count) /
      3;
    report(
      `Decoded ${Math.round(triCount).toLocaleString()} triangles · splitting parts`,
    );
    await yieldUI();

    assembly = await splitGeometryIntoParts(geometry, report);
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
  } else {
    throw new Error(`Unsupported file type ".${ext}". Use STL, OBJ, or STEP.`);
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

async function collectObjGroups(root, report) {
  const assembly = new THREE.Group();
  const meshes = [];
  root.traverse((c) => {
    if (c.isMesh) meshes.push(c);
  });
  if (meshes.length === 0) return assembly;
  if (meshes.length === 1) {
    return splitGeometryIntoParts(meshes[0].geometry, report);
  }
  for (let i = 0; i < meshes.length; i++) {
    const m = meshes[i];
    const geom = m.geometry.clone();
    geom.applyMatrix4(m.matrixWorld);
    geom.computeVertexNormals();
    assembly.add(makePartMesh(geom));
    if (i % 25 === 0) {
      report(`Loaded part ${i + 1} / ${meshes.length}`);
      await yieldUI();
    }
  }
  return assembly;
}

// ---------- Connected-component splitter ----------
//
// Very large STLs (e.g. >500k triangles) are returned as a single mesh.
// Splitting works by:
//   1. Quantizing positions and merging duplicates with a TypedArray-backed
//      open-addressing hash (no string allocation).
//   2. Union-find over the merged vertex graph.
//   3. Bucketing triangles by component root and building one sub-geometry
//      per bucket.
//
// Each phase yields back to the event loop so the progress message paints.
async function splitGeometryIntoParts(geometry, report) {
  const assembly = new THREE.Group();
  const pos = geometry.getAttribute("position");
  const idx = geometry.getIndex();
  const triangleCount = idx ? idx.count / 3 : pos.count / 3;

  if (triangleCount > 500_000) {
    report(
      `Triangle count (${Math.round(triangleCount).toLocaleString()}) is very high — keeping as a single mesh`,
    );
    geometry.computeVertexNormals();
    assembly.add(makePartMesh(geometry));
    return assembly;
  }

  report(`Merging duplicate vertices`);
  await yieldUI();
  const { mergedPositions, oldToNew, mergedCount } = await mergeVertices(
    pos,
    idx,
  );

  report(`Building component graph`);
  await yieldUI();
  // Union-find over merged vertex indices
  const parent = new Int32Array(mergedCount);
  for (let i = 0; i < mergedCount; i++) parent[i] = i;
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

  const triangleVerts = new Int32Array(triangleCount * 3);
  for (let t = 0; t < triangleCount; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    const a = oldToNew[i0],
      b = oldToNew[i1],
      c = oldToNew[i2];
    triangleVerts[t * 3] = a;
    triangleVerts[t * 3 + 1] = b;
    triangleVerts[t * 3 + 2] = c;
    union(a, b);
    union(b, c);
    if ((t & 0xffff) === 0 && t > 0) {
      report(
        `Building component graph · ${Math.round(t).toLocaleString()} / ${Math.round(triangleCount).toLocaleString()}`,
      );
      await yieldUI();
    }
  }

  report(`Grouping triangles`);
  await yieldUI();
  // Bucket triangles by root index
  const buckets = new Map();
  for (let t = 0; t < triangleCount; t++) {
    const root = find(triangleVerts[t * 3]);
    let list = buckets.get(root);
    if (!list) {
      list = [];
      buckets.set(root, list);
    }
    list.push(t);
  }

  report(`Found ${buckets.size} component(s) · building meshes`);
  await yieldUI();
  let bi = 0;
  for (const tris of buckets.values()) {
    bi++;
    const sub = buildSubGeometry(mergedPositions, triangleVerts, tris);
    sub.computeVertexNormals();
    assembly.add(makePartMesh(sub));
    if (bi % 8 === 0) {
      report(`Building part ${bi} / ${buckets.size}`);
      await yieldUI();
    }
  }
  return assembly;
}

// Merge near-duplicate vertices using a TypedArray-backed open-addressing
// hash table over quantized (x, y, z) coordinates.
async function mergeVertices(pos, idx) {
  // Compute a reasonable tolerance based on the mesh extents — 1e-4 of the
  // largest absolute coordinate, capped so we don't merge intentionally-close
  // parts together.
  let maxAbs = 0;
  for (let i = 0; i < pos.count; i++) {
    const v = Math.max(
      Math.abs(pos.getX(i)),
      Math.abs(pos.getY(i)),
      Math.abs(pos.getZ(i)),
    );
    if (v > maxAbs) maxAbs = v;
  }
  const tol = Math.max(1e-4 * maxAbs, 1e-5);
  const inv = 1 / tol;

  // Open-addressing hash table. Slots store (qx, qy, qz, mappedIndex).
  // Sized at ~2x the vertex count and rounded to next power-of-two so that
  // we can use bitwise masking instead of a modulo for probe stepping.
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
      if (
        slotsQx[s] === qx &&
        slotsQy[s] === qy &&
        slotsQz[s] === qz
      ) {
        break;
      }
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

function buildSubGeometry(mergedPositions, triangleVerts, triIndices) {
  const used = new Map();
  const newPositions = [];
  const newIndices = [];
  for (const t of triIndices) {
    for (let k = 0; k < 3; k++) {
      const v = triangleVerts[t * 3 + k];
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
    roughness: 0.45,
    metalness: 0.35,
    flatShading: false,
  });
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ---------- STEP parsing ----------
//
// occt-import-js publishes a UMD bundle (OpenCascade compiled to WASM). We
// inject it via a <script> tag and call its factory. The library is ~5 MB
// so it's loaded lazily on the first STEP upload.
let occtPromise = null;
function loadOcct(report) {
  if (occtPromise) return occtPromise;
  const base = "https://cdn.jsdelivr.net/npm/occt-import-js@0.0.22/dist/";
  occtPromise = new Promise((resolve, reject) => {
    const finish = () => {
      const factory = window.occtimportjs;
      if (!factory) {
        reject(new Error("occt-import-js loaded but global is missing"));
        return;
      }
      report?.("Initialising STEP decoder");
      factory({ locateFile: (name) => base + name })
        .then(resolve)
        .catch(reject);
    };
    if (window.occtimportjs) return finish();
    const script = document.createElement("script");
    script.src = base + "occt-import-js.js";
    script.async = true;
    script.onload = finish;
    script.onerror = () =>
      reject(new Error("Failed to fetch occt-import-js script"));
    document.head.appendChild(script);
  }).catch((e) => {
    occtPromise = null;
    throw e;
  });
  return occtPromise;
}

async function parseStepFile(file, report) {
  let occt;
  try {
    occt = await loadOcct(report);
  } catch (e) {
    console.error(e);
    throw new Error(
      "STEP files require the OpenCascade WASM module, which failed to load. " +
        "Check your network connection and try again, or export your CAD as STL/OBJ.",
    );
  }
  report?.("Tessellating STEP geometry");
  await yieldUI();
  const buffer = new Uint8Array(await file.arrayBuffer());
  const result = occt.ReadStepFile(buffer, null);
  if (!result || !result.success) {
    throw new Error("Could not parse STEP file");
  }

  const assembly = new THREE.Group();
  for (let i = 0; i < (result.meshes || []).length; i++) {
    const m = result.meshes[i];
    const positions = new Float32Array(m.attributes.position.array);
    const normals = m.attributes.normal
      ? new Float32Array(m.attributes.normal.array)
      : null;
    const indices = m.index ? new Uint32Array(m.index.array) : null;

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    if (normals)
      g.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    if (indices) g.setIndex(new THREE.BufferAttribute(indices, 1));
    if (!normals) g.computeVertexNormals();

    const mesh = makePartMesh(g);
    if (m.name) mesh.userData.sourceName = m.name;
    assembly.add(mesh);
    if (i % 10 === 0) {
      report?.(`Building mesh ${i + 1} / ${result.meshes.length}`);
      await yieldUI();
    }
  }
  return assembly;
}
