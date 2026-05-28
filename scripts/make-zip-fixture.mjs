// Generate a synthetic ZIP fixture containing many small binary-STL "parts"
// to benchmark the ZIP fast-path. Not used by automated tests; runs locally
// when investigating performance regressions.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(__dirname, "..", "fixtures", "assembly.zip");

function box(cx, cy, cz, sx, sy, sz) {
  const x0 = cx - sx / 2,
    x1 = cx + sx / 2;
  const y0 = cy - sy / 2,
    y1 = cy + sy / 2;
  const z0 = cz - sz / 2,
    z1 = cz + sz / 2;
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const f = [
    [0, 2, 1], [0, 3, 2],
    [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4],
    [2, 3, 7], [2, 7, 6],
    [1, 2, 6], [1, 6, 5],
    [0, 4, 7], [0, 7, 3],
  ];
  return f.map(([a, b, c]) => [v[a], v[b], v[c]]);
}

function binStl(tris) {
  // 80-byte header + uint32 count + tri * 50 bytes
  const buf = Buffer.alloc(84 + tris.length * 50);
  buf.writeUInt32LE(tris.length, 80);
  let off = 84;
  for (const t of tris) {
    off += 12; // normal
    for (const v of t) {
      buf.writeFloatLE(v[0], off); off += 4;
      buf.writeFloatLE(v[1], off); off += 4;
      buf.writeFloatLE(v[2], off); off += 4;
    }
    off += 2;
  }
  return buf;
}

// Minimal zip writer — stored (no compression) for simplicity.
function writeZip(files) {
  const records = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = zlib.crc32 ? zlib.crc32(data) : require("zlib").crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version
    local.writeUInt16LE(0, 6);           // flags
    local.writeUInt16LE(0, 8);           // method = store
    local.writeUInt32LE(0, 10);          // mtime/mdate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    records.push(local, data);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8); cd.writeUInt16LE(0, 10);
    cd.writeUInt32LE(0, 12);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34); cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    central.push(cd);

    offset += local.length + data.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const c of central) cdSize += c.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([...records, ...central, end]);
}

const files = [];
const partCount = Number(process.argv[2]) || 200;
const subdiv = Number(process.argv[3]) || 1; // 1 = box (12 tris), N = tessellated sphere

function sphereTris(cx, cy, cz, r, latSeg, lonSeg) {
  const tris = [];
  for (let i = 0; i < latSeg; i++) {
    const lat1 = (Math.PI * i) / latSeg - Math.PI / 2;
    const lat2 = (Math.PI * (i + 1)) / latSeg - Math.PI / 2;
    for (let j = 0; j < lonSeg; j++) {
      const lon1 = (2 * Math.PI * j) / lonSeg;
      const lon2 = (2 * Math.PI * (j + 1)) / lonSeg;
      const p = (lat, lon) => [
        cx + r * Math.cos(lat) * Math.cos(lon),
        cy + r * Math.sin(lat),
        cz + r * Math.cos(lat) * Math.sin(lon),
      ];
      const a = p(lat1, lon1), b = p(lat2, lon1);
      const c = p(lat2, lon2), d = p(lat1, lon2);
      tris.push([a, b, c]);
      tris.push([a, c, d]);
    }
  }
  return tris;
}

for (let i = 0; i < partCount; i++) {
  // mix small parts: standoffs, screws, c-channels
  let tris;
  if (subdiv > 1) {
    // Heavy tessellation: a sphere with many segments per part. This
    // simulates Onshape's "Fine" STL export of a curved component.
    tris = sphereTris(0, 0, 0, 1.0, subdiv, subdiv * 2);
  } else if (i % 4 === 0) tris = box(0, 0, 0, 17.5, 0.5, 1.0);
  else if (i % 4 === 1) tris = box(0, 0, 0, 0.125, 0.125, 6.0);
  else if (i % 4 === 2) tris = box(0, 0, 0, 0.27, 1.0, 0.27);
  else tris = box(0, 0, 0, 0.85, 0.25, 0.85);
  files.push({ name: `Part-${String(i + 1).padStart(3, "0")}.stl`, data: binStl(tris) });
}

await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, writeZip(files));
console.log(
  `Wrote ${out} (${files.length} STL parts, ${(((await fs.stat(out)).size) / 1024).toFixed(1)} KB)`,
);
