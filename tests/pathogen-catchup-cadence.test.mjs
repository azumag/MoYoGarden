import assert from "node:assert/strict";
import test from "node:test";
import {
  agentPathogenLoad,
  applyPathogenSteps,
  applyPathogenTickRange,
} from "../dist-ts/src/pathogen.js";

function agent(id) {
  return {
    id,
    name: id,
    factionId: "faction-a",
    role: "forager",
    position: { x: 30, y: 11 },
    hp: 100,
    energy: 50,
    capacity: 24,
    inventory: { wood: 0, stone: 0, food: 0 },
    autonomy: true,
    goal: "test",
    status: "idle",
  };
}

test("virtual catch-up preserves local-before-halo cadence ordering", () => {
  const haloPressure = new Map([["30,11", 1]]);

  const ranged = agent("ranged");
  applyPathogenTickRange(
    { agents: [ranged], tiles: [] },
    24,
    36,
    undefined,
    haloPressure,
  );

  const sequential = agent("sequential");
  applyPathogenSteps({ agents: [sequential], tiles: [] }, 1);
  applyPathogenSteps({ agents: [sequential], tiles: [] }, 0, undefined, haloPressure, 1);
  applyPathogenSteps({ agents: [sequential], tiles: [] }, 1);

  const legacyBatched = agent("legacy-batched");
  applyPathogenSteps(
    { agents: [legacyBatched], tiles: [] },
    2,
    undefined,
    haloPressure,
    1,
  );

  assert.ok(Math.abs(agentPathogenLoad(ranged) - agentPathogenLoad(sequential)) < 1e-12);
  assert.ok(
    agentPathogenLoad(ranged) < agentPathogenLoad(legacyBatched),
    "tick-30 exposure should receive the tick-36 recovery during catch-up",
  );
});
