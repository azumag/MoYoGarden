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

test("promoted lineage references reconnect to a local parent in their origin region", () => {
  const parent = adult("parent-local", 10, 10, 70);
  const child = dependent([
    `agent-global:garden-1:${parent.id}`,
    "agent-global:garden-2:missing-parent",
  ]);
  const reunited = { regionId: "garden-1", agents: [parent, child] };

  assert.equal(dependentCaregiverId(reunited, child), parent.id);

  const foreignRegion = { regionId: "garden-2", agents: [parent, child] };
  assert.equal(
    dependentCaregiverId(foreignRegion, child),
    undefined,
    "a reused local id in another region must not satisfy the globally promoted parent reference",
  );
});


test("orphaned dependents choose a familiar adult instead of a nearer stranger", () => {
  const trusted = adult("trusted-guardian", 4, 4, 45);
  trusted.socialMemory = [{ agentId: "child", familiarity: 5, lastInteractionTick: 30 }];
  const stranger = adult("near-stranger", 10, 11, 100);
  const child = dependent(["missing-parent-a", "missing-parent-b"]);
  const state = { regionId: "garden-1", agents: [trusted, stranger, child] };

  assert.equal(dependentCaregiverId(state, child), trusted.id);
});

test("living parents remain authoritative over stronger social guardians", () => {
  const parent = adult("living-parent", 2, 2, 10);
  const guardian = adult("familiar-guardian", 10, 11, 100);
  guardian.socialMemory = [{ agentId: "child", familiarity: 32, lastInteractionTick: 40 }];
  const child = dependent([parent.id, "missing-parent"]);
  const state = { regionId: "garden-1", agents: [parent, guardian, child] };

  assert.equal(dependentCaregiverId(state, child), parent.id);
});

test("social caregiver fallback requires a living same-faction adult relationship", () => {
  const dead = adult("dead-friend", 10, 10, 100);
  dead.hp = 0;
  dead.socialMemory = [{ agentId: "child", familiarity: 12, lastInteractionTick: 20 }];
  const juvenile = adult("juvenile-friend", 10, 10, 100);
  juvenile.lifeStage = "juvenile";
  juvenile.socialMemory = [{ agentId: "child", familiarity: 12, lastInteractionTick: 20 }];
  const outsider = adult("outsider-friend", 10, 10, 100);
  outsider.factionId = "visitors";
  outsider.socialMemory = [{ agentId: "child", familiarity: 12, lastInteractionTick: 20 }];
  const stranger = adult("unfamiliar-adult", 10, 10, 100);
  const child = dependent(["missing-a", "missing-b"]);
  const state = { regionId: "garden-1", agents: [dead, juvenile, outsider, stranger, child] };

  assert.equal(dependentCaregiverId(state, child), undefined);
});
