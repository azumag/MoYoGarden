import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../public/client/live-region-rendering.js", import.meta.url),
  "utf8",
);

test("constrained quality profiles reduce contextual neighbor animation cadence", () => {
  assert.match(source, /const CONSTRAINED_LIVE_NEIGHBOR_ANIMATION_INTERVAL_MS = 1000 \/ 15;/);
  assert.match(source, /function liveNeighborAnimationIntervalMs\(quality\)/);
  assert.match(source, /Number\(quality\?\.detailDensity\)/);
  assert.match(source, /density <= 0\.5/);
  assert.match(
    source,
    /this\.animationIntervalMs = liveNeighborAnimationIntervalMs\(view\.quality\);/,
  );
  assert.match(
    source,
    /time - this\.lastAnimationAt < this\.animationIntervalMs/,
  );
});
