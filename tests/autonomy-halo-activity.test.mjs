import assert from "node:assert/strict";
import test from "node:test";
import { autonomyHaloLinksForActivity } from "../dist-ts/src/autonomy-region.js";

const extent = { width: 40, height: 24 };
const configured = ["garden-1", "garden-2", "garden-3"];

test("active legacy autonomy scouts all six dynamic neighbors while background tiers stay configured", () => {
  const active = autonomyHaloLinksForActivity(extent, configured, "garden-1", "active");
  const warm = autonomyHaloLinksForActivity(extent, configured, "garden-1", "warm");
  const canonical = autonomyHaloLinksForActivity(extent, configured, "hex-q4-r-2", "cold");

  assert.equal(active.length, 6 * 23);
  assert.equal(new Set(active.map((entry) => entry.neighborRegionId)).size, 6);
  assert.equal(warm.length, 2 * 23);
  assert.deepEqual(
    [...new Set(warm.map((entry) => entry.neighborRegionId))].sort(),
    ["garden-2", "garden-3"],
  );
  assert.equal(canonical.length, 6 * 23);
});
