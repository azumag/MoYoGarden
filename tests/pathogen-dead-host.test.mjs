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
    energy: 100,
    capacity: 24,
    inventory: { wood: 0, stone: 0, food: 0 },
    autonomy: true,
    goal: "test",
    status: "idle",
    ...(pathogenLoad === undefined ? {} : { pathogenLoad }),
  };
}

test("dead agents do not acquire new local, reservoir, or halo pathogen burden", () => {
  const directTarget = agent("dead-direct", { x: 1, y: 0 });
  directTarget.hp = 0;
  applyPathogenSteps({
    agents: [agent("living-carrier", { x: 0, y: 0 }, 1), directTarget],
  }, 1);
  assert.equal(
    agentPathogenLoad(directTarget),
    0,
    "death should gate ordinary six-neighbor acquisition as well as shedding",
  );

  const reservoirTarget = agent("dead-reservoir", { x: 0, y: 0 });
  reservoirTarget.hp = 0;
  applyPathogenSteps({
    agents: [reservoirTarget],
    tiles: [{ x: 0, y: 0, pathogenReservoir: 1 }],
  }, 1);
  assert.equal(
    agentPathogenLoad(reservoirTarget),
    0,
    "a corpse on contaminated ground must not become newly infected",
  );

  const haloTarget = agent("dead-halo", { x: 30, y: 11 });
  haloTarget.hp = 0;
  applyPathogenSteps(
    { agents: [haloTarget] },
    0,
    undefined,
    new Map([["30,11", 1]]),
    1,
    new Map([["30,11", 1]]),
  );
  assert.equal(
    agentPathogenLoad(haloTarget),
    0,
    "a corpse must not acquire remote carrier or reservoir burden through a seam",
  );
});
