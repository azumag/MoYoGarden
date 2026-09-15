import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../public/client/live-region-rendering.js", import.meta.url),
  "utf8",
);

test("live-neighbor animation cues are cached at snapshot sync instead of recomputed every frame", () => {
  assert.match(source, /function refreshNeighborAgentAnimationState\(proxy\)/);
  assert.match(source, /entry\.moyoMoving = entry\.from\.distanceToSquared\(entry\.to\) > 0\.001/);
  assert.match(source, /entry\.moyoPhaseOffset = hash2\(/);
  assert.match(source, /const moving = entry\.moyoMoving \?\?/);
  assert.match(source, /const phaseOffset = entry\.moyoPhaseOffset\s*\?\?/);

  const createProxyStart = source.indexOf("function createProxy(");
  const syncProxyStart = source.indexOf("function syncProxy(", createProxyStart);
  const snapshotStart = source.indexOf("function snapshotTick(", syncProxyStart);
  assert.ok(createProxyStart >= 0 && syncProxyStart > createProxyStart && snapshotStart > syncProxyStart);

  const createProxySource = source.slice(createProxyStart, syncProxyStart);
  const syncProxySource = source.slice(syncProxyStart, snapshotStart);
  assert.match(
    createProxySource,
    /proxy\.syncAgents\(state\);\s*refreshNeighborAgentAnimationState\(proxy\);/,
  );
  assert.match(
    syncProxySource,
    /proxy\.syncAgents\(state\);\s*refreshNeighborAgentAnimationState\(proxy\);/,
  );
});
