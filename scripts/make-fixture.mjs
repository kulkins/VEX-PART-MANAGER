// Generate a synthetic STL fixture that contains geometry roughly matching
// common VEX parts (a 1x2x35 c-channel, a few standoffs, a shaft, and a
// 36-tooth gear cylinder). Used by the end-to-end smoke test.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(__dirname, "..", "fixtures", "sample.stl");

// We build an ASCII STL with multiple disconnected meshes so the parser can
// split them into components. All dimensions are in inches.

function box(cx, cy, cz, sx, sy, sz) {
  const x0 = cx - sx / 2, x1 = cx + sx / 2;
  const y0 = cy - sy / 2, y1 = cy + sy / 2;
  const z0 = cz - sz / 2, z1 = cz + sz / 2;
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  // 12 triangles
  const f = [
    [0, 2, 1], [0, 3, 2], // bottom
    [4, 5, 6], [4, 6, 7], // top
    [0, 1, 5], [0, 5, 4], // front
    [2, 3, 7], [2, 7, 6], // back
    [1, 2, 6], [1, 6, 5], // right
    [0, 4, 7], [0, 7, 3], // left
  ];
  return f.map(([a, b, c]) => [v[a], v[b], v[c]]);
}

function cylinder(cx, cy, cz, radius, height, segments = 32, axis = "y") {
  const tris = [];
  const h2 = height / 2;
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const c0 = Math.cos(a0) * radius, s0 = Math.sin(a0) * radius;
    const c1 = Math.cos(a1) * radius, s1 = Math.sin(a1) * radius;
    let p = (cc, ss, dh) => {
      if (axis === "y") return [cx + cc, cy + dh, cz + ss];
      if (axis === "x") return [cx + dh, cy + cc, cz + ss];
      return [cx + cc, cy + ss, cz + dh];
    };
    const bot0 = p(c0, s0, -h2), bot1 = p(c1, s1, -h2);
    const top0 = p(c0, s0, h2), top1 = p(c1, s1, h2);
    const centerB = p(0, 0, -h2), centerT = p(0, 0, h2);
    tris.push([bot0, bot1, top1]);
    tris.push([bot0, top1, top0]);
    tris.push([centerB, bot1, bot0]);
    tris.push([centerT, top0, top1]);
  }
  return tris;
}

function trisToStl(name, tris) {
  let s = `solid ${name}\n`;
  for (const t of tris) {
    s += "facet normal 0 0 0\n  outer loop\n";
    for (const v of t) s += `    vertex ${v[0]} ${v[1]} ${v[2]}\n`;
    s += "  endloop\nendfacet\n";
  }
  s += `endsolid ${name}\n`;
  return s;
}

const parts = [];

// 1x2x35 c-channel: 0.5" tall, 1.0" wide, 17.5" long (35 holes)
parts.push({ name: "cchannel-1x2", tris: box(0, 0, 0, 17.5, 0.5, 1.0) });

// Square shaft 1/8", length 6"
parts.push({ name: "shaft-1-8", tris: box(0, 1.5, 0, 6.0, 0.125, 0.125) });

// Standoffs (cylinders): 1" long, ~0.27" diameter (apothem of hex roughly)
for (let i = 0; i < 4; i++) {
  parts.push({
    name: `standoff-${i}`,
    tris: cylinder(i * 1.5 - 2.25, -1.5, 0, 0.135, 1.0, 12, "y"),
  });
}

// 36-tooth gear: disc, ~1.7" diameter, 0.25" thick
parts.push({
  name: "gear-36",
  tris: cylinder(5, 0, 3, 0.85, 0.25, 24, "z"),
});

// Spacer: small cylinder 0.25" long, ~0.18" diameter
parts.push({
  name: "spacer-1",
  tris: cylinder(-3, 0.5, 2, 0.09, 0.25, 12, "y"),
});

let stl = "";
for (const p of parts) stl += trisToStl(p.name, p.tris);

await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, stl);
console.log(`Wrote ${out} (${stl.length} bytes, ${parts.length} parts)`);
