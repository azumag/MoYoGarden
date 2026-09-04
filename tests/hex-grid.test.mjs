import assert from "node:assert/strict";
import test from "node:test";
import {
  HEX_GRID_DIRECTIONS,
  HEX_GRID_DIRECTION_STEPS,
  HEX_GRID_STEPS,
  hexGridBoundaryCells,
  hexGridCenter,
  hexGridCrossingDirection,
  hexGridDistance,
  hexGridHandoffTarget,
  hexGridNeighbors,
  hexGridRadius,
  isHexGridCell,
  nearestHexGridCell,
  oppositeHexGridDirection,
} from "../dist-ts/src/hex-grid.js";
import {
  hexCellRadius,
  hexTileWorldXZ,
  worldXZToHexTile,
} from "../public/client/hex-grid.js";

test("local simulation grid uses six equal axial neighbors", () => {
  const origin = { x: 19, y: 11 };
  const neighbors = hexGridNeighbors(origin);
  assert.equal(neighbors.length, 6);
  assert.deepEqual(neighbors.map((entry) => ({ x: entry.x - origin.x, y: entry.y - origin.y })), HEX_GRID_STEPS);
  assert.ok(neighbors.every((entry) => hexGridDistance(origin, entry) === 1));
});

test("40x24 storage exposes a centered hex simulation footprint", () => {
  const extent = { width: 40, height: 24 };
  assert.deepEqual(hexGridCenter(extent), { x: 19, y: 11 });
  assert.equal(hexGridRadius(extent), 11);
  const active = [];
  for (let y = 0; y < extent.height; y += 1) {
    for (let x = 0; x < extent.width; x += 1) {
      if (isHexGridCell(extent, { x, y })) active.push({ x, y });
    }
  }
  assert.equal(active.length, 397);
  assert.ok(active.every((position) => hexGridDistance(position, { x: 19, y: 11 }) <= 11));
  assert.equal(isHexGridCell(extent, { x: 0, y: 0 }), false);
  assert.equal(isHexGridCell(extent, { x: 19, y: 0 }), true);
  assert.equal(isHexGridCell(extent, { x: 30, y: 11 }), true);
});

test("each logical exit has a deterministic opposite-side handoff bijection", () => {
  const extent = { width: 40, height: 24 };
  for (const direction of HEX_GRID_DIRECTIONS) {
    const sourceSide = hexGridBoundaryCells(extent, direction);
    const opposite = oppositeHexGridDirection(direction);
    const targetSide = hexGridBoundaryCells(extent, opposite);
    assert.equal(sourceSide.length, 23, `${direction} source side length`);
    assert.equal(targetSide.length, sourceSide.length, `${direction} opposite side length`);

    for (const source of sourceSide) {
      const target = hexGridHandoffTarget(extent, source, direction);
      assert.ok(target, `${direction} missing target for ${source.x},${source.y}`);
      assert.ok(isHexGridCell(extent, target));
      assert.ok(targetSide.some((entry) => entry.x === target.x && entry.y === target.y));
      assert.deepEqual(hexGridHandoffTarget(extent, target, opposite), source);

      const step = HEX_GRID_DIRECTION_STEPS[direction];
      const desired = { x: source.x + step.x, y: source.y + step.y };
      assert.equal(isHexGridCell(extent, desired), false);
      assert.equal(hexGridCrossingDirection(extent, source, desired), direction);
    }
  }
});

test("handoff mapping rejects interior movement and non-boundary agents", () => {
  const extent = { width: 40, height: 24 };
  const center = hexGridCenter(extent);
  assert.equal(hexGridHandoffTarget(extent, center, "east"), undefined);
  assert.equal(hexGridCrossingDirection(extent, center, { x: center.x + 1, y: center.y }), undefined);
  assert.equal(hexGridHandoffTarget(extent, { x: 0, y: 0 }, "west"), undefined);
});

test("nearest hex cell provides a deterministic migration target", () => {
  const extent = { width: 40, height: 24 };
  assert.deepEqual(nearestHexGridCell(extent, { x: 0, y: 0 }), { x: 19, y: 0 });
  assert.deepEqual(
    nearestHexGridCell(extent, { x: 0, y: 0 }, (position) => position.x >= 10),
    { x: 19, y: 0 },
  );
});

test("client projection is invertible on every active cell", () => {
  const width = 40;
  const height = 24;
  assert.ok(hexCellRadius(width, height) > 0.5);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isHexGridCell({ width, height }, { x, y })) continue;
      const world = hexTileWorldXZ({ x, y }, width, height);
      assert.deepEqual(worldXZToHexTile(world.x, world.z, width, height), { x, y });
    }
  }
});
