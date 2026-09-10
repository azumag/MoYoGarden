import assert from "node:assert/strict";
import test from "node:test";
import {
  hexGridDistance,
  isHexGridCell,
  nearestHexGridCell,
} from "../dist-ts/src/hex-grid.js";

function exhaustiveNearest(extent, desired, predicate) {
  let best;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let y = 0; y < extent.height; y += 1) {
    for (let x = 0; x < extent.width; x += 1) {
      const candidate = { x, y };
      if (!isHexGridCell(extent, candidate) || !predicate(candidate)) continue;
      const distance = hexGridDistance(candidate, desired);
      if (
        distance < bestDistance ||
        (distance === bestDistance && best !== undefined && (y < best.y || y === best.y && x < best.x))
      ) {
        best = candidate;
        bestDistance = distance;
      }
    }
  }
  return best;
}

test("nearest hex lookup preserves exhaustive result while pruning farther predicates", () => {
  const extent = { width: 40, height: 24 };
  const desired = { x: 31, y: 11 };
  const accepted = (position) => position.x >= 20 && position.y >= 5;
  const expected = exhaustiveNearest(extent, desired, accepted);

  let predicateCalls = 0;
  const actual = nearestHexGridCell(extent, desired, (position) => {
    predicateCalls += 1;
    return accepted(position);
  });

  assert.deepEqual(actual, expected);
  assert.deepEqual(actual, { x: 30, y: 11 });
  assert.ok(predicateCalls < 100, `expected bounded predicate work, got ${predicateCalls}`);
});

test("nearest hex lookup still evaluates equal-distance candidates for deterministic tie-breaks", () => {
  const extent = { width: 40, height: 24 };
  const desired = { x: 19, y: -1 };
  const accepted = (position) => position.y === 0 && (position.x === 19 || position.x === 20);
  const expected = exhaustiveNearest(extent, desired, accepted);

  assert.deepEqual(nearestHexGridCell(extent, desired, accepted), expected);
});
