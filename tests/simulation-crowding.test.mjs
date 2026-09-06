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

test("autonomous deposit prefers the less congested structure when distance is tied", () => {
  const state = plainResourceFixture();
  const worker = state.agents.find((agent) => agent.role === "woodcutter");
  const blocker = state.agents.find((agent) => agent.id !== worker?.id && agent.factionId === worker?.factionId);
  assert.ok(worker);
  assert.ok(blocker);

  worker.position = { x: 7, y: 5 };
  worker.energy = 100;
  worker.inventory = { wood: 6, stone: 0, food: 0 };
  worker.autonomy = true;
  delete worker.task;

  const crowded = {
    id: "a-crowded-store",
    factionId: worker.factionId,
    type: "camp",
    position: { x: 8, y: 5 },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 0 },
  };
  const open = {
    ...crowded,
    id: "z-open-store",
    position: { x: 7, y: 6 },
    storage: { wood: 0, stone: 0, food: 0 },
  };
  state.structures = [crowded, open];

  blocker.id = "zz-existing-depositor";
  blocker.factionId = worker.factionId;
  blocker.position = { x: 6, y: 5 };
  blocker.autonomy = false;
  blocker.inventory = { wood: 1, stone: 0, food: 0 };
  blocker.task = {
    source: "autonomy",
    issuedAtTick: state.tick,
    type: "deposit",
    structureId: crowded.id,
  };
  for (const other of state.agents) {
    if (other.id === worker.id || other.id === blocker.id) continue;
    other.autonomy = false;
    delete other.task;
  }
  state.agents = [worker, blocker];

  const next = simulate(state).state;
  const moved = next.agents.find((agent) => agent.id === worker.id);
  assert.ok(moved);
  assert.equal(moved.task?.type, "deposit");
  assert.equal(moved.task?.structureId, open.id);
  assert.deepEqual(moved.position, open.position);
});

test("deposit distance remains authoritative over congestion", () => {
  const state = plainResourceFixture();
  const worker = state.agents.find((agent) => agent.role === "woodcutter");
  const blocker = state.agents.find((agent) => agent.id !== worker?.id && agent.factionId === worker?.factionId);
  assert.ok(worker);
  assert.ok(blocker);

  worker.position = { x: 7, y: 5 };
  worker.energy = 100;
  worker.inventory = { wood: 6, stone: 0, food: 0 };
  worker.autonomy = true;
  delete worker.task;

  const near = {
    id: "a-near-store",
    factionId: worker.factionId,
    type: "camp",
    position: { x: 8, y: 5 },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 0 },
  };
  const far = {
    ...near,
    id: "z-far-store",
    position: { x: 9, y: 5 },
    storage: { wood: 0, stone: 0, food: 0 },
  };
  state.structures = [near, far];

  blocker.id = "zz-existing-depositor";
  blocker.factionId = worker.factionId;
  blocker.position = { x: 6, y: 5 };
  blocker.autonomy = false;
  blocker.inventory = { wood: 1, stone: 0, food: 0 };
  blocker.task = {
    source: "autonomy",
    issuedAtTick: state.tick,
    type: "deposit",
    structureId: near.id,
  };
  state.agents = [worker, blocker];

  const next = simulate(state).state;
  const moved = next.agents.find((agent) => agent.id === worker.id);
  assert.ok(moved);
  assert.equal(moved.task?.type, "deposit");
  assert.equal(moved.task?.structureId, near.id);
  assert.deepEqual(moved.position, near.position);
});
