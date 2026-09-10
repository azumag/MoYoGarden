import assert from "node:assert/strict";
import test from "node:test";
import workerEntry from "../dist-ts/src/worker-entry.js";

test("production unscoped meta does not enumerate REGION_IDS", async () => {
  let regionListReads = 0;
  const env = {
    DEFAULT_REGION_ID: "garden-3",
    get REGION_IDS() {
      regionListReads += 1;
      throw new Error("unscoped production meta must not enumerate REGION_IDS");
    },
  };

  const response = await workerEntry.fetch(
    new Request("https://moyo.test/api/meta"),
    env,
  );

  assert.equal(response.status, 200);
  assert.equal(regionListReads, 0);
  const payload = await response.json();
  assert.equal(payload.defaultRegion, "garden-3");
  assert.deepEqual(payload.regions, ["garden-1", "garden-2", "garden-3"]);
  assert.equal(payload.world.regionTopology.regions.length, 3);
});
