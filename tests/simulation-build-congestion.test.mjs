import assert from "node:assert/strict";
import test from "node:test";
import { simulate } from "../dist-ts/src/simulation.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("autonomous builder avoids an equally near build hex already targeted by another builder", () => {
  const state = createInitialWorld({ seed: 2402, width: 16, height: 12 });
  for (const tile of state.tiles) {
    if (tile.terrain === "water") continue;
    tile.terrain = "plain";
    tile.resource = { kind: "food", amount: 1, maxAmount: 1 };
  }
  state.events = [];
  state.processedCommandIds = [];

  const builder = state.agents.find((agent) => agent.role === "builder");
  const inbound = state.agents.find((agent) => agent.id !== builder?.id);
  assert.ok(builder);
  assert.ok(inbound);

  builder.position = { x: 7, y: 5 };
  builder.energy = 100;
  builder.inventory = { wood: 0, stone: 0, food: 0 };
  builder.autonomy = true;
  delete builder.task;

  const faction = state.factions.find((entry) => entry.id === builder.factionId);
  assert.ok(faction);
  faction.resources = { wood: 100, stone: 100, food: 100 };

  state.structures = [{
    id: "builder-camp",
    factionId: builder.factionId,
    type: "camp",
    position: { ...builder.position },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 0 },
  }];

  const claimed = state.tiles.find((tile) => tile.x === 8 && tile.y === 5);
  const open = state.tiles.find((tile) => tile.x === 7 && tile.y === 6);
  assert.ok(claimed);
  assert.ok(open);
  claimed.terrain = "plain";
  open.terrain = "plain";
  delete claimed.resource;
  delete open.resource;

  inbound.id = "zz-inbound-builder";
  inbound.position = { x: 6, y: 5 };
  inbound.autonomy = false;
  inbound.task = {
    source: "external",
    issuedAtTick: state.tick,
    type: "build",
    structureType: "market",
    target: { x: claimed.x, y: claimed.y },
  };
  state.agents = [builder, inbound];

  const next = simulate(state).state;
  const moved = next.agents.find((agent) => agent.id === builder.id);
  assert.ok(moved);
  assert.equal(moved.task?.type, "build");
  assert.equal(moved.task?.structureType, "storehouse");
  assert.deepEqual(moved.task?.target, { x: open.x, y: open.y });
  assert.deepEqual(moved.position, { x: open.x, y: open.y });
});
