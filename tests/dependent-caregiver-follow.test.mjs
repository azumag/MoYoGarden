import test from "node:test";
import assert from "node:assert/strict";
import {
  HEX_GRID_DIRECTION_STEPS,
  hexGridDistance,
  isHexGridCell,
} from "../dist-ts/src/hex-grid.js";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import { createInitialWorld, isPassable } from "../dist-ts/src/world.js";

function setupFamily() {
  const state = createInitialWorld({
    worldId: "dependent-follow-test",
    regionId: "garden-1",
    seed: 77123,
    width: 40,
    height: 24,
  });
  for (const agent of state.agents) {
    agent.autonomy = false;
    delete agent.task;
  }

  const caregiver = state.agents[0];
  assert.ok(caregiver);
  const cells = state.tiles.filter((tile) =>
    isHexGridCell(state, tile) && isPassable(state, tile)
  );
  const caregiverCell = cells[0];
  assert.ok(caregiverCell);
  const dependentCell = cells.find((tile) =>
    hexGridDistance(tile, caregiverCell) >= 5
  );
  assert.ok(dependentCell);
  caregiver.position = { x: caregiverCell.x, y: caregiverCell.y };
  caregiver.energy = 90;

  const dependent = {
    id: "agent-dependent-follow-test",
    name: "Young Follower",
    factionId: caregiver.factionId,
    role: "forager",
    position: { x: dependentCell.x, y: dependentCell.y },
    hp: 100,
    energy: 70,
    capacity: 8,
    inventory: { wood: 0, stone: 0, food: 0 },
    autonomy: false,
    goal: "Grow safely before joining settlement work",
    status: "infant; dependent on parents",
    birthTick: 0,
    lifeStage: "infant",
    parents: [caregiver.id, "missing-parent"],
  };
  state.agents.push(dependent);
  return { state, caregiver, dependent };
}

test("dependent takes one hex step toward its current caregiver", () => {
  const { state, caregiver, dependent } = setupFamily();
  const before = hexGridDistance(dependent.position, caregiver.position);

  const next = new WorldRuntime({ state }).tick().state;
  const moved = next.agents.find((agent) => agent.id === dependent.id);
  const residentCaregiver = next.agents.find((agent) => agent.id === caregiver.id);
  assert.ok(moved);
  assert.ok(residentCaregiver);
  assert.equal(hexGridDistance(moved.position, residentCaregiver.position), before - 1);
  assert.equal(moved.autonomy, false);
});

test("dependent caregiver follow never overrides an external task", () => {
  const { state, caregiver, dependent } = setupFamily();
  const outward = Object.values(HEX_GRID_DIRECTION_STEPS)
    .map((step) => ({
      x: dependent.position.x + step.x,
      y: dependent.position.y + step.y,
    }))
    .find((candidate) =>
      isPassable(state, candidate) &&
      hexGridDistance(candidate, caregiver.position) >
        hexGridDistance(dependent.position, caregiver.position)
    );
  assert.ok(outward);
  dependent.task = {
    source: "external",
    issuedAtTick: state.tick,
    type: "move",
    target: { ...outward },
  };

  const next = new WorldRuntime({ state }).tick().state;
  const moved = next.agents.find((agent) => agent.id === dependent.id);
  assert.ok(moved);
  assert.deepEqual(moved.position, outward);
});

test("dependent already beside its caregiver does not get a follow move", () => {
  const { state, caregiver, dependent } = setupFamily();
  const adjacent = Object.values(HEX_GRID_DIRECTION_STEPS)
    .map((step) => ({
      x: caregiver.position.x + step.x,
      y: caregiver.position.y + step.y,
    }))
    .find((candidate) => isPassable(state, candidate));
  assert.ok(adjacent);
  dependent.position = { ...adjacent };

  const next = new WorldRuntime({ state }).tick().state;
  const stayed = next.agents.find((agent) => agent.id === dependent.id);
  assert.ok(stayed);
  assert.deepEqual(stayed.position, adjacent);
  assert.equal(stayed.task, undefined);
});
