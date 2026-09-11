import assert from "node:assert/strict";
import test from "node:test";
import { soilFertilityFromConditions } from "../dist-ts/src/world-scale.js";

test("extreme waterlogging lowers soil fertility below moderately wet soil", () => {
  const temperature = 0.58;
  const slope = 0.2;
  const convergence = 0.6;
  const dry = soilFertilityFromConditions(0.18, temperature, slope, convergence);
  const moderate = soilFertilityFromConditions(0.72, temperature, slope, convergence);
  const saturated = soilFertilityFromConditions(1, temperature, slope, convergence);

  assert.ok(moderate > dry, `expected moderate ${moderate} > dry ${dry}`);
  assert.ok(moderate > saturated, `expected moderate ${moderate} > saturated ${saturated}`);
});

test("waterlogging fertility remains bounded for extreme inputs", () => {
  for (const wetness of [-1, 0, 0.5, 1, 2]) {
    const fertility = soilFertilityFromConditions(wetness, 0.58, 0.2, 0.6);
    assert.ok(fertility >= 0 && fertility <= 1, `fertility ${fertility} escaped bounds`);
  }
});
