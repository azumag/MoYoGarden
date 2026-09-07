import assert from "node:assert/strict";
import test from "node:test";
import {
  haloDrainageInflowAt,
  haloFlowOutletAt,
  surfaceMoistureWithHaloAt,
} from "../dist-ts/src/halo-environment.js";
import { buildConfiguredHexHaloLinks, buildHexHaloLinks } from "../dist-ts/src/hex-halo.js";
import { surfaceMoistureAt } from "../dist-ts/src/simulation.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function outletFixture() {
  const state = createInitialWorld({ seed: 9401, width: 40, height: 24, regionId: "garden-1" });
  for (const tile of state.tiles) {
    tile.terrain = "plain";
    delete tile.resource;
    tile.elevation = 0.8;
    tile.drainage = 0;
    delete tile.flowTo;
    tile.erosionPressure = 0;
  }
  for (const agent of state.agents) {
    agent.autonomy = false;
    delete agent.task;
  }

  const link = buildHexHaloLinks(state, ["garden-1", "garden-2"], "garden-1")
    .filter((entry) => entry.direction === "east")[11];
  assert.ok(link);
  const tile = state.tiles[link.sourcePosition.y * state.width + link.sourcePosition.x];
  assert.ok(tile);
  tile.elevation = 0.8;
  tile.drainage = 0.8;

  const halo = [{
    ...link,
    tile: {
      x: link.neighborPosition.x,
      y: link.neighborPosition.y,
      terrain: "plain",
      elevation: 0.62,
      drainage: 0,
    },
  }];
  return { state, tile, halo };
}

test("lower ghost cell becomes a read-only outlet for a local boundary sink", () => {
  const { state, tile, halo } = outletFixture();
  const local = surfaceMoistureAt(state, tile);
  const outlet = haloFlowOutletAt(state, tile, halo);

  assert.ok(outlet);
  assert.equal(outlet.direction, "east");
  assert.equal(outlet.neighborRegionId, "garden-2");
  assert.deepEqual(outlet.neighborPosition, halo[0].neighborPosition);
  assert.ok(Math.abs(outlet.drop - 0.18) < 1e-12);
  assert.equal(outlet.slope, 1);
  assert.equal(tile.flowTo, undefined, "read-only outlet must not persist cross-DO ownership");
  assert.ok(surfaceMoistureWithHaloAt(state, tile, halo) < local - 0.1);
});

test("existing local flow remains authoritative over a lower ghost outlet", () => {
  const { state, tile, halo } = outletFixture();
  tile.flowTo = { x: tile.x - 1, y: tile.y };

  assert.equal(haloFlowOutletAt(state, tile, halo), undefined);
  assert.equal(surfaceMoistureWithHaloAt(state, tile, halo), surfaceMoistureAt(state, tile));
});

test("equal-slope cross-region outlet agrees with the receiver that owns the inflow", () => {
  const regionIds = ["garden-1", "garden-2", "garden-3"];
  const source = createInitialWorld({ seed: 9402, width: 40, height: 24, regionId: "garden-1" });
  const receiver = createInitialWorld({ seed: 9403, width: 40, height: 24, regionId: "garden-2" });
  for (const state of [source, receiver]) {
    for (const tile of state.tiles) {
      tile.terrain = "plain";
      delete tile.resource;
      tile.elevation = 0.8;
      tile.drainage = 0;
      delete tile.flowTo;
      tile.erosionPressure = 0;
    }
  }

  const sourcePosition = { x: 30, y: 1 };
  const sourceTile = source.tiles[sourcePosition.y * source.width + sourcePosition.x];
  assert.ok(sourceTile);
  sourceTile.elevation = 0.8;
  sourceTile.drainage = 0.5;

  const sourceLinks = buildConfiguredHexHaloLinks(source, regionIds, "garden-1")
    .filter((link) =>
      link.sourcePosition.x === sourcePosition.x &&
      link.sourcePosition.y === sourcePosition.y &&
      link.neighborRegionId === "garden-2"
    );
  assert.equal(sourceLinks.length, 2);
  const sourceHalo = sourceLinks.map((link) => ({
    ...link,
    tile: {
      x: link.neighborPosition.x,
      y: link.neighborPosition.y,
      terrain: "plain",
      elevation: 0.6,
      drainage: 0,
    },
  }));

  const outlet = haloFlowOutletAt(source, sourcePosition, sourceHalo);
  assert.ok(outlet);

  const reverseLinks = buildConfiguredHexHaloLinks(receiver, regionIds, "garden-2")
    .filter((link) =>
      link.neighborRegionId === "garden-1" &&
      link.neighborPosition.x === sourcePosition.x &&
      link.neighborPosition.y === sourcePosition.y
    );
  assert.equal(reverseLinks.length, 2);
  for (const link of reverseLinks) {
    const tile = receiver.tiles[link.sourcePosition.y * receiver.width + link.sourcePosition.x];
    assert.ok(tile);
    tile.elevation = 0.6;
  }
  const receiverHalo = reverseLinks.map((link) => ({
    ...link,
    tile: {
      x: sourcePosition.x,
      y: sourcePosition.y,
      terrain: "plain",
      elevation: 0.8,
      drainage: 0.5,
    },
  }));

  const receivingPositions = reverseLinks
    .map((link) => ({
      position: link.sourcePosition,
      inflow: haloDrainageInflowAt(receiver, link.sourcePosition, receiverHalo),
    }))
    .filter((entry) => entry.inflow > 0);
  assert.equal(receivingPositions.length, 1);
  assert.deepEqual(
    outlet.neighborPosition,
    receivingPositions[0].position,
    "source outlet and receiver inflow must choose the same equal-slope seam cell",
  );
});
