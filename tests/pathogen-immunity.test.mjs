import assert from "node:assert/strict";
import test from "node:test";
import {
  agentPathogenImmunity,
  agentPathogenLoad,
  applyPathogenSteps,
} from "../dist-ts/src/pathogen.js";

function agent(id, position, pathogenLoad = undefined, pathogenImmunity = undefined) {
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
    ...(pathogenImmunity === undefined ? {} : { pathogenImmunity }),
  };
}

test("prior infectious burden builds waning protection that reduces reinfection", () => {
  const exposed = agent("exposed", { x: 0, y: 0 }, 0.8);
  applyPathogenSteps({ agents: [exposed] }, 8);
  const acquired = agentPathogenImmunity(exposed);
  assert.ok(acquired > 0.05, "sustained infectious burden should build measurable protection");

  const naive = agent("naive", { x: 1, y: 0 });
  const protectedAgent = agent("protected", { x: 1, y: 0 }, undefined, acquired);
  const naiveCarrier = agent("carrier-naive", { x: 0, y: 0 }, 1);
  const protectedCarrier = agent("carrier-protected", { x: 0, y: 0 }, 1);

  applyPathogenSteps({ agents: [naiveCarrier, naive] }, 1);
  applyPathogenSteps({ agents: [protectedCarrier, protectedAgent] }, 1);

  assert.ok(agentPathogenLoad(naive) > 0, "fixture should transmit to a naive adjacent BOT");
  assert.ok(
    agentPathogenLoad(protectedAgent) < agentPathogenLoad(naive),
    "acquired protection should lower the same adjacent exposure without making immunity absolute",
  );

  delete exposed.pathogenLoad;
  const beforeWaning = agentPathogenImmunity(exposed);
  applyPathogenSteps({ agents: [exposed] }, 20);
  assert.ok(agentPathogenImmunity(exposed) > 0, "protection should not disappear abruptly");
  assert.ok(
    agentPathogenImmunity(exposed) < beforeWaning,
    "protection should gradually wane when pathogen pressure is gone",
  );
});

test("acquired protection also reduces exact halo exposure", () => {
  const position = { x: 30, y: 11 };
  const naive = agent("naive-halo", position);
  const protectedAgent = agent("protected-halo", position, undefined, 0.6);
  const haloPressure = new Map([[`${position.x},${position.y}`, 1]]);

  applyPathogenSteps({ agents: [naive] }, 0, undefined, haloPressure, 1);
  applyPathogenSteps({ agents: [protectedAgent] }, 0, undefined, haloPressure, 1);

  assert.ok(agentPathogenLoad(naive) > 0);
  assert.ok(
    agentPathogenLoad(protectedAgent) < agentPathogenLoad(naive),
    "region seams should obey the same susceptibility as local six-neighbor contact",
  );
});
