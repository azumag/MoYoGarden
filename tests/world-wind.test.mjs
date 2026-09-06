import assert from "node:assert/strict";
import test from "node:test";
import {
  sampleWorldConditions,
  sampleWorldWind,
} from "../dist-ts/src/world-scale.js";
import { HEX_GRID_DIRECTIONS } from "../dist-ts/src/hex-grid.js";

test("global wind is deterministic, bounded, and aligned to the six hex directions", () => {
  const seed = 424242;
  const coordinates = [
    [0, 0],
    [17, 9],
    [200, 0],
    [0, 200],
    [-200, 100],
  ];
  const first = coordinates.map(([x, y]) => sampleWorldWind(seed, x, y));
  const second = coordinates.map(([x, y]) => sampleWorldWind(seed, x, y));
  assert.deepEqual(first, second);

  for (const wind of first) {
    assert.ok(HEX_GRID_DIRECTIONS.includes(wind.direction));
    assert.ok(Number.isFinite(wind.strength));
    assert.ok(wind.strength >= 0 && wind.strength <= 1);
  }
  assert.ok(
    new Set(first.map((wind) => wind.direction)).size > 1,
    "the shared world wind must vary across broad global distances",
  );
});

test("world conditions expose the same shared wind that drives frontier moisture", () => {
  const seed = 909090;
  for (const [x, y] of [[3, 4], [39, 23], [80, -12]]) {
    const wind = sampleWorldWind(seed, x, y);
    const conditions = sampleWorldConditions(seed, x, y);
    assert.equal(conditions.windDirection, wind.direction);
    assert.equal(conditions.windStrength, wind.strength);
    assert.ok(conditions.moisture >= 0 && conditions.moisture <= 1);
    assert.ok(conditions.wetness >= 0 && conditions.wetness <= 1);
  }
});
