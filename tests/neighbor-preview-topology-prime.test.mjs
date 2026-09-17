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

test("neighbor topology retry delay is bounded exponential backoff", () => {
  assert.equal(previewModule.neighborTopologyRetryDelay(1), 1_000);
  assert.equal(previewModule.neighborTopologyRetryDelay(2), 2_000);
  assert.equal(previewModule.neighborTopologyRetryDelay(3), 4_000);
  assert.equal(previewModule.neighborTopologyRetryDelay(4), 8_000);
  assert.equal(previewModule.neighborTopologyRetryDelay(5), 15_000);
  assert.equal(previewModule.neighborTopologyRetryDelay(99), 15_000);
});

test("failed or empty neighbor topology fetches back off while a new center can retry immediately", async (t) => {
  const hadLocation = Object.prototype.hasOwnProperty.call(globalThis, "location");
  const originalLocation = globalThis.location;
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (hadLocation) globalThis.location = originalLocation;
    else delete globalThis.location;
  });

  globalThis.location = { protocol: "https:" };
  let fetchCalls = 0;
  let emptyResponse = false;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (emptyResponse) {
      return new Response(JSON.stringify({ world: { regionTopology: { regions: [] } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("unavailable", { status: 503 });
  };

  assert.deepEqual(await previewModule.ensureHexNeighborTopology("hex-q9-r9"), []);
  assert.deepEqual(await previewModule.ensureHexNeighborTopology("hex-q9-r9"), []);
  assert.equal(fetchCalls, 1, "repeated shadow-dirty work must not refetch during the failure backoff");

  assert.deepEqual(await previewModule.ensureHexNeighborTopology("hex-q8-r8"), []);
  assert.equal(fetchCalls, 2, "moving to a new center must bypass the old center's backoff");

  emptyResponse = true;
  assert.deepEqual(await previewModule.ensureHexNeighborTopology("hex-q7-r7"), []);
  assert.deepEqual(await previewModule.ensureHexNeighborTopology("hex-q7-r7"), []);
  assert.equal(fetchCalls, 3, "an empty topology is unusable and should enter the same bounded backoff");
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
