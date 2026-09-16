import test from "node:test";
import assert from "node:assert/strict";

import { dependentCaregiverId } from "../dist-ts/src/demography.js";

function adult(id, x, y, energy = 50) {
  return {
    id,
    factionId: "settlers",
    hp: 100,
    energy,
    position: { x, y },
  };
}

function dependent(parents) {
  return {
    id: "child",
    factionId: "settlers",
    hp: 100,
    energy: 50,
    lifeStage: "infant",
    parents,
    position: { x: 10, y: 10 },
  };
}

test("dependent care follows the spatially closest living parent", () => {
  const far = adult("parent-far", 3, 3, 100);
  const near = adult("parent-near", 10, 11, 30);
  const child = dependent([far.id, near.id]);
  const state = { agents: [far, near, child] };

  assert.equal(dependentCaregiverId(state, child), near.id);
});

test("co-located parents use energy reserve then stable identity as caregiver tie-breaks", () => {
  const lower = adult("parent-b", 10, 9, 40);
  const stronger = adult("parent-a", 11, 10, 70);
  const child = dependent([lower.id, stronger.id]);
  const state = { agents: [lower, stronger, child] };

  assert.equal(dependentCaregiverId(state, child), stronger.id);
  stronger.energy = lower.energy;
  assert.equal(dependentCaregiverId(state, child), stronger.id);
});

test("dead and cross-faction parents cannot become active caregivers", () => {
  const dead = adult("parent-dead", 10, 10, 100);
  dead.hp = 0;
  const otherFaction = adult("parent-other", 10, 10, 100);
  otherFaction.factionId = "visitors";
  const living = adult("parent-living", 13, 10, 20);
  const child = dependent([dead.id, otherFaction.id, living.id]);
  const state = { agents: [dead, otherFaction, living, child] };

  assert.equal(dependentCaregiverId(state, child), living.id);
});
