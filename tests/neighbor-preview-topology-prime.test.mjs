import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const previewModule = await import("../public/client/hex-neighbor-preview.js");
const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

const payload = {
  chunks: [
    { regionId: "garden-1", axial: { q: 0, r: 0 }, physicalOrigin: { x: 0, y: 0 }, hexOrigin: { x: 0, y: 0 } },
    { regionId: "garden-2", axial: { q: 1, r: 0 }, physicalOrigin: { x: 40, y: 0 }, hexOrigin: { x: 20.78, y: 0 } },
  ],
};

test("terrain window can prime neighbor topology without another meta fetch", () => {
  assert.equal(typeof previewModule.primeHexNeighborTopology, "function");
  const topology = previewModule.primeHexNeighborTopology(payload, "garden-1");
  assert.deepEqual(topology.map((entry) => entry.id), ["garden-1", "garden-2"]);
  assert.deepEqual(topology[1].hexOrigin, { x: 20.78, y: 0 });
});
test("neighbor preview primes loaded topology before reconstruction", () => {
  const start = appSource.indexOf("function buildNeighborPreview");
  const end = appSource.indexOf("async function loadTerrainWindow", start);
  const body = appSource.slice(start, end);
  const prime = body.indexOf("moyo:neighbor-topology");
  const mark = body.indexOf("view.markShadowsDirty()");
  assert.ok(prime >= 0, "loaded window topology must be published before preview reconstruction");
  assert.ok(mark > prime, "topology must be primed before the hex preview patch runs");
});
