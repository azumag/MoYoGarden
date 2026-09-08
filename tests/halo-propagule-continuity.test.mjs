import assert from "node:assert/strict";
import test from "node:test";
import { createRandom } from "../dist-ts/src/prng.js";
import {
  applyHaloRegrowthCompensation,
  resourceRegrowthChanceWithHalo,
} from "../dist-ts/src/halo-environment.js";
import { buildHexHaloLinks } from "../dist-ts/src/hex-halo.js";
import { resourceRegrowthChance } from "../dist-ts/src/simulation.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function cleanWorld() {
  const state = createInitialWorld({ seed: 9401, width: 40, height: 24, regionId: "garden-1" });
  for (const tile of state.tiles) {
    tile.terrain = "plain";
    tile.elevation = 0.8;
    tile.drainage = 0;
    delete tile.flowTo;
    delete tile.resource;
  }
  for (const agent of state.agents) {
    agent.autonomy = false;
    delete agent.task;
  }
  return state;
}

test("matching local and cross-region biomass exert the same one-step propagule pressure", () => {
  const state = cleanWorld();
  const localTarget = state.tiles[11 * state.width + 19];
  const localSource = state.tiles[11 * state.width + 20];
  assert.ok(localTarget && localSource);
  localTarget.resource = { kind: "food", amount: 0, maxAmount: 10 };
  localSource.resource = { kind: "food", amount: 5, maxAmount: 10 };
  const localChance = resourceRegrowthChanceWithHalo(state, localTarget, []);
  assert.ok(localChance > resourceRegrowthChance(state, localTarget));

  delete localSource.resource;
  const link = buildHexHaloLinks(state, ["garden-1", "garden-2"], "garden-1")
    .find((entry) => entry.direction === "east");
  assert.ok(link);
  const boundaryTarget = state.tiles[link.sourcePosition.y * state.width + link.sourcePosition.x];
  assert.ok(boundaryTarget);
  boundaryTarget.resource = { kind: "food", amount: 0, maxAmount: 10 };
  boundaryTarget.elevation = localTarget.elevation;
  boundaryTarget.drainage = localTarget.drainage;

  // The rectangular storage envelope may still contain a compatibility tile one
  // step beyond the active macro-hex. Give it the wrong resource deliberately;
  // exact halo ownership must win for a cross-region direction.
  const envelopeNeighbor = state.tiles[
    link.sourcePosition.y * state.width + link.sourcePosition.x + 1
  ];
  if (envelopeNeighbor) envelopeNeighbor.resource = { kind: "wood", amount: 10, maxAmount: 10 };

  const halo = [{
    ...link,
    tile: {
      x: link.neighborPosition.x,
      y: link.neighborPosition.y,
      terrain: "plain",
      elevation: 0.8,
      resource: { kind: "food", amount: 5, maxAmount: 10 },
    },
  }];
  const ghostChance = resourceRegrowthChanceWithHalo(state, boundaryTarget, halo);
  assert.equal(ghostChance, localChance);
});

test("local six-neighbor propagules can compensate regrowth even when no halo edge materializes", () => {
  const state = cleanWorld();
  const target = state.tiles[11 * state.width + 19];
  const source = state.tiles[11 * state.width + 20];
  assert.ok(target && source);
  target.resource = { kind: "food", amount: 0, maxAmount: 10 };
  source.resource = { kind: "food", amount: 10, maxAmount: 10 };

  const before = structuredClone(state);
  before.tick = 29;
  const after = structuredClone(state);
  after.tick = 30;
  const targetAfter = after.tiles[target.y * after.width + target.x];
  assert.ok(targetAfter);

  const baseChance = resourceRegrowthChance(after, targetAfter);
  const propagatedChance = resourceRegrowthChanceWithHalo(after, targetAfter, []);
  const conditional = (propagatedChance - baseChance) / (1 - baseChance);
  assert.ok(conditional > 0);

  let selectedSeed;
  for (let seed = 1; seed < 10000; seed += 1) {
    if (createRandom(seed).next() < conditional) {
      selectedSeed = seed;
      break;
    }
  }
  assert.ok(selectedSeed !== undefined);
  after.rngState = selectedSeed;

  assert.equal(applyHaloRegrowthCompensation(before, after, [], 30), 1);
  assert.equal(after.tiles[target.y * after.width + target.x].resource.amount, 1);
});
