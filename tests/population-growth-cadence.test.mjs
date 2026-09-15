import assert from "node:assert/strict";
import test from "node:test";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("population growth no longer runs at the former ten-minute cadence", () => {
  const state = createInitialWorld({ seed: 26091531 });
  const faction = state.factions.find((entry) => entry.id === "ember");
  assert.ok(faction);
  const members = state.agents.filter((agent) => agent.factionId === faction.id);
  assert.ok(members.length >= 2);

  for (const tile of state.tiles) {
    if (tile.terrain === "water") tile.terrain = "plain";
  }
  for (const member of members) {
    member.hp = 100;
    member.energy = 100;
    delete member.task;
  }
  const campPosition = { ...members[0].position };
  state.structures.push({
    id: "cadence-growth-camp",
    factionId: faction.id,
    type: "camp",
    position: campPosition,
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 100 },
  });
  faction.resources.food = 100;
  state.tick = 59;

  const next = new WorldRuntime({ state }).tick().state;
  const nextFaction = next.factions.find((entry) => entry.id === faction.id);
  const nextCamp = next.structures.find((structure) => structure.id === "cadence-growth-camp");
  assert.ok(nextFaction);
  assert.ok(nextCamp);
  assert.equal(next.agents.filter((agent) => agent.factionId === faction.id).length, members.length);
  assert.equal(nextFaction.resources.food, 100);
  assert.equal(nextCamp.storage.food, 100);
});
