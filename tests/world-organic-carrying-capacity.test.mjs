import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { scaleOrganicCarryingCapacity } from "../dist-ts/src/world-scale.js";

const worldScaleSource = await readFile(new URL("../src/world-scale.ts", import.meta.url), "utf8");

test("soil fertility exerts a bounded bottom-up pressure on organic carrying capacity", () => {
  const base = 20;
  assert.equal(scaleOrganicCarryingCapacity(base, 0), 18);
  assert.equal(scaleOrganicCarryingCapacity(base, 0.5), 20);
  assert.equal(scaleOrganicCarryingCapacity(base, 1), 22);

  assert.equal(scaleOrganicCarryingCapacity(base, -10), 18, "fertility is clamped at the dry/poor end");
  assert.equal(scaleOrganicCarryingCapacity(base, 10), 22, "fertility is clamped at the rich end");
  assert.equal(scaleOrganicCarryingCapacity(0, 0), 1, "carrying capacity never collapses below one unit");
});

test("fresh forest and food deposits both use the shared soil carrying-capacity rule", () => {
  const uses = worldScaleSource.match(/scaleOrganicCarryingCapacity\(/g) ?? [];
  assert.ok(uses.length >= 3, "helper definition plus wood and food generation should share one rule");
  assert.match(
    worldScaleSource,
    /terrain:\s*"forest"[\s\S]*resource:\s*\{\s*kind:\s*"wood",\s*amount:\s*maxAmount,\s*maxAmount\s*\}/,
  );
  assert.match(
    worldScaleSource,
    /tile\.resource\s*=\s*\{\s*kind:\s*"food",\s*amount:\s*maxAmount,\s*maxAmount\s*\}/,
  );
});
