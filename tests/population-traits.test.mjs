import assert from "node:assert/strict";
import test from "node:test";
import {
  adultCapacityForTraits,
  inheritHeritableTraits,
  naturalLifespanTicks,
  POPULATION_TRAIT_MAX,
  POPULATION_TRAIT_MIN,
} from "../dist-ts/src/demography.js";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("heritable traits mix both parents with deterministic bounded mutation", () => {
  const parent = { heritableTraits: { vitality: 1.1, carryingCapacity: 1.08 } };
  const partnerTraits = { vitality: 0.96, carryingCapacity: 0.94 };
  const first = inheritHeritableTraits(parent, partnerTraits, "trait-child-a");
  const repeated = inheritHeritableTraits(parent, partnerTraits, "trait-child-a");

  assert.deepEqual(first, repeated);
  assert.ok(first.vitality >= POPULATION_TRAIT_MIN && first.vitality <= POPULATION_TRAIT_MAX);
  assert.ok(first.carryingCapacity >= POPULATION_TRAIT_MIN && first.carryingCapacity <= POPULATION_TRAIT_MAX);
  assert.ok(Math.abs(first.vitality - 1.03) <= 0.0201);
  assert.ok(Math.abs(first.carryingCapacity - 1.01) <= 0.0201);
});

test("vitality and carrying capacity affect lifespan and adult hauling capacity", () => {
  const baseline = naturalLifespanTicks("trait-lifespan");
  assert.ok(naturalLifespanTicks("trait-lifespan", 0.9) < baseline);
  assert.ok(naturalLifespanTicks("trait-lifespan", 1.1) > baseline);
  assert.equal(
    adultCapacityForTraits(24, { heritableTraits: { vitality: 1, carryingCapacity: 1.1 } }),
    26,
  );
  assert.equal(adultCapacityForTraits(24, {}), 24);
});

test("conception snapshots partner traits and birth inherits them after gestation", () => {
  const state = createInitialWorld({ seed: 6041 });
  const faction = state.factions.find((entry) => entry.id === "ember");
  assert.ok(faction);
  const templates = state.agents.filter((agent) => agent.factionId === faction.id);
  assert.ok(templates.length >= 2);

  const parent = structuredClone(templates[0]);
  const partner = structuredClone(templates[1]);
  assert.ok(parent);
  assert.ok(partner);
  parent.id = "trait-parent";
  partner.id = "trait-partner";
  parent.position = { ...templates[0].position };
  partner.position = { ...parent.position };
  parent.hp = partner.hp = 100;
  parent.energy = partner.energy = 100;
  parent.autonomy = partner.autonomy = false;
  parent.reproductiveRole = "gestational";
  partner.reproductiveRole = "partner";
  parent.heritableTraits = { vitality: 1.1, carryingCapacity: 1.08 };
  partner.heritableTraits = { vitality: 0.96, carryingCapacity: 0.94 };
  parent.socialMemory = [{ agentId: partner.id, familiarity: 4, lastInteractionTick: 1 }];
  partner.socialMemory = [{ agentId: parent.id, familiarity: 4, lastInteractionTick: 1 }];
  delete parent.pregnancy;
  delete partner.pregnancy;
  delete parent.lastBirthTick;
  delete partner.lastBirthTick;
  delete parent.task;
  delete partner.task;

  state.agents = state.agents.filter((agent) => agent.factionId !== faction.id);
  state.agents.push(parent, partner);
  state.structures = state.structures.filter((structure) => structure.factionId !== faction.id);
  state.structures.push({
    id: "trait-family-camp",
    factionId: faction.id,
    type: "camp",
    position: { ...parent.position },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 100 },
  });
  faction.resources.food = 100;
  state.tick = 8_639;

  const conceived = new WorldRuntime({ state }).tick().state;
  const gestationalParent = conceived.agents.find((agent) => agent.id === parent.id);
  assert.ok(gestationalParent?.pregnancy);
  assert.deepEqual(gestationalParent.pregnancy.partnerTraits, partner.heritableTraits);

  const childId = `agent-${faction.id}-birth-${gestationalParent.pregnancy.dueAtTick}-3`;
  const expectedTraits = inheritHeritableTraits(
    gestationalParent,
    gestationalParent.pregnancy.partnerTraits,
    childId,
  );
  conceived.tick = gestationalParent.pregnancy.dueAtTick - 1;
  const born = new WorldRuntime({ state: conceived }).tick().state;
  const newborn = born.agents.find((agent) => agent.id === childId);
  assert.ok(newborn);
  assert.deepEqual(newborn.heritableTraits, expectedTraits);
  assert.deepEqual(newborn.parents, [parent.id, partner.id]);
});
