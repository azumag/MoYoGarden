import assert from "node:assert/strict";
import test from "node:test";
import worker from "../dist-ts/src/region-window-reliability-entry.js";

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

function envWithSnapshotBehavior(behavior) {
  return {
    DEFAULT_REGION_ID: "garden-1",
    REGION_IDS: "garden-1,garden-2,garden-3",
    REGIONS: {
      idFromName: (name) => name,
      get: (regionId) => ({
        fetch: async () => behavior(regionId),
      }),
    },
    ASSETS: { fetch: async () => new Response("unused") },
  };
}

function healthySnapshot(regionId) {
  return new Response(JSON.stringify(snapshot(regionId)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("center HTTP failure rejects a centerless live window", async () => {
  const env = envWithSnapshotBehavior((regionId) => (
    regionId === "garden-1"
      ? new Response(JSON.stringify({ error: "boom" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        })
      : healthySnapshot(regionId)
  ));
  const response = await worker.fetch(
    new Request("https://moyo.example/api/world/window?region=garden-1&radius=1&live=1"),
    env,
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "center region snapshot unavailable" });
});

test("malformed neighbor JSON stays an error chunk instead of aborting the live window", async () => {
  const env = envWithSnapshotBehavior((regionId) => (
    regionId === "garden-2"
      ? new Response("{", {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      : healthySnapshot(regionId)
  ));
  const response = await worker.fetch(
    new Request("https://moyo.example/api/world/window?region=garden-1&radius=1&live=1"),
    env,
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  const failed = payload.chunks.find((chunk) => chunk.regionId === "garden-2");
  assert.ok(failed);
  assert.equal(failed.error, "snapshot HTTP 503");
  assert.equal("state" in failed, false);
  assert.equal(payload.chunks.find((chunk) => chunk.regionId === "garden-1")?.state?.regionId, "garden-1");
});

test("malformed center JSON rejects the live window", async () => {
  const env = envWithSnapshotBehavior((regionId) => (
    regionId === "garden-1"
      ? new Response("{", {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      : healthySnapshot(regionId)
  ));
  const response = await worker.fetch(
    new Request("https://moyo.example/api/world/window?region=garden-1&radius=1&live=1"),
    env,
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "center region snapshot unavailable" });
});
