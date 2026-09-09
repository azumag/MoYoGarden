import assert from "node:assert/strict";
import test from "node:test";
import { BUILD_RECIPES, inventoryTotal } from "../dist-ts/src/protocol.js";
import { simulate } from "../dist-ts/src/simulation.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function storageFixture() {
  const state = createInitialWorld({ seed: 2509, width: 16, height: 12 });
  for (const tile of state.tiles) {
    if (tile.terrain !== "water") tile.terrain = "plain";
    delete tile.resource;
  }

  const worker = state.agents.find((agent) => agent.role === "woodcutter");
  assert.ok(worker);
  worker.position = { x: 7, y: 5 };
  worker.energy = 100;
  worker.inventory = { wood: 5, stone: 0, food: 0 };
  worker.autonomy = false;
  worker.task = {
    source: "external",
    issuedAtTick: state.tick,
    expiresAtTick: state.tick + 120,
    type: "deposit",
    structureId: "near-camp",
  };
  state.agents = [worker];

  const faction = state.factions.find((entry) => entry.id === worker.factionId);
  assert.ok(faction);
  faction.resources = { wood: 118, stone: 0, food: 0 };

  state.structures = [
    {
      id: "near-camp",
      factionId: worker.factionId,
      type: "camp",
      position: { ...worker.position },
      status: "active",
      progress: 6,
      requiredProgress: 6,
      storage: { wood: 118, stone: 0, food: 0 },
    },
    {
      id: "overflow-storehouse",
      factionId: worker.factionId,
      type: "storehouse",
      position: { x: 8, y: 5 },
      status: "active",
      progress: 9,
      requiredProgress: 9,
      storage: { wood: 0, stone: 0, food: 0 },
    },
  ];
  state.events = [];
  state.processedCommandIds = [];
  return { state, workerId: worker.id, factionId: faction.id };
}

test("deposit respects building capacity and reroutes excess cargo without loss", () => {
  const { state, workerId, factionId } = storageFixture();
  const initialPhysicalWood =
    state.structures.reduce((sum, structure) => sum + structure.storage.wood, 0) +
    state.agents[0].inventory.wood;

  const first = simulate(state).state;
  const firstWorker = first.agents.find((agent) => agent.id === workerId);
  const camp = first.structures.find((structure) => structure.id === "near-camp");
  const faction = first.factions.find((entry) => entry.id === factionId);
  assert.ok(firstWorker);
  assert.ok(camp);
  assert.ok(faction);
  assert.equal(inventoryTotal(camp.storage), BUILD_RECIPES.camp.storageCapacity);
  assert.equal(firstWorker.inventory.wood, 3);
  assert.equal(firstWorker.task?.type, "deposit");
  assert.equal(firstWorker.task?.structureId, undefined);
  assert.equal(faction.resources.wood, 120);
  assert.deepEqual(
    first.events.find((event) => event.kind === "resources_deposited")?.data?.deposited,
    { wood: 2, stone: 0, food: 0 },
  );

  const second = simulate(first).state;
  const secondWorker = second.agents.find((agent) => agent.id === workerId);
  assert.ok(secondWorker);
  assert.deepEqual(secondWorker.position, { x: 8, y: 5 });
  assert.equal(secondWorker.task?.type, "deposit");
  assert.equal(secondWorker.task?.structureId, "overflow-storehouse");
  assert.equal(secondWorker.inventory.wood, 3);

  const third = simulate(second).state;
  const finalWorker = third.agents.find((agent) => agent.id === workerId);
  const finalFaction = third.factions.find((entry) => entry.id === factionId);
  const storehouse = third.structures.find((structure) => structure.id === "overflow-storehouse");
  assert.ok(finalWorker);
  assert.ok(finalFaction);
  assert.ok(storehouse);
  assert.equal(finalWorker.inventory.wood, 0);
  assert.equal(finalWorker.task, undefined);
  assert.equal(storehouse.storage.wood, 3);
  assert.equal(finalFaction.resources.wood, 123);

  const finalPhysicalWood =
    third.structures.reduce((sum, structure) => sum + structure.storage.wood, 0) +
    finalWorker.inventory.wood;
  assert.equal(finalPhysicalWood, initialPhysicalWood);
  for (const structure of third.structures) {
    assert.ok(inventoryTotal(structure.storage) <= BUILD_RECIPES[structure.type].storageCapacity);
  }
});
