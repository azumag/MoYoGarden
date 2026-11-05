import assert from "node:assert/strict";
import test from "node:test";
import { BUILD_RECIPES } from "../dist-ts/src/protocol.js";
import { simulate } from "../dist-ts/src/simulation.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

const emptyInventory = () => ({ wood: 0, stone: 0, food: 0 });
const SITE = { x: 7, y: 5 };
const EXIT = { x: 7, y: 6 };

function crewState(structureProgress, crewSize = 5) {
  const state = createInitialWorld({ seed: 3907, width: 16, height: 12 });
  for (const tile of state.tiles) {
    if (tile.terrain !== "water") tile.terrain = "plain";
    delete tile.resource;
  }
  const template = state.agents.find((agent) => agent.role === "builder");
  assert.ok(template);

  const builders = [];
  for (let index = 0; index < crewSize; index += 1) {
    const builder = structuredClone(template);
    builder.id = `crew-builder-${index + 1}`;
    builder.name = `Crew Builder ${index + 1}`;
    builder.position = { ...SITE };
    builder.hp = 100;
    builder.energy = 100;
    builder.inventory = emptyInventory();
    builder.autonomy = false;
    builder.task = {
      source: "external",
      issuedAtTick: state.tick,
      type: "build",
      structureType: "camp",
      structureId: "camp-under-construction",
      target: { ...SITE },
    };
    builders.push(builder);
  }
  state.agents = builders;
  state.structures = [{
    id: "camp-under-construction",
    factionId: template.factionId,
    type: "camp",
    position: { ...SITE },
    status: "building",
    progress: structureProgress,
    requiredProgress: BUILD_RECIPES.camp.work,
    storage: emptyInventory(),
  }];
  state.events = [];
  state.processedCommandIds = [];
  return state;
}

test("builders released from an over-capacity build site still obey the crowded departure cap", () => {
  // camp: work 6, workCapacity 2. Five builders on one hex means three wait for
  // work capacity while the structure is unfinished. After the build is done and
  // the crew disperses, that same crowd must still drain through the #60
  // departure cap (2/tick); waiting for work capacity must not bypass it.
  assert.equal(BUILD_RECIPES.camp.workCapacity, 2);

  let state = crewState(0, 5);
  state = simulate(state).state; // progress 0 -> 2, 3 builders wait
  let waiting = state.agents.filter((agent) => agent.status === "waiting for camp work capacity");
  assert.equal(waiting.length, 3, "over-capacity crew members should wait for work capacity");
  for (const agent of waiting) assert.equal(agent.task?.type, "build");

  state = simulate(state).state; // progress 2 -> 4, 3 builders still wait
  waiting = state.agents.filter((agent) => agent.status === "waiting for camp work capacity");
  assert.equal(waiting.length, 3);

  state = simulate(state).state; // progress 4 -> 6, structure completes
  const camp = state.structures.find((structure) => structure.id === "camp-under-construction");
  assert.ok(camp);
  assert.equal(camp.status, "active");

  // One worker may retain build intent until it observes the completed structure;
  // clear every task so the whole released crew attempts to depart from the same
  // crowded hex at once.
  for (const agent of state.agents) {
    agent.autonomy = false;
    agent.task = {
      source: "external",
      issuedAtTick: state.tick,
      type: "move",
      target: { ...EXIT },
    };
  }

  state = simulate(state).state;
  const moved = state.agents.filter((agent) => agent.position.x === EXIT.x && agent.position.y === EXIT.y);
  const queued = state.agents.filter((agent) => agent.status === "waiting in crowd");
  assert.equal(moved.length, 2, "only two builders may leave the crowded hex in one tick");
  assert.equal(queued.length, 3);
  for (const agent of queued) {
    assert.equal(agent.task?.type, "move", "queued departure must keep move intent");
    assert.equal(agent.task?.target?.x, EXIT.x);
    assert.equal(agent.task?.target?.y, EXIT.y);
  }

  state = simulate(state).state;
  assert.ok(
    state.agents.every((agent) => agent.position.x === EXIT.x && agent.position.y === EXIT.y),
    "queued builders must depart on later ticks once the hex drains",
  );
});
