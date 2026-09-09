import assert from "node:assert/strict";
import test from "node:test";
import worker from "../dist-ts/src/worker-entry.js";

function snapshot(regionId) {
  return {
    regionId,
    width: 40,
    height: 24,
    tick: 12,
    revision: 12,
    tiles: [],
    agents: [],
    structures: [],
  };
}

function envWithTransportFailure(failedRegion) {
  return {
    REGION_IDS: "garden-1,garden-2,garden-3",
    REGIONS: {
      idFromName: (name) => name,
      get: (regionId) => ({
        fetch: async () => {
          if (regionId === failedRegion) {
            throw new Error(`simulated snapshot transport failure for ${regionId}`);
          }
          return new Response(JSON.stringify(snapshot(regionId)), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      }),
    },
    ASSETS: { fetch: async () => new Response("unused") },
  };
}

test("one neighbor transport failure stays an error chunk instead of aborting the live window", async () => {
  const response = await worker.fetch(
    new Request("https://moyo.example/api/world/window?region=garden-1&radius=1&live=1"),
    envWithTransportFailure("garden-2"),
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.chunks.length, 7);

  const failed = payload.chunks.find((chunk) => chunk.regionId === "garden-2");
  assert.ok(failed);
  assert.equal(failed.error, "snapshot HTTP 503");
  assert.equal("state" in failed, false);
  assert.ok(failed.hexOrigin, "partial chunks must retain placement metadata for last-known graphics");

  const center = payload.chunks.find((chunk) => chunk.regionId === "garden-1");
  assert.equal(center?.state?.regionId, "garden-1");
  assert.equal(payload.chunks.filter((chunk) => chunk.state).length, 6);
});
