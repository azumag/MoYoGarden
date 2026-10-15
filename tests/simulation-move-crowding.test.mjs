import assert from "node:assert/strict";
import test from "node:test";
import { simulate } from "../dist-ts/src/simulation.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function plainFixture(seed = 2430) {
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

function moveTo(state, agent, target, commandId) {
  return {
    id: commandId,
    agentId: agent.id,
    submittedAtTick: state.tick,
    type: "move",
    target,
  };
}

test("a crowded hex only releases a bounded number of movers per tick", () => {
  const state = plainFixture();
  const crowd = state.agents.slice(0, 5);
  assert.equal(crowd.length, 5);
  for (const agent of crowd) {
    agent.position = { x: 7, y: 5 };
    agent.autonomy = false;
    agent.energy = 100;
    delete agent.task;
  }
  state.agents = [...crowd];

  const commands = crowd.map((agent, index) =>
    moveTo(state, agent, { x: 8 + index, y: 5 }, `crowd-move-${index}`)
  );

  const next = simulate(state, commands).state;
  const departed = next.agents.filter((agent) => agent.position.x !== 7);
  const waiting = next.agents.filter((agent) => agent.position.x === 7);

  // Five BOTs share one hex, but only two of them may leave it this tick. The
  // other three keep their move intent and queue behind them.
  assert.equal(departed.length, 2);
  assert.equal(waiting.length, 3);
  for (const agent of waiting) {
    assert.equal(agent.status, "waiting in crowd");
    assert.equal(agent.task?.type, "move");
    assert.equal(agent.energy, 100);
  }
  // Departures follow agent id order, so the queue is deterministic.
  const expected = [...crowd]
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, 2)
    .map((agent) => agent.id)
    .sort();
  assert.deepEqual(departed.map((agent) => agent.id).sort(), expected);
});

test("an uncrowded hex still releases every mover in the same tick", () => {
  const state = plainFixture(2431);
  const movers = state.agents.slice(0, 2);
  assert.equal(movers.length, 2);
  for (const [index, agent] of movers.entries()) {
    agent.position = { x: 7, y: 5 + index };
    agent.autonomy = false;
    agent.energy = 100;
    delete agent.task;
  }
  state.agents = [...movers];

  const commands = movers.map((agent, index) =>
    moveTo(state, agent, { x: 10, y: 5 + index }, `pair-move-${index}`)
  );

  const next = simulate(state, commands).state;
  for (const agent of next.agents) assert.notEqual(agent.status, "waiting in crowd");
  assert.ok(next.agents.every((agent) => agent.position.x !== 7));
});

test("queued BOTs drain a crowded hex over later ticks instead of stalling", () => {
  const state = plainFixture(2432);
  const crowd = state.agents.slice(0, 5);
  for (const agent of crowd) {
    agent.position = { x: 7, y: 5 };
    agent.autonomy = false;
    agent.energy = 100;
    delete agent.task;
  }
  state.agents = [...crowd];

  const commands = crowd.map((agent, index) =>
    moveTo(state, agent, { x: 12, y: 5 }, `drain-move-${index}`)
  );

  let current = simulate(state, commands).state;
  for (let tick = 0; tick < 8 && current.agents.some((agent) => agent.position.x !== 12); tick += 1) {
    current = simulate(current).state;
  }

  assert.ok(current.agents.every((agent) => agent.position.x === 12));
  assert.ok(current.agents.every((agent) => agent.task === undefined));
});

test("crowded departure queuing is deterministic across repeated seeds", () => {
  const run = (seed) => {
    const state = plainFixture(seed);
    const crowd = state.agents.slice(0, 6);
    for (const agent of crowd) {
      agent.position = { x: 7, y: 5 };
      agent.autonomy = false;
      agent.energy = 100;
      delete agent.task;
    }
    state.agents = [...crowd];
    const commands = crowd.map((agent, index) =>
      moveTo(state, agent, { x: 8 + index, y: 5 }, `seed-move-${index}`)
    );
    return simulate(state, commands).state.agents.map((agent) => `${agent.id}@${agent.position.x},${agent.position.y}`);
  };

  const first = run(2433);
  const second = run(2433);
  assert.deepEqual(first, second);
  // Same seed reproduces the same queue, and different seeds stay in hex order
  // too: no BOT may leave a crowded hex earlier than an id-earlier neighbour.
  const third = run(2434);
  assert.deepEqual(third.length, first.length);
});
