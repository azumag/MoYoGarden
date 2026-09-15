import assert from "node:assert/strict";
import test from "node:test";
import { simulate } from "../dist-ts/src/simulation.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

const ORIGIN = { x: 7, y: 5 };
const EAST = { x: 8, y: 5 };
const SOUTHEAST = { x: 7, y: 6 };
const FAR_EAST = { x: 9, y: 5 };

function fixture() {
  const state = createInitialWorld({ seed: 26091542, width: 16, height: 12 });
  for (const tile of state.tiles) {
    tile.terrain = "plain";
    delete tile.resource;
  }
  state.structures = [];
  state.events = [];
  state.processedCommandIds = [];
  const template = state.agents.find((agent) => agent.role === "woodcutter") ?? state.agents[0];
  assert.ok(template);
  template.position = { ...ORIGIN };
  template.energy = 100;
  template.inventory = { wood: 0, stone: 0, food: 0 };
  template.autonomy = true;
  delete template.task;
  const makeBlocker = (id) => ({
    ...template,
    id,
    name: id,
    position: { ...ORIGIN },
    inventory: { wood: 0, stone: 0, food: 0 },
    autonomy: false,
    task: undefined,
  });
  return { state, worker: template, makeBlocker };
}

function putWood(state, position) {
  const tile = state.tiles.find((entry) => entry.x === position.x && entry.y === position.y);
  assert.ok(tile);
  tile.resource = { kind: "wood", amount: 20, maxAmount: 20 };
}

function reserveGather(agent, target) {
  agent.task = {
    source: "autonomy",
    issuedAtTick: 1,
    type: "gather",
    resource: "wood",
    target: { ...target },
  };
}

test("persisted autonomous gather intent rebalances to an equally near open resource", () => {
  const { state, worker, makeBlocker } = fixture();
  putWood(state, EAST);
  putWood(state, SOUTHEAST);
  reserveGather(worker, EAST);
  const blockerA = makeBlocker("gather-reservation-a");
  const blockerB = makeBlocker("gather-reservation-b");
  reserveGather(blockerA, EAST);
  reserveGather(blockerB, EAST);
  state.agents = [worker, blockerA, blockerB];

  const next = simulate(state).state;
  const moved = next.agents.find((agent) => agent.id === worker.id);
  assert.ok(moved);
  assert.equal(moved.task?.type, "gather");
  assert.deepEqual(moved.task.target, SOUTHEAST);
  assert.deepEqual(moved.position, SOUTHEAST);
});

test("persisted gather intent never takes a longer detour merely to avoid congestion", () => {
  const { state, worker, makeBlocker } = fixture();
  putWood(state, EAST);
  putWood(state, FAR_EAST);
  reserveGather(worker, EAST);
  const blockerA = makeBlocker("gather-distance-a");
  const blockerB = makeBlocker("gather-distance-b");
  reserveGather(blockerA, EAST);
  reserveGather(blockerB, EAST);
  state.agents = [worker, blockerA, blockerB];

  const next = simulate(state).state;
  const moved = next.agents.find((agent) => agent.id === worker.id);
  assert.ok(moved);
  assert.equal(moved.task?.type, "gather");
  assert.deepEqual(moved.task.target, EAST);
  assert.deepEqual(moved.position, EAST);
});

function camp(id, factionId, position) {
  return {
    id,
    factionId,
    type: "camp",
    position: { ...position },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 0 },
  };
}

function reserveDeposit(agent, structureId) {
  agent.inventory = { wood: 2, stone: 0, food: 0 };
  agent.task = {
    source: "autonomy",
    issuedAtTick: 1,
    type: "deposit",
    structureId,
  };
}

test("persisted autonomous deposit intent rebalances to an equally near open store", () => {
  const { state, worker, makeBlocker } = fixture();
  const crowded = camp("crowded-store", worker.factionId, EAST);
  const open = camp("open-store", worker.factionId, SOUTHEAST);
  state.structures = [crowded, open];
  reserveDeposit(worker, crowded.id);
  const blockerA = makeBlocker("deposit-reservation-a");
  const blockerB = makeBlocker("deposit-reservation-b");
  reserveDeposit(blockerA, crowded.id);
  reserveDeposit(blockerB, crowded.id);
  state.agents = [worker, blockerA, blockerB];

  const next = simulate(state).state;
  const moved = next.agents.find((agent) => agent.id === worker.id);
  assert.ok(moved);
  assert.equal(moved.task?.type, "deposit");
  assert.equal(moved.task.structureId, open.id);
  assert.deepEqual(moved.position, open.position);
});

test("external gather intent is not rewritten by autonomous crowd balancing", () => {
  const { state, worker, makeBlocker } = fixture();
  putWood(state, EAST);
  putWood(state, SOUTHEAST);
  worker.task = {
    source: "external",
    issuedAtTick: 1,
    type: "gather",
    resource: "wood",
    target: { ...EAST },
  };
  const blockerA = makeBlocker("external-safety-a");
  const blockerB = makeBlocker("external-safety-b");
  reserveGather(blockerA, EAST);
  reserveGather(blockerB, EAST);
  state.agents = [worker, blockerA, blockerB];

  const next = simulate(state).state;
  const moved = next.agents.find((agent) => agent.id === worker.id);
  assert.ok(moved);
  assert.equal(moved.task?.source, "external");
  assert.deepEqual(moved.task?.target, EAST);
  assert.deepEqual(moved.position, EAST);
});
