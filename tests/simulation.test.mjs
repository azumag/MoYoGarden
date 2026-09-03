import assert from "node:assert/strict";
import test from "node:test";
import { emptyInventory } from "../dist-ts/src/protocol.js";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import { simulate } from "../dist-ts/src/simulation.js";
import { createInitialWorld, getPerception, validateWorldState } from "../dist-ts/src/world.js";

function advance(initial, ticks) {
  let state = initial;
  for (let index = 0; index < ticks; index += 1) state = simulate(state).state;
  return state;
}

test("same seed produces the same world", () => {
  assert.deepEqual(advance(createInitialWorld({ seed: 123456 }), 160), advance(createInitialWorld({ seed: 123456 }), 160));
});

test("autonomous factions complete the settlement loop", () => {
  const state = advance(createInitialWorld({ seed: 424242 }), 120);
  assert.deepEqual(validateWorldState(state), []);
  for (const faction of state.factions) {
    for (const type of ["camp", "storehouse", "market", "workshop"]) {
      assert.ok(state.structures.some((entry) => entry.factionId === faction.id && entry.type === type && entry.status === "active"));
    }
  }
});

test("perception remains local", () => {
  const state = createInitialWorld({ seed: 777 });
  const self = state.agents.find((agent) => agent.factionId === "ember");
  assert.ok(self);
  const perception = getPerception(state, self.id, 2);
  assert.equal(perception.radius, 2);
  assert.ok(perception.visibleTiles.length < state.tiles.length);
  assert.ok(perception.visibleTiles.every((tile) => Math.abs(tile.x-self.position.x)+Math.abs(tile.y-self.position.y) <= 2));
});

test("pending commands survive hibernation", () => {
  const runtime = new WorldRuntime({ seed: 99 });
  const agent = runtime.snapshot().agents[0]; assert.ok(agent);
  assert.equal(runtime.submit(agent.id, { id:"persisted-goal", type:"set_goal", goal:"Build a northern relay camp" }).accepted, true);
  const restored = new WorldRuntime({ state:runtime.snapshot(), pendingCommands:runtime.pendingCommands() });
  restored.tick();
  assert.equal(restored.snapshot().agents.find((entry)=>entry.id===agent.id)?.goal, "Build a northern relay camp");
});

test("trade is atomic", () => {
  const state=createInitialWorld({seed:42}), seller=state.agents[0], buyer=state.agents[1]; assert.ok(seller); assert.ok(buyer);
  buyer.position={...seller.position}; seller.inventory={wood:5,stone:0,food:0}; buyer.inventory={wood:0,stone:3,food:0};
  const result=simulate(state,[{id:"trade-test",agentId:seller.id,submittedAtTick:state.tick,type:"trade",targetAgentId:buyer.id,offer:{wood:2,stone:0,food:0},request:{wood:0,stone:1,food:0}}]);
  assert.equal(result.receipts[0]?.accepted,true);
  assert.deepEqual(result.state.agents.find((entry)=>entry.id===seller.id)?.inventory,{wood:3,stone:1,food:0});
  assert.deepEqual(result.state.agents.find((entry)=>entry.id===buyer.id)?.inventory,{wood:2,stone:2,food:0});
  assert.deepEqual(emptyInventory(),{wood:0,stone:0,food:0});
});

test("low-energy autonomous agents eat carried food before resuming work", () => {
  const state = createInitialWorld({ seed: 2026 });
  const agent = state.agents[0]; assert.ok(agent);
  agent.energy = 10;
  agent.inventory.food = 1;
  delete agent.task;

  const runtime = new WorldRuntime({ state });
  const next = runtime.tick().state;
  const rested = next.agents.find((entry) => entry.id === agent.id); assert.ok(rested);

  assert.equal(rested.inventory.food, 0);
  assert.equal(rested.energy, 45);
  assert.equal(rested.status, "resting after a meal");
  assert.equal(rested.autonomy, true);
  assert.equal(rested.task, undefined);
});

test("hungry autonomous agents accept surplus food from a nearby ally", () => {
  const state = createInitialWorld({ seed: 2027 });
  const hungry = state.agents[0]; assert.ok(hungry);
  const donor = state.agents[1]; assert.ok(donor);
  assert.equal(hungry.factionId, donor.factionId);

  hungry.energy = 10;
  hungry.inventory.food = 0;
  delete hungry.task;
  donor.position = { ...hungry.position };
  donor.energy = 90;
  donor.inventory.food = 2;
  delete donor.task;

  const runtime = new WorldRuntime({ state });
  const next = runtime.tick().state;
  const rested = next.agents.find((entry) => entry.id === hungry.id); assert.ok(rested);
  const sharedBy = next.agents.find((entry) => entry.id === donor.id); assert.ok(sharedBy);

  assert.equal(rested.inventory.food, 0);
  assert.equal(rested.energy, 45);
  assert.equal(sharedBy.inventory.food, 1);
  assert.equal(rested.status, `resting after ${donor.name} shared food`);
  assert.equal(rested.task, undefined);
});
