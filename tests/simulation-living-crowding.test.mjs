import assert from "node:assert/strict";
import test from "node:test";
import { simulate } from "../dist-ts/src/simulation.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function plainFixture(seed = 2420) {
  const state = createInitialWorld({ seed, width: 16, height: 12 });
  for (const tile of state.tiles) {
    tile.terrain = "plain";
    tile.elevation = 0.5;
    delete tile.resource;
    delete tile.flowTo;
    tile.drainage = 0;
    tile.erosionPressure = 0;
  }
  state.structures = [];
  state.events = [];
  state.processedCommandIds = [];
  return state;
}

function makeCorpses(state, survivorId, count, position) {
  const corpses = state.agents.filter((agent) => agent.id !== survivorId).slice(0, count);
  assert.equal(corpses.length, count);
  for (const corpse of corpses) {
    corpse.position = { ...position };
    corpse.autonomy = false;
    corpse.hp = 0;
    delete corpse.task;
  }
  return corpses;
}

test("dead agents do not influence shortest-route crowding", () => {
  const run = (includeCorpses) => {
    const state = plainFixture(2421);
    const mover = state.agents[0];
    assert.ok(mover);
    mover.position = { x: 7, y: 5 };
    mover.autonomy = false;
    mover.energy = 100;
    mover.hp = 100;
    delete mover.task;
    const corpses = makeCorpses(state, mover.id, 3, { x: 9, y: 4 });
    state.agents = includeCorpses ? [mover, ...corpses] : [mover];
    const obstacle = state.tiles.find((tile) => tile.x === 7 && tile.y === 4);
    assert.ok(obstacle);
    obstacle.terrain = "water";
    obstacle.elevation = 0;
    const target = { x: 12, y: 1 };
    const next = simulate(state, [{
      id: includeCorpses ? "route-with-corpses" : "route-baseline",
      agentId: mover.id,
      submittedAtTick: state.tick,
      type: "move",
      target,
    }]).state;
    return next.agents.find((agent) => agent.id === mover.id)?.position;
  };
  assert.deepEqual(run(true), run(false));
});

test("dead agents do not bias resource target congestion", () => {
  const state = plainFixture(2422);
  const worker = state.agents.find((agent) => agent.role === "woodcutter");
  assert.ok(worker);
  worker.position = { x: 7, y: 5 };
  worker.energy = 100;
  worker.hp = 100;
  worker.inventory = { wood: 0, stone: 0, food: 0 };
  worker.autonomy = true;
  delete worker.task;
  const preferred = state.tiles.find((tile) => tile.x === 8 && tile.y === 5);
  const alternate = state.tiles.find((tile) => tile.x === 7 && tile.y === 6);
  assert.ok(preferred);
  assert.ok(alternate);
  preferred.terrain = "forest";
  preferred.resource = { kind: "wood", amount: 20, maxAmount: 20 };
  alternate.terrain = "forest";
  alternate.resource = { kind: "wood", amount: 20, maxAmount: 20 };
  const corpses = makeCorpses(state, worker.id, 3, preferred);
  state.agents = [worker, ...corpses];
  const next = simulate(state).state;
  const moved = next.agents.find((agent) => agent.id === worker.id);
  assert.ok(moved);
  assert.deepEqual(moved.task?.target, { x: preferred.x, y: preferred.y });
});

test("dead agents do not bias deposit target congestion", () => {
  const state = plainFixture(2423);
  const worker = state.agents.find((agent) => agent.role === "woodcutter");
  assert.ok(worker);
  worker.position = { x: 7, y: 5 };
  worker.energy = 100;
  worker.hp = 100;
  worker.inventory = { wood: 6, stone: 0, food: 0 };
  worker.autonomy = true;
  delete worker.task;
  const preferred = {
    id: "a-preferred-store",
    factionId: worker.factionId,
    type: "camp",
    position: { x: 8, y: 5 },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 0 },
  };
  const alternate = {
    ...preferred,
    id: "z-alternate-store",
    position: { x: 7, y: 6 },
    storage: { wood: 0, stone: 0, food: 0 },
  };
  state.structures = [preferred, alternate];
  const corpses = makeCorpses(state, worker.id, 3, preferred.position);
  state.agents = [worker, ...corpses];
  const next = simulate(state).state;
  const moved = next.agents.find((agent) => agent.id === worker.id);
  assert.ok(moved);
  assert.equal(moved.task?.type, "deposit");
  assert.equal(moved.task?.structureId, preferred.id);
});

test("dead agents do not bias autonomous build congestion", () => {
  const state = plainFixture(2424);
  const builder = state.agents.find((agent) => agent.role === "builder");
  assert.ok(builder);
  builder.position = { x: 7, y: 5 };
  builder.energy = 100;
  builder.hp = 100;
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
  for (const tile of state.tiles) {
    if (tile.terrain === "water") continue;
    tile.resource = { kind: "food", amount: 1, maxAmount: 1 };
  }
  const preferred = state.tiles.find((tile) => tile.x === 8 && tile.y === 5);
  const alternate = state.tiles.find((tile) => tile.x === 7 && tile.y === 6);
  assert.ok(preferred);
  assert.ok(alternate);
  delete preferred.resource;
  delete alternate.resource;
  const corpses = makeCorpses(state, builder.id, 3, preferred);
  const otherFaction = state.factions.find((entry) => entry.id !== builder.factionId);
  assert.ok(otherFaction);
  for (const corpse of corpses) corpse.factionId = otherFaction.id;
  state.agents = [builder, ...corpses];
  const next = simulate(state).state;
  const moved = next.agents.find((agent) => agent.id === builder.id);
  assert.ok(moved);
  assert.equal(moved.task?.type, "build");
  assert.deepEqual(moved.task?.target, { x: preferred.x, y: preferred.y });
});

test("dead agents do not throttle same-cell gather throughput", () => {
  const state = plainFixture(2425);
  const worker = state.agents.find((agent) => agent.role === "woodcutter");
  assert.ok(worker);
  const target = state.tiles.find((tile) => tile.x === 7 && tile.y === 5);
  assert.ok(target);
  target.terrain = "forest";
  target.resource = { kind: "wood", amount: 20, maxAmount: 20 };
  worker.position = { x: target.x, y: target.y };
  worker.energy = 100;
  worker.hp = 100;
  worker.inventory = { wood: 0, stone: 0, food: 0 };
  worker.autonomy = false;
  worker.task = {
    source: "autonomy",
    issuedAtTick: state.tick,
    type: "gather",
    resource: "wood",
    target: { x: target.x, y: target.y },
  };
  const corpses = makeCorpses(state, worker.id, 2, target);
  state.agents = [worker, ...corpses];
  const next = simulate(state).state;
  const gathered = next.agents.find((agent) => agent.id === worker.id);
  const remaining = next.tiles.find((tile) => tile.x === target.x && tile.y === target.y);
  assert.ok(gathered);
  assert.ok(remaining?.resource);
  assert.equal(gathered.inventory.wood, 2);
  assert.equal(remaining.resource.amount, 18);
});

test("dead agents do not throttle same-cell deposit throughput", () => {
  const state = plainFixture(2426);
  const worker = state.agents.find((agent) => agent.role === "woodcutter");
  assert.ok(worker);
  const faction = state.factions.find((entry) => entry.id === worker.factionId);
  assert.ok(faction);
  const store = {
    id: "corpse-free-throughput-store",
    factionId: worker.factionId,
    type: "camp",
    position: { x: 7, y: 5 },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 0 },
  };
  state.structures = [store];
  worker.position = { ...store.position };
  worker.energy = 100;
  worker.hp = 100;
  worker.inventory = { wood: 6, stone: 0, food: 0 };
  worker.autonomy = false;
  worker.task = {
    source: "autonomy",
    issuedAtTick: state.tick,
    type: "deposit",
    structureId: store.id,
  };
  const corpses = makeCorpses(state, worker.id, 2, store.position);
  state.agents = [worker, ...corpses];
  const woodBefore = faction.resources.wood;
  const next = simulate(state).state;
  const depositor = next.agents.find((agent) => agent.id === worker.id);
  const nextStore = next.structures.find((structure) => structure.id === store.id);
  const nextFaction = next.factions.find((entry) => entry.id === worker.factionId);
  assert.ok(depositor);
  assert.ok(nextStore);
  assert.ok(nextFaction);
  assert.equal(depositor.inventory.wood, 0);
  assert.equal(nextStore.storage.wood, 6);
  assert.equal(nextFaction.resources.wood, woodBefore + 6);
  assert.equal(depositor.task, undefined);
});
