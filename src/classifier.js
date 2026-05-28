import * as THREE from "three";
import { PARTS, CATEGORIES } from "./partsdb.js";

// Convert raw scene units into inches. VEX parts profiles in partsdb.js are
// expressed in inches.
const UNIT_TO_INCH = {
  in: 1,
  mm: 1 / 25.4,
  cm: 1 / 2.54,
  m: 1000 / 25.4,
  unknown: 1,
};

// Compute per-mesh geometric features used by the heuristic classifier.
// Returns: { dims: [w, h, d] in inches sorted desc, volume, surfaceArea,
//   cylindricity, discness, center }.
function computeFeatures(mesh, unitsScale) {
  const geom = mesh.geometry;
  if (!geom.boundingBox) geom.computeBoundingBox();
  const bb = geom.boundingBox.clone();
  const size = bb.getSize(new THREE.Vector3());
  const center = bb.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);
  const dims = [size.x, size.y, size.z]
    .map((v) => v * unitsScale)
    .sort((a, b) => b - a); // largest first

  // Volume of bounding box and triangle mesh
  const bboxVolume = dims[0] * dims[1] * dims[2];

  let meshVolume = 0;
  let surfaceArea = 0;
  const pos = geom.getAttribute("position");
  const idx = geom.getIndex();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const tCount = idx ? idx.count / 3 : pos.count / 3;
  const getVert = (t, k, target) => {
    if (idx) target.fromBufferAttribute(pos, idx.getX(t * 3 + k));
    else target.fromBufferAttribute(pos, t * 3 + k);
  };
  // Sample up to ~40k tris for very dense meshes to keep classification fast.
  const step = Math.max(1, Math.floor(tCount / 40000));
  for (let t = 0; t < tCount; t += step) {
    getVert(t, 0, a);
    getVert(t, 1, b);
    getVert(t, 2, c);
    meshVolume += a.dot(b.clone().cross(c)) / 6;
    surfaceArea += b.clone().sub(a).cross(c.clone().sub(a)).length() / 2;
  }
  meshVolume = Math.abs(meshVolume) * unitsScale ** 3;
  surfaceArea *= unitsScale ** 2;

  // Cylindricity: bounding-box "tubeness" — two similar dimensions and one long.
  const [L, M, S] = dims;
  const tubeness =
    M > 0 && L > 0
      ? Math.max(0, 1 - Math.abs(M - S) / Math.max(M, 1e-6)) *
        Math.max(0, Math.min(1, (L - M) / Math.max(M, 1e-6)))
      : 0;

  // Discness: two similar large dims, one small dim — gears, wheels.
  const discness =
    L > 0 && M > 0
      ? Math.max(0, 1 - Math.abs(L - M) / Math.max(L, 1e-6)) *
        Math.max(0, Math.min(1, (M - S) / Math.max(S, 1e-6)))
      : 0;

  // Elongation: c-channels, plates
  const elongation = L > 0 ? L / Math.max(M, 1e-6) : 0;

  // Volume fill: mesh volume / bbox volume. Low values indicate a hollow or
  // thin profile (c-channel, plate). High values indicate a solid block.
  const fill =
    bboxVolume > 1e-9 ? Math.min(1, meshVolume / bboxVolume) : 0;

  return {
    dims,
    bboxVolume,
    meshVolume,
    surfaceArea,
    tubeness,
    discness,
    elongation,
    fill,
    center,
  };
}

// Score how well `part`'s inchProfile matches `features.dims`.
function profileMatch(profile, dims) {
  if (!profile) return 0;
  const [L, M, S] = dims;
  const fit = (range, v) => {
    if (!range) return 1;
    if (v >= range[0] && v <= range[1]) return 1;
    const target = (range[0] + range[1]) / 2;
    const span = (range[1] - range[0]) / 2 || target;
    const dist = Math.abs(v - target);
    return Math.max(0, 1 - dist / (span * 2));
  };
  // long dim against `long`, mid against `mid`, minor against `minor`
  return fit(profile.long, L) * fit(profile.mid, M) * fit(profile.minor, S);
}

function scorePart(part, f) {
  let s = profileMatch(part.inchProfile, f.dims);
  if (part.isDisc) s *= 0.4 + 0.6 * f.discness;
  if (part.isCylinder) s *= 0.4 + 0.6 * f.tubeness;
  // Penalize tiny scores so we don't snap unidentified bits to random parts.
  return s;
}

export async function classifyAssembly(assembly, units, { onProgress } = {}) {
  const unitsScale = UNIT_TO_INCH[units] ?? 1;
  const results = [];
  const meshes = [];
  assembly.traverse((c) => { if (c.isMesh) meshes.push(c); });

  const t0 = performance.now();
  const yieldEvery = Math.max(16, Math.floor(meshes.length / 12));

  for (let i = 0; i < meshes.length; i++) {
    const c = meshes[i];
    const features = computeFeatures(c, unitsScale);

    let bestPart = null;
    let bestScore = 0;
    for (const p of PARTS) {
      const score = scorePart(p, features);
      if (score > bestScore) {
        bestScore = score;
        bestPart = p;
      }
    }

    const confident = bestScore >= 0.45;
    const partRef = confident ? bestPart : null;
    const categoryId = partRef ? partRef.category : "unknown";

    c.userData.features = features;
    c.userData.partId = partRef?.id ?? null;
    c.userData.partName = partRef?.name ?? describeUnknown(features);
    c.userData.category = categoryId;
    c.userData.confidence = bestScore;

    results.push({
      mesh: c,
      features,
      part: partRef,
      categoryId,
      confidence: bestScore,
    });

    if (i > 0 && i % yieldEvery === 0) {
      onProgress?.(`Classifying ${i} / ${meshes.length}`);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  console.log(
    `[classifier] ${meshes.length} parts in ${((performance.now() - t0) / 1000).toFixed(2)}s`,
  );

  // Group identical parts: same part id => same line item with quantity.
  const items = new Map();
  for (const r of results) {
    const key = r.part ? r.part.id : `unknown:${quantizeDims(r.features.dims)}`;
    let entry = items.get(key);
    if (!entry) {
      entry = {
        key,
        part: r.part,
        categoryId: r.categoryId,
        name: r.part?.name ?? r.mesh.userData.partName,
        meshes: [],
        avgConfidence: 0,
        sampleFeatures: r.features,
      };
      items.set(key, entry);
    }
    entry.meshes.push(r.mesh);
    entry.avgConfidence += r.confidence;
  }
  for (const e of items.values()) {
    e.quantity = e.meshes.length;
    e.avgConfidence /= e.quantity;
  }

  // Group line items by category
  const byCategory = new Map();
  for (const id of Object.keys(CATEGORIES)) byCategory.set(id, []);
  for (const item of items.values()) {
    byCategory.get(item.categoryId)?.push(item);
  }
  for (const list of byCategory.values()) {
    list.sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name));
  }

  return { items: [...items.values()], byCategory };
}

function quantizeDims(dims) {
  return dims.map((d) => Math.round(d * 4) / 4).join("x");
}

function describeUnknown(f) {
  const [L, M, S] = f.dims;
  const fmt = (n) => (n >= 1 ? n.toFixed(2) : n.toFixed(3));
  return `Unidentified part (${fmt(L)} × ${fmt(M)} × ${fmt(S)} in)`;
}
