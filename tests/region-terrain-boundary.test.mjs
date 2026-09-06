import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { hexCellRadius, hexTileWorldXZ, isHexGridCell } from "../public/client/hex-grid.js";
import { regularHexFootprintSize } from "../public/client/hex-footprint.js";
import { buildWeldedHexSurface, terrainVertexKey } from "../public/client/terrain-stitch.js";

function activeEntries(width, height) {
  const entries = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const tile = { x, y };
      if (!isHexGridCell(tile, width, height)) continue;
      const point = hexTileWorldXZ(tile, width, height);
      entries.push({ x: point.x, z: point.z, height: 0.2 + (x + y) * 0.001, color: { r: 0.4, g: 0.5, b: 0.3 } });
    }
  }
  return entries;
}

function surfaceKeys(surface, offsetX = 0, offsetZ = 0) {
  const keys = new Set();
  for (let index = 0; index < surface.positions.length; index += 3) {
    keys.add(terrainVertexKey(surface.positions[index] + offsetX, surface.positions[index + 2] + offsetZ));
  }
  return keys;
}

function sharedCount(left, right) {
  let count = 0;
  for (const key of left) if (right.has(key)) count += 1;
  return count;
}

test("welded local terrain reaches the exact regular-hex footprint on every axis", () => {
  const width = 40;
  const height = 24;
  const footprint = regularHexFootprintSize(width, height);
  const surface = buildWeldedHexSurface(
    activeEntries(width, height),
    hexCellRadius(width, height),
    { footprintWidth: width, footprintHeight: height },
  );
  const xs = [];
  const zs = [];
  for (let index = 0; index < surface.positions.length; index += 3) {
    xs.push(surface.positions[index]);
    zs.push(surface.positions[index + 2]);
  }
  assert.ok(Math.abs(Math.max(...xs) - footprint.width / 2) < 1e-6);
  assert.ok(Math.abs(Math.min(...xs) + footprint.width / 2) < 1e-6);
  assert.ok(Math.abs(Math.max(...zs) - footprint.height / 2) < 1e-6);
  assert.ok(Math.abs(Math.min(...zs) + footprint.height / 2) < 1e-6);
});

test("all six adjacent region placements share real world-space boundary vertices", () => {
  const width = 40;
  const height = 24;
  const footprint = regularHexFootprintSize(width, height);
  const surface = buildWeldedHexSurface(
    activeEntries(width, height),
    hexCellRadius(width, height),
    { footprintWidth: width, footprintHeight: height },
  );
  const center = surfaceKeys(surface);
  const offsets = [
    [footprint.width, 0],
    [footprint.width / 2, -footprint.height * 0.75],
    [-footprint.width / 2, -footprint.height * 0.75],
    [-footprint.width, 0],
    [-footprint.width / 2, footprint.height * 0.75],
    [footprint.width / 2, footprint.height * 0.75],
  ];
  for (const [offsetX, offsetZ] of offsets) {
    const neighbor = surfaceKeys(surface, offsetX, offsetZ);
    assert.ok(sharedCount(center, neighbor) >= 3, `region offset ${offsetX},${offsetZ} lacks welded boundary vertices`);
  }
});

test("CPU-conformed welded terrain bypasses GPU hex clipping", async () => {
  const source = await readFile(new URL("../public/client/hex-footprint-rendering.js", import.meta.url), "utf8");
  assert.match(source, /moyoWeldedHexSurface/);
  assert.match(source, /continue|return/);
});
