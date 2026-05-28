// Geometry optimization: simplification (vertex clustering) and
// deduplication (share BufferGeometry across identical parts).
//
// These two passes turn an expensive multi-hundred-part STL ZIP into
// something modest GPU drivers can render comfortably. Vertex clustering
// is the classic Rossignac/Borrel algorithm: voxelize the bounding box,
// snap each vertex to the centroid of its cell, drop degenerate triangles.
// Cheap, robust, and visually decent for the kinds of parts found in
// VEX assemblies (mostly flat surfaces with a few rounded features).

import * as THREE from "three";

// Quality presets. The number is the maximum triangle count we'll allow per
// individual part — meshes denser than this get simplified down.
export const QUALITY = {
  high:   { perPart: Infinity,  cluster: Infinity, label: "High" },
  medium: { perPart: 6000,      cluster: 64,       label: "Medium" },
  low:    { perPart: 2000,      cluster: 36,       label: "Low" },
};

// Pick a sensible default based on how many parts we're loading. Big
// assemblies need aggressive simplification.
export function autoQuality(partCount, totalTri) {
  if (partCount <= 40 && totalTri <= 400_000) return "high";
  if (partCount <= 200 && totalTri <= 1_500_000) return "medium";
  return "low";
}

// Simplify a geometry using vertex clustering.
//
// gridSize: number of cells per axis (so total cells = gridSize^3, but most
// cells are empty for a typical thin VEX part).
//
// Returns the same geometry if it's already below the target, or a new
// BufferGeometry if simplification was applied.
export function simplifyGeometry(geometry, gridSize) {
  if (!geometry || !geometry.getAttribute("position")) return geometry;
  if (gridSize === Infinity || gridSize <= 0) return geometry;

  const pos = geometry.getAttribute("position");
  const idx = geometry.getIndex();
  const triCount = idx ? idx.count / 3 : pos.count / 3;
  if (triCount < 200) return geometry; // not worth it

  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const sx = (bb.max.x - bb.min.x) || 1e-6;
  const sy = (bb.max.y - bb.min.y) || 1e-6;
  const sz = (bb.max.z - bb.min.z) || 1e-6;
  const cellX = sx / gridSize;
  const cellY = sy / gridSize;
  const cellZ = sz / gridSize;
  const minX = bb.min.x, minY = bb.min.y, minZ = bb.min.z;

  // Map each old vertex to its cell. Cells are keyed by packing the cell
  // coords into a 32-bit integer (works as long as gridSize <= 1024).
  const G = Math.max(2, Math.min(1024, Math.floor(gridSize)));
  const cellOf = new Int32Array(pos.count);
  const cellToNew = new Map();
  const sumX = []; const sumY = []; const sumZ = []; const cnt = [];

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let cx = Math.floor((x - minX) / cellX); if (cx >= G) cx = G - 1; if (cx < 0) cx = 0;
    let cy = Math.floor((y - minY) / cellY); if (cy >= G) cy = G - 1; if (cy < 0) cy = 0;
    let cz = Math.floor((z - minZ) / cellZ); if (cz >= G) cz = G - 1; if (cz < 0) cz = 0;
    const key = (cx * G + cy) * G + cz;

    let newIdx = cellToNew.get(key);
    if (newIdx === undefined) {
      newIdx = sumX.length;
      cellToNew.set(key, newIdx);
      sumX.push(0); sumY.push(0); sumZ.push(0); cnt.push(0);
    }
    sumX[newIdx] += x;
    sumY[newIdx] += y;
    sumZ[newIdx] += z;
    cnt[newIdx] += 1;
    cellOf[i] = newIdx;
  }

  const newPositions = new Float32Array(sumX.length * 3);
  for (let i = 0; i < sumX.length; i++) {
    newPositions[i * 3]     = sumX[i] / cnt[i];
    newPositions[i * 3 + 1] = sumY[i] / cnt[i];
    newPositions[i * 3 + 2] = sumZ[i] / cnt[i];
  }

  // Remap triangles, drop degenerate ones (those whose three corner cells
  // collapsed to one or two distinct vertices).
  const newIndices = [];
  for (let t = 0; t < triCount; t++) {
    const i0 = idx ? idx.getX(t * 3)     : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    const a = cellOf[i0], b = cellOf[i1], c = cellOf[i2];
    if (a === b || b === c || a === c) continue;
    newIndices.push(a, b, c);
  }

  // If simplification didn't actually buy us anything, keep the original
  // (computeVertexNormals is cheap so this isn't a big deal either way).
  if (newIndices.length / 3 >= triCount * 0.9) return geometry;

  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(newPositions, 3));
  out.setIndex(newIndices);
  out.computeVertexNormals();
  out.computeBoundingBox();
  return out;
}

// Group meshes by geometric content (after centering each part to its own
// bbox center, so two identical parts at different world locations dedupe
// to the same canonical geometry). Each duplicate is replaced with a Mesh
// that points to the shared BufferGeometry and offsets itself by .position.
// Returns { uniqueCount, totalCount, savedTris }.
export function dedupeGeometries(meshes) {
  const buckets = new Map();
  let totalTris = 0;
  for (const m of meshes) {
    const pos = m.geometry.getAttribute("position");
    const idx = m.geometry.getIndex();
    const tris = idx ? idx.count / 3 : pos.count / 3;
    totalTris += tris;
    const sig = signatureOf(m.geometry);
    let arr = buckets.get(sig);
    if (!arr) { arr = []; buckets.set(sig, arr); }
    arr.push(m);
  }

  let uniqueCount = 0;
  let savedTris = 0;
  for (const list of buckets.values()) {
    uniqueCount++;
    if (list.length === 1) continue;
    // Pick the first as canonical. Center its geometry to origin.
    const canonical = list[0];
    const centered = centerGeometry(canonical.geometry);
    const center0 = centered.center;
    canonical.geometry.dispose();
    canonical.geometry = centered.geom;
    canonical.position.copy(center0);

    for (let i = 1; i < list.length; i++) {
      const m = list[i];
      const c = computeBboxCenter(m.geometry);
      const triCount =
        m.geometry.getIndex()
          ? m.geometry.getIndex().count / 3
          : m.geometry.getAttribute("position").count / 3;
      savedTris += triCount;
      m.geometry.dispose();
      m.geometry = centered.geom; // shared reference
      m.position.copy(c);
    }
  }

  return { uniqueCount, totalCount: meshes.length, savedTris, totalTris };
}

// Return a string signature that uniquely identifies the shape of a
// geometry up to a translation. Two meshes that differ only by world
// position get the same signature. Combines triangle count, centered
// bounding-box dimensions, and a hash of a sample of centered vertices.
function signatureOf(geometry) {
  const pos = geometry.getAttribute("position");
  const idx = geometry.getIndex();
  const tris = idx ? idx.count / 3 : pos.count / 3;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const sx = (bb.max.x - bb.min.x);
  const sy = (bb.max.y - bb.min.y);
  const sz = (bb.max.z - bb.min.z);
  const cx = (bb.max.x + bb.min.x) * 0.5;
  const cy = (bb.max.y + bb.min.y) * 0.5;
  const cz = (bb.max.z + bb.min.z) * 0.5;

  const q = (v) => Math.round(v * 10000); // 4-decimal quantization
  const sortedDims = [q(sx), q(sy), q(sz)].sort((a, b) => a - b);

  // FNV-1a hash of centered+quantized positions, sampled to keep the cost
  // bounded for huge meshes.
  let h = 2166136261 >>> 0;
  const step = Math.max(1, Math.floor(pos.count / 64));
  for (let i = 0; i < pos.count; i += step) {
    const x = q(pos.getX(i) - cx);
    const y = q(pos.getY(i) - cy);
    const z = q(pos.getZ(i) - cz);
    h = Math.imul(h ^ (x | 0), 16777619) >>> 0;
    h = Math.imul(h ^ (y | 0), 16777619) >>> 0;
    h = Math.imul(h ^ (z | 0), 16777619) >>> 0;
  }
  return `${pos.count}:${tris}:${sortedDims.join("x")}:${h.toString(16)}`;
}

function centerGeometry(geometry) {
  const pos = geometry.getAttribute("position");
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const cx = (bb.max.x + bb.min.x) * 0.5;
  const cy = (bb.max.y + bb.min.y) * 0.5;
  const cz = (bb.max.z + bb.min.z) * 0.5;
  const arr = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    arr[i * 3]     = pos.getX(i) - cx;
    arr[i * 3 + 1] = pos.getY(i) - cy;
    arr[i * 3 + 2] = pos.getZ(i) - cz;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  const oldIdx = geometry.getIndex();
  if (oldIdx) g.setIndex(oldIdx.clone());
  g.computeVertexNormals();
  g.computeBoundingBox();
  return { geom: g, center: new THREE.Vector3(cx, cy, cz) };
}

function computeBboxCenter(geometry) {
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  return new THREE.Vector3(
    (bb.max.x + bb.min.x) * 0.5,
    (bb.max.y + bb.min.y) * 0.5,
    (bb.max.z + bb.min.z) * 0.5,
  );
}
