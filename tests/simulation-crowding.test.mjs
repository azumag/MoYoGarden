import assert from "node:assert/strict";
import test from "node:test";
import { simulate } from "../dist-ts/src/simulation.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function plainResourceFixture() {
  const state = createInitialWorld({ seed: 2401, width: 16, height: 12 });
  for (const tile of state.tiles) {
    if (tile.terrain !== "water") tile.terrain = "plain";
    delete tile.resource;
  }
  state.structures = [];
  state.events = [];
  state.processedCommandIds = [];
  return state;
}

test("autonomous gatherer prefers the less crowded resource hex when distance is tied", () => {
  const state = plainResourceFixture();
  const worker = state.agents.find((agent) => agent.role === "woodcutter");
  assert.ok(worker);

  worker.position = { x: 7, y: 5 };
  worker.energy = 100;
  worker.inventory = { wood: 0, stone: 0, food: 0 };
  worker.autonomy = true;
  delete worker.task;

  const crowded = state.tiles.find((tile) => tile.x === 8 && tile.y === 5);
  const open = state.tiles.find((tile) => tile.x === 7 && tile.y === 6);
  assert.ok(crowded);
  assert.ok(open);
  crowded.terrain = "forest";
  crowded.resource = { kind: "wood", amount: 20, maxAmount: 20 };
  open.terrain = "forest";
  open.resource = { kind: "wood", amount: 20, maxAmount: 20 };

  const blockers = state.agents
    .filter((agent) => agent.id !== worker.id)
    .slice(0, 3);
  assert.equal(blockers.length, 3);
  for (const blocker of blockers) {
    blocker.position = { x: crowded.x, y: crowded.y };
    blocker.autonomy = false;
    delete blocker.task;
  }
  state.agents = [worker, ...blockers];

  const next = simulate(state).state;
  const moved = next.agents.find((agent) => agent.id === worker.id);
  assert.ok(moved);
  assert.deepEqual(moved.position, { x: open.x, y: open.y });
  assert.equal(moved.task?.type, "gather");
  assert.deepEqual(moved.task?.target, { x: open.x, y: open.y });
});

test("resource distance remains authoritative over crowding", () => {
  const state = plainResourceFixture();
  const worker = state.agents.find((agent) => agent.role === "woodcutter");
  assert.ok(worker);

  worker.position = { x: 7, y: 5 };
  worker.energy = 100;
  worker.inventory = { wood: 0, stone: 0, food: 0 };
  worker.autonomy = true;
  delete worker.task;

  const near = state.tiles.find((tile) => tile.x === 8 && tile.y === 5);
  const far = state.tiles.find((tile) => tile.x === 9 && tile.y === 5);
  assert.ok(near);
  assert.ok(far);
  near.terrain = "forest";
  near.resource = { kind: "wood", amount: 20, maxAmount: 20 };
  far.terrain = "forest";
  far.resource = { kind: "wood", amount: 20, maxAmount: 20 };

  const blockers = state.agents
    .filter((agent) => agent.id !== worker.id)
    .slice(0, 3);
  for (const blocker of blockers) {
    blocker.position = { x: near.x, y: near.y };
    blocker.autonomy = false;
    delete blocker.task;
  }
  state.agents = [worker, ...blockers];

  const next = simulate(state).state;
  const moved = next.agents.find((agent) => agent.id === worker.id);
  assert.ok(moved);
  assert.deepEqual(moved.task?.target, { x: near.x, y: near.y });
  assert.deepEqual(moved.position, { x: near.x, y: near.y });
});
