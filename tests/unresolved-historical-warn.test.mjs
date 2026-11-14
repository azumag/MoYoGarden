import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { regionHexWindow } from "../dist-ts/src/region-topology.js";
import { configuredDefaultRegionId } from "../dist-ts/src/worker-entry.js";
import { buildConfiguredHexHaloLinks, buildHexHaloLinks } from "../dist-ts/src/hex-halo.js";

const EXTENT = { width: 40, height: 24 };

test("configuredDefaultRegionId rejects unresolved historical defaults (termination fail-closed)", () => {
  assert.equal(
    configuredDefaultRegionId({ DEFAULT_REGION_ID: "old-west", REGION_IDS: "old-west,garden-1" }),
    undefined,
  );
  assert.equal(configuredDefaultRegionId({ REGION_IDS: "old-west,garden-1" }), "garden-1");
});

test("configuredDefaultRegionId still accepts canonical and persisted legacy defaults", () => {
  assert.equal(configuredDefaultRegionId({ DEFAULT_REGION_ID: "garden-2" }), "garden-2");
  assert.equal(configuredDefaultRegionId({ DEFAULT_REGION_ID: "hex-q7-r-3" }), "hex-q7-r-3");
  assert.equal(configuredDefaultRegionId({}), "garden-1");
});

test("regionHexWindow does not use full-topology fallback for unresolved historical ids", () => {
  const warn = mock.method(console, "warn", () => {});
  try {
    const result = regionHexWindow(["old-west", "old-east"], "old-west", 1, EXTENT.width, EXTENT.height);
    assert.deepEqual(result, []);
    assert.equal(warn.mock.calls.length, 0);
  } finally {
    warn.mock.restore();
  }
});

test("legacy side-pair halo builders return no links for unresolved historical sources", () => {
  assert.deepEqual(buildHexHaloLinks(EXTENT, ["old-a", "old-b"], "old-a"), []);
  assert.deepEqual(buildConfiguredHexHaloLinks(EXTENT, ["old-a", "old-b"], "old-a"), []);
});
