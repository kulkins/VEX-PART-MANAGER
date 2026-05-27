import * as THREE from "three";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";

// Returns { object: THREE.Object3D, units: 'mm'|'in'|'cm'|'m'|'unknown' }
//
// The returned object is a group whose children represent individual parts of
// the assembly. For monolithic meshes we split connected components so that we
// can classify and animate each piece independently.

export async function parseCadFile(file, { onProgress, unitHint } = {}) {
  const name = file.name.toLowerCase();
  const ext = name.split(".").pop();
  onProgress?.(`Reading ${file.name}`);

  let assembly;
  let detectedUnits = unitHint && unitHint !== "auto" ? unitHint : "unknown";

  if (ext === "stl") {
    const buffer = await file.arrayBuffer();
    const loader = new STLLoader();
    const geometry = loader.parse(buffer);
    geometry.computeVertexNormals();
    onProgress?.("Splitting connected components");
    assembly = splitGeometryIntoParts(geometry);
  } else if (ext === "obj") {
    const text = await file.text();
    const loader = new OBJLoader();
    const obj = loader.parse(text);
    onProgress?.("Indexing parts");
    assembly = collectObjGroups(obj);
  } else if (ext === "step" || ext === "stp") {
    onProgress?.("Decoding STEP geometry");
    assembly = await parseStepFile(file, onProgress);
    // STEP files use millimeters per spec, so default to mm if not overridden
    if (detectedUnits === "unknown") detectedUnits = "mm";
  } else {
    throw new Error(`Unsupported file type ".${ext}". Use STL, OBJ, or STEP.`);
  }

  if (!assembly || assembly.children.length === 0) {
    throw new Error("No geometry found in file");
  }

  // Try to auto-detect units if still unknown by looking at the assembly's
  // overall size. VEX assemblies in inches are typically 5–25" in any
  // dimension; the same model in mm would be 125–635 mm. The heuristic isn't
  // perfect but matches the vast majority of CAD exports.
  if (detectedUnits === "unknown") {
    const bbox = new THREE.Box3().setFromObject(assembly);
    const size = bbox.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    if (maxDim > 80) detectedUnits = "mm";
    else if (maxDim > 8) detectedUnits = "cm";
    else if (maxDim > 0.05) detectedUnits = "in";
    else detectedUnits = "m";
  }

  onProgress?.("Ready");
  return { object: assembly, units: detectedUnits };
}

function collectObjGroups(root) {
  const assembly = new THREE.Group();
  const meshes = [];
  root.traverse((c) => {
    if (c.isMesh) meshes.push(c);
  });
  if (meshes.length === 0) return assembly;

  // If a .obj produced a single mesh, fall back to component splitting.
  if (meshes.length === 1) {
    return splitGeometryIntoParts(meshes[0].geometry);
  }

  for (const m of meshes) {
    const geom = m.geometry.clone();
    geom.applyMatrix4(m.matrixWorld);
    geom.computeVertexNormals();
    assembly.add(makePartMesh(geom));
  }
  return assembly;
}

// Split a non-indexed BufferGeometry into multiple meshes by connected
// component (Union-Find over shared vertices). The input is the result of an
// STLLoader parse which is non-indexed.
function splitGeometryIntoParts(geometry) {
  const assembly = new THREE.Group();
  const indexedGeom = indexGeometry(geometry);
  const pos = indexedGeom.getAttribute("position");
  const index = indexedGeom.getIndex();
  const triangleCount = index.count / 3;

  // Cap component-splitting cost: very large meshes are unlikely to be useful
  // assemblies; treat them as a single object.
  if (triangleCount > 250000) {
    indexedGeom.computeVertexNormals();
    assembly.add(makePartMesh(indexedGeom));
    return assembly;
  }

  // Union-find over vertex indices via shared edges of triangles
  const parent = new Int32Array(pos.count);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  for (let t = 0; t < triangleCount; t++) {
    const a = index.getX(t * 3);
    const b = index.getX(t * 3 + 1);
    const c = index.getX(t * 3 + 2);
    union(a, b);
    union(b, c);
  }

  // Group triangles by root vertex
  const triByRoot = new Map();
  for (let t = 0; t < triangleCount; t++) {
    const root = find(index.getX(t * 3));
    let list = triByRoot.get(root);
    if (!list) {
      list = [];
      triByRoot.set(root, list);
    }
    list.push(t);
  }

  // If everything is one component we still return a group with one child
  for (const tris of triByRoot.values()) {
    const sub = buildSubGeometry(indexedGeom, tris);
    sub.computeVertexNormals();
    assembly.add(makePartMesh(sub));
  }
  return assembly;
}

// Convert non-indexed -> indexed geometry by merging duplicate vertices
// (with a tight tolerance) so that connected components can be detected.
function indexGeometry(geometry) {
  if (geometry.getIndex()) return geometry.clone();
  const pos = geometry.getAttribute("position");
  const tol = 1e-4;
  const map = new Map();
  const newPositions = [];
  const indices = [];
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const key =
      Math.round(v.x / tol) +
      "," +
      Math.round(v.y / tol) +
      "," +
      Math.round(v.z / tol);
    let idx = map.get(key);
    if (idx === undefined) {
      idx = newPositions.length / 3;
      newPositions.push(v.x, v.y, v.z);
      map.set(key, idx);
    }
    indices.push(idx);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(newPositions, 3),
  );
  g.setIndex(indices);
  return g;
}

function buildSubGeometry(source, triIndices) {
  const srcPos = source.getAttribute("position");
  const srcIdx = source.getIndex();
  const used = new Map();
  const newPositions = [];
  const newIndices = [];
  for (const t of triIndices) {
    for (let k = 0; k < 3; k++) {
      const idx = srcIdx.getX(t * 3 + k);
      let mapped = used.get(idx);
      if (mapped === undefined) {
        mapped = newPositions.length / 3;
        newPositions.push(
          srcPos.getX(idx),
          srcPos.getY(idx),
          srcPos.getZ(idx),
        );
        used.set(idx, mapped);
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
// Uses occt-import-js (OpenCascade compiled to WASM) loaded on-demand from a
// CDN. The library is large (~5 MB) so we only fetch it when a STEP file is
// uploaded. occt-import-js publishes a UMD bundle, so we inject it via a
// <script> tag and read the global it exposes.
let occtPromise = null;
function loadOcct() {
  if (occtPromise) return occtPromise;
  const base = "https://cdn.jsdelivr.net/npm/occt-import-js@0.0.22/dist/";
  occtPromise = new Promise((resolve, reject) => {
    const finish = () => {
      const factory = window.occtimportjs;
      if (!factory) {
        reject(new Error("occt-import-js loaded but global is missing"));
        return;
      }
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

async function parseStepFile(file, onProgress) {
  let occt;
  try {
    occt = await loadOcct();
  } catch (e) {
    throw new Error(
      "STEP files require the OpenCascade WASM module, which failed to load. " +
        "Check your network connection and try again, or export your CAD as STL/OBJ.",
    );
  }
  onProgress?.("Tessellating STEP geometry");
  const buffer = new Uint8Array(await file.arrayBuffer());
  const result = occt.ReadStepFile(buffer, null);
  if (!result || !result.success) {
    throw new Error("Could not parse STEP file");
  }

  const assembly = new THREE.Group();
  for (const m of result.meshes || []) {
    const positions = new Float32Array(m.attributes.position.array);
    const normals = m.attributes.normal
      ? new Float32Array(m.attributes.normal.array)
      : null;
    const indices = m.index ? new Uint32Array(m.index.array) : null;

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    if (normals) g.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    if (indices) g.setIndex(new THREE.BufferAttribute(indices, 1));
    if (!normals) g.computeVertexNormals();

    const mesh = makePartMesh(g);
    if (m.name) mesh.userData.sourceName = m.name;
    assembly.add(mesh);
  }
  return assembly;
}
