import assert from "node:assert/strict";
import test from "node:test";
import workerEntry, {
  configuredDefaultRegionId,
  enrichMetaPayload,
  routeConfiguredDefaultRegion,
} from "../dist-ts/src/worker-entry.js";

const BUILD = {
  commit: "0123456789abcdef0123456789abcdef01234567",
  branch: "main",
  source: "test",
};

test("DEFAULT_REGION_ID stays authoritative when REGION_IDS order changes", () => {
  const env = {
    DEFAULT_REGION_ID: "garden-3",
    REGION_IDS: "garden-1,garden-2,garden-3",
  };

  assert.equal(configuredDefaultRegionId(env), "garden-3");
  const routed = routeConfiguredDefaultRegion(
    new Request("https://moyo.test/api/world/window"),
    env,
  );
  assert.equal(routed.headers.get("x-moyo-region"), "garden-3");
});

test("canonical DEFAULT_REGION_ID does not need REGION_IDS enumeration", () => {
  const env = {
    DEFAULT_REGION_ID: "hex-q2-r-1",
    REGION_IDS: "garden-1,garden-2,garden-3",
  };
  assert.equal(configuredDefaultRegionId(env), "hex-q2-r-1");
});

test("explicit region routing is never overwritten by the configured default", () => {
  const env = {
    DEFAULT_REGION_ID: "garden-3",
    REGION_IDS: "garden-1,garden-2,garden-3",
  };
  const queryRequest = routeConfiguredDefaultRegion(
    new Request("https://moyo.test/api/world/window?region=garden-2"),
    env,
  );
  assert.equal(queryRequest.headers.get("x-moyo-region"), null);

  const headerRequest = routeConfiguredDefaultRegion(
    new Request("https://moyo.test/api/world/snapshot", {
      headers: { "x-moyo-region": "garden-2" },
    }),
    env,
  );
  assert.equal(headerRequest.headers.get("x-moyo-region"), "garden-2");
});

test("production meta enrichment reports the configured default rather than list order", async () => {
  const enriched = enrichMetaPayload(
    { service: "moyo-garden", defaultRegion: "garden-1" },
    BUILD,
    "garden-3",
  );
  assert.equal(enriched.defaultRegion, "garden-3");

  const response = await workerEntry.fetch(
    new Request("https://moyo.test/api/meta"),
    {
      DEFAULT_REGION_ID: "garden-3",
      REGION_IDS: "garden-1,garden-2,garden-3",
    },
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.defaultRegion, "garden-3");
  assert.deepEqual(payload.regions, ["garden-1", "garden-2", "garden-3"]);
});