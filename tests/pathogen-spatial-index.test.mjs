import assert from "node:assert/strict";
import test from "node:test";
import { agentPathogenLoad, applyPathogenSteps } from "../dist-ts/src/pathogen.js";

function agent(id, position, pathogenLoad = undefined) {
  return {
    id,
    name: id,
    factionId: "faction-a",
    role: "forager",
    position: { ...position },
    hp: 100,
    energy: 50,
    capacity: 24,
    inventory: { wood: 0, stone: 0, food: 0 },
    autonomy: true,
    goal: "test",
    status: "idle",
    ...(pathogenLoad === undefined ? {} : { pathogenLoad }),
  };
}

test("local pathogen contact aggregates the same cell and exactly six adjacent hexes", () => {
  const target = agent("target", { x: 10, y: 10 });
  const same = agent("same", { x: 10, y: 10 }, 1);
  const adjacent = [
    agent("e", { x: 11, y: 10 }, 1),
    agent("ne", { x: 11, y: 9 }, 1),
    agent("nw", { x: 10, y: 9 }, 1),
    agent("w", { x: 9, y: 10 }, 1),
    agent("sw", { x: 9, y: 11 }, 1),
    agent("se", { x: 10, y: 11 }, 1),
  ];
  const distant = [
    agent("far-e", { x: 12, y: 10 }, 1),
    agent("far-ne", { x: 12, y: 8 }, 1),
    agent("far-w", { x: 8, y: 10 }, 1),
  ];

  applyPathogenSteps({ agents: [target, ...distant, ...adjacent, same] }, 1);

  const expected = 1 - (1 - 0.11) * Math.pow(1 - 0.06, 6);
  assert.ok(
    Math.abs(agentPathogenLoad(target) - expected) < 1e-12,
    "distance-two carriers must not affect the same+six-neighbor contact union",
  );
});

test("local pathogen contact remains independent of agent array order", () => {
  const population = [
    agent("target", { x: 10, y: 10 }),
    agent("same-a", { x: 10, y: 10 }, 0.56),
    agent("same-b", { x: 10, y: 10 }, 1),
    agent("east", { x: 11, y: 10 }, 0.8),
    agent("north-west", { x: 10, y: 9 }, 0.4),
    agent("far", { x: 14, y: 10 }, 1),
  ];
  const forward = structuredClone(population);
  const reversed = structuredClone(population).reverse();

  applyPathogenSteps({ agents: forward }, 1);
  applyPathogenSteps({ agents: reversed }, 1);

  const forwardTarget = forward.find((candidate) => candidate.id === "target");
  const reversedTarget = reversed.find((candidate) => candidate.id === "target");
  assert.ok(forwardTarget);
  assert.ok(reversedTarget);
  assert.ok(
    Math.abs(agentPathogenLoad(forwardTarget) - agentPathogenLoad(reversedTarget)) < 1e-12,
    "spatial bucketing must preserve order-independent contact pressure",
  );
});
