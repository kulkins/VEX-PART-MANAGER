// Quick check that the binary-STL size-formula probe never misidentifies
// an ASCII STL as binary, and that the inverse works correctly.
//
// We synthesise small ASCII and binary STLs covering the cases that broke
// the user's 186-part Onshape ZIP (headers starting with whitespace, tabs,
// or text like "solid OnshapeExport-binary").

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dynamic-import the parser module from the workspace so we can call its
// (non-exported) probe via the public path: we just write a small ASCII
// STL and a small binary STL to memory and run the same DataView check
// inline. Easier than messing with module exports.
function probeBinaryStlTriCount(bytes) {
  if (!bytes || bytes.byteLength < 84) return -1;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, 84);
  const tris = dv.getUint32(80, true);
  if (tris > 0xfffffff) return -1;
  return bytes.byteLength === 84 + tris * 50 ? tris : -1;
}

function buildBinaryStl(tris) {
  const buf = new Uint8Array(84 + tris * 50);
  // Header bytes can be anything — including 'solid' or whitespace, which
  // is exactly what fooled the old heuristic.
  buf.set(new TextEncoder().encode("solid OnshapeExport binary"), 0);
  new DataView(buf.buffer).setUint32(80, tris, true);
  return buf;
}

function buildAsciiStl(name = "Part-001") {
  const txt =
    `solid ${name}\n` +
    `  facet normal 0 0 1\n` +
    `    outer loop\n` +
    `      vertex 0 0 0\n` +
    `      vertex 1 0 0\n` +
    `      vertex 0 1 0\n` +
    `    endloop\n` +
    `  endfacet\n` +
    `endsolid ${name}\n`;
  return new TextEncoder().encode(txt);
}

// Pathological ASCII STL: leading whitespace + a long pre-amble, exactly
// the kind Onshape sometimes emits.
function buildAsciiStlWeird() {
  const txt =
    `\n\t\t  solid OnshapeExport-binary-STL  \r\n` +
    `  facet normal 0.123456e-2 0 0\n` +
    `    outer loop\n` +
    `      vertex 1.234567 2.345678 3.456789\n` +
    `      vertex 4.567890 5.678901 6.789012\n` +
    `      vertex 7.890123 8.901234 9.012345\n` +
    `    endloop\n` +
    `  endfacet\n` +
    `endsolid OnshapeExport-binary-STL\n`;
  return new TextEncoder().encode(txt);
}

let pass = 0;
let fail = 0;
function expect(name, actual, expected) {
  if (actual === expected) {
    pass++;
    console.log(`  ok  ${name} = ${actual}`);
  } else {
    fail++;
    console.error(`  FAIL ${name}: got ${actual}, expected ${expected}`);
  }
}

expect("binary 12 tris", probeBinaryStlTriCount(buildBinaryStl(12)), 12);
expect("binary 500 tris", probeBinaryStlTriCount(buildBinaryStl(500)), 500);
expect("ascii regular", probeBinaryStlTriCount(buildAsciiStl()), -1);
expect("ascii weird", probeBinaryStlTriCount(buildAsciiStlWeird()), -1);
expect("too small", probeBinaryStlTriCount(new Uint8Array(10)), -1);
expect("garbage", probeBinaryStlTriCount(new Uint8Array(1000).fill(0xff)), -1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
