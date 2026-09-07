import assert from "node:assert/strict";
import test from "node:test";
import {
  autonomyHaloLinks,
  isAutonomyClaimSourceRegionId,
} from "../dist-ts/src/autonomy-region.js";

const extent = { width: 40, height: 24 };
const configured = ["garden-1", "garden-2", "garden-3"];

test("canonical autonomy scouting uses a bounded six-neighbor dynamic halo", () => {
  const source = "hex-q0-r1";
  const links = autonomyHaloLinks(extent, configured, source);
  assert.equal(links.length, 138);
  assert.equal(new Set(links.map((link) => link.neighborRegionId)).size, 6);
  assert.equal(links.every((link) => link.sourceRegionId === source), true);
});

test("legacy autonomy scouting keeps the configured-only compatibility halo", () => {
  const links = autonomyHaloLinks(extent, configured, "garden-1");
  assert.equal(links.length, 46);
  assert.deepEqual(new Set(links.map((link) => link.neighborRegionId)), new Set(["garden-2", "garden-3"]));
});

test("arrival claim tracking accepts canonical sparse-world source regions", () => {
  assert.equal(isAutonomyClaimSourceRegionId(configured, "hex-q2-r-1"), true);
  assert.equal(isAutonomyClaimSourceRegionId(configured, "garden-1"), true);
  assert.equal(isAutonomyClaimSourceRegionId(configured, "historical-unknown"), false);
});