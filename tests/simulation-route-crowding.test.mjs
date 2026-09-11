import assert from "node:assert/strict";
import test from "node:test";
import { simulate } from "../dist-ts/src/simulation.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("movement minimizes cumulative crowding across equally short hex routes", () => {
  const state = createInitialWorld({ seed: 2412, width: 16, height: 12 });
  for (const tile of state.tiles) {
    tile.terrain = "plain";
    tile.elevation = 0.5;
    delete tile.resource;
    delete tile.flowTo;
    tile.drainage = 0;
    tile.erosionPressure = 0;
  }

  const mover = state.agents[0];
  assert.ok(mover);
  mover.position = { x: 7, y: 5 };
  mover.autonomy = false;
  mover.energy = 100;
  delete mover.task;

  const blockers = state.agents.slice(1, 4);
  assert.equal(blockers.length, 3);
  for (const blocker of blockers) {
    blocker.position = { x: 9, y: 4 };
    blocker.autonomy = false;
    delete blocker.task;
  }
  state.agents = [mover, ...blockers];

  const obstacle = state.tiles.find((tile) => tile.x === 7 && tile.y === 4);
  assert.ok(obstacle);
  obstacle.terrain = "water";
  obstacle.elevation = 0;

  const target = { x: 12, y: 1 };
  const next = simulate(state, [{
    id: "move-around-crowded-corridor",
    agentId: mover.id,
    submittedAtTick: state.tick,
    type: "move",
    target,
  }]).state;
  const moved = next.agents.find((agent) => agent.id === mover.id);
  assert.ok(moved);

  // Both east and north-east begin a five-step shortest route. East looks empty
  // at the first step but its shortest continuation crosses the occupied 9,4
  // cell. Prefer the equally short north-east corridor instead of creating a
  // queue behind the crowd.
  assert.deepEqual(moved.position, { x: 8, y: 4 });
  assert.equal(moved.task?.type, "move");
  assert.deepEqual(moved.task?.target, target);
});
