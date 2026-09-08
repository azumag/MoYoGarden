import assert from "node:assert/strict";
import test from "node:test";
import {
  orographicMoistureFromFetch,
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

test("short upwind terrain fetch creates bounded uplift and rain-shadow tendencies", () => {
  const uplift = orographicMoistureFromFetch(0.7, [0.58, 0.5, 0.42], 0.8);
  const rainShadow = orographicMoistureFromFetch(0.38, [0.58, 0.68, 0.72], 0.8);
  const calm = orographicMoistureFromFetch(0.7, [0.58, 0.5, 0.42], 0);

  assert.ok(uplift > 0, "rising terrain along the wind fetch should gain moisture");
  assert.ok(rainShadow < 0, "terrain below a higher upwind profile should dry slightly");
  assert.equal(calm, 0, "orographic transport must vanish when wind strength is zero");
  assert.ok(Math.abs(uplift) <= 0.12);
  assert.ok(Math.abs(rainShadow) <= 0.12);
});

test("farther upwind relief contributes less than the immediately adjacent cell", () => {
  const nearRidge = orographicMoistureFromFetch(0.6, [0.8, 0.6, 0.6], 1);
  const farRidge = orographicMoistureFromFetch(0.6, [0.6, 0.6, 0.8], 1);

  assert.ok(
    Math.abs(nearRidge) > Math.abs(farRidge),
    "the nearest upwind cell must remain authoritative over the third fetch cell",
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
