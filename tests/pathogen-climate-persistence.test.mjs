import assert from "node:assert/strict";
import test from "node:test";
import {
  agentPathogenLoad,
  applyPathogenSteps,
  pathogenClimatePersistence,
} from "../dist-ts/src/pathogen.js";

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

function findPersistentCell(environment) {
  let best = { position: { x: 0, y: 0 }, persistence: -1 };
  for (let y = -32; y <= 32; y += 4) {
    for (let x = -32; x <= 32; x += 4) {
      const position = { x, y };
      const persistence = pathogenClimatePersistence(position, environment);
      if (persistence > best.persistence) best = { position, persistence };
    }
  }
  return best;
}

test("climate preserves existing pathogen burden without creating it from nothing", () => {
  const environment = { worldSeed: 20260912, originX: 0, originY: 0 };
  const { position, persistence } = findPersistentCell(environment);
  assert.ok(persistence > 0.2, "fixture should find a climate that materially supports persistence");

  const susceptible = agent("susceptible", position);
  applyPathogenSteps({ agents: [susceptible] }, 32, environment);
  assert.equal(
    agentPathogenLoad(susceptible),
    0,
    "climate alone must not manufacture pathogen burden without a carrier",
  );

  const climateSupported = agent("supported", position, 0.5);
  const baseline = agent("baseline", position, 0.5);
  applyPathogenSteps({ agents: [climateSupported] }, 1, environment);
  applyPathogenSteps({ agents: [baseline] }, 1);

  assert.ok(
    agentPathogenLoad(climateSupported) > agentPathogenLoad(baseline),
    "supportive climate should slow clearance of an already-present burden",
  );
  assert.ok(
    agentPathogenLoad(climateSupported) < 0.5,
    "supportive climate should preserve rather than amplify burden without exposure",
  );
});
