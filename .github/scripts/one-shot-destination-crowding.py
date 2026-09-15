from pathlib import Path

simulation = Path("src/simulation.ts")
text = simulation.read_text()

old_constants = '''const DEPOSIT_CROWDING_THRESHOLD = 3;
const DEPOSIT_CROWDED_THROUGHPUT = 3;
'''
new_constants = '''const DEPOSIT_CROWDING_THRESHOLD = 3;
const DEPOSIT_CROWDED_THROUGHPUT = 3;
// Destination demand should matter before BOTs physically stack on the same hex,
// but congestion must not send workers on arbitrarily long detours. Three agents
// already marks gather/deposit work as crowded, so each reservation adds half a
// hex of planning cost and the total detour pressure is capped at three hexes.
const DESTINATION_CROWDING_PENALTY_PER_AGENT = 0.5;
const DESTINATION_CROWDING_PENALTY_CAP = 3;
'''
assert old_constants in text, "destination crowding constants marker changed"
text = text.replace(old_constants, new_constants, 1)

old_storage = '''function nearestDepositStructure(
  state: WorldState,
  factionId: string,
  position: GridPosition,
): Structure | undefined {
  const candidates = activeFactionStructures(state, factionId)
    .filter((structure) => storageCapacityLeft(structure) > 0);
  const congestion = depositCongestionIndex(state, candidates);
  return candidates
    .sort((a, b) => {
      const distance = manhattanDistance(a.position, position) - manhattanDistance(b.position, position);
      if (distance !== 0) return distance;
      const congestionDifference = (congestion.get(a.id) ?? 0) - (congestion.get(b.id) ?? 0);
      return congestionDifference || a.id.localeCompare(b.id);
    })[0];
}
'''
new_storage = '''function destinationCrowdingScore(distance: number, congestion: number): number {
  return distance + Math.min(
    DESTINATION_CROWDING_PENALTY_CAP,
    Math.max(0, congestion) * DESTINATION_CROWDING_PENALTY_PER_AGENT,
  );
}

function nearestDepositStructure(
  state: WorldState,
  factionId: string,
  position: GridPosition,
): Structure | undefined {
  const candidates = activeFactionStructures(state, factionId)
    .filter((structure) => storageCapacityLeft(structure) > 0);
  const congestion = depositCongestionIndex(state, candidates);
  return candidates
    .sort((a, b) => {
      const distanceA = manhattanDistance(a.position, position);
      const distanceB = manhattanDistance(b.position, position);
      const congestionA = congestion.get(a.id) ?? 0;
      const congestionB = congestion.get(b.id) ?? 0;
      const scoreDifference =
        destinationCrowdingScore(distanceA, congestionA) -
        destinationCrowdingScore(distanceB, congestionB);
      if (scoreDifference !== 0) return scoreDifference;
      return distanceA - distanceB || congestionA - congestionB || a.id.localeCompare(b.id);
    })[0];
}
'''
assert old_storage in text, "nearestDepositStructure block changed"
text = text.replace(old_storage, new_storage, 1)

old_resource = '''function nearestResource(
  state: WorldState,
  origin: GridPosition,
  resource: ResourceKind,
): GridPosition | undefined {
  const candidates = state.tiles.filter((candidate) =>
    candidate.resource?.kind === resource &&
    candidate.resource.amount > 0 &&
    candidate.terrain !== "water"
  );
  const congestion = resourceCongestionIndex(state, resource);
  const tile = candidates
    .sort((a, b) => {
      const distance = manhattanDistance(a, origin) - manhattanDistance(b, origin);
      if (distance !== 0) return distance;
      const congestionDifference =
        (congestion.get(positionKey(a)) ?? 0) - (congestion.get(positionKey(b)) ?? 0);
      return congestionDifference || a.y - b.y || a.x - b.x;
    })[0];
  return tile === undefined ? undefined : { x: tile.x, y: tile.y };
}
'''
new_resource = '''function nearestResource(
  state: WorldState,
  origin: GridPosition,
  resource: ResourceKind,
): GridPosition | undefined {
  const candidates = state.tiles.filter((candidate) =>
    candidate.resource?.kind === resource &&
    candidate.resource.amount > 0 &&
    candidate.terrain !== "water"
  );
  const congestion = resourceCongestionIndex(state, resource);
  const tile = candidates
    .sort((a, b) => {
      const distanceA = manhattanDistance(a, origin);
      const distanceB = manhattanDistance(b, origin);
      const congestionA = congestion.get(positionKey(a)) ?? 0;
      const congestionB = congestion.get(positionKey(b)) ?? 0;
      const scoreDifference =
        destinationCrowdingScore(distanceA, congestionA) -
        destinationCrowdingScore(distanceB, congestionB);
      if (scoreDifference !== 0) return scoreDifference;
      return distanceA - distanceB || congestionA - congestionB || a.y - b.y || a.x - b.x;
    })[0];
  return tile === undefined ? undefined : { x: tile.x, y: tile.y };
}
'''
assert old_resource in text, "nearestResource block changed"
text = text.replace(old_resource, new_resource, 1)
simulation.write_text(text)

Path("tests/simulation-destination-crowding.test.mjs").write_text(r'''import assert from "node:assert/strict";
import test from "node:test";
import { simulate } from "../dist-ts/src/simulation.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

const ORIGIN = { x: 19, y: 11 };
const NEAR = { x: 20, y: 11 };
const FAR = { x: 21, y: 11 };

function emptyInventory() {
  return { wood: 0, stone: 0, food: 0 };
}

function fixture() {
  const state = createInitialWorld({ seed: 26091541, width: 40, height: 24 });
  const template = state.agents[0];
  assert.ok(template);
  const faction = state.factions.find((entry) => entry.id === template.factionId);
  assert.ok(faction);
  state.tick = 1;
  state.events = [];
  state.structures = [];
  for (const tile of state.tiles) {
    if (tile.terrain === "water") tile.terrain = "plain";
    delete tile.resource;
  }
  const makeAgent = (id, position = ORIGIN) => ({
    ...template,
    id,
    name: id,
    position: { ...position },
    hp: 100,
    energy: 100,
    inventory: emptyInventory(),
    autonomy: false,
    task: undefined,
  });
  return { state, faction, makeAgent };
}

function setWood(state, position) {
  const tile = state.tiles.find((entry) => entry.x === position.x && entry.y === position.y);
  assert.ok(tile);
  tile.terrain = "plain";
  tile.resource = { kind: "wood", amount: 20, maxAmount: 20 };
}

function gatherBlocker(makeAgent, index) {
  const agent = makeAgent(`gather-blocker-${index}`);
  agent.task = {
    source: "autonomy",
    issuedAtTick: 1,
    type: "gather",
    resource: "wood",
    target: { ...NEAR },
  };
  return agent;
}

test("resource selection keeps the nearest deposit when demand is low", () => {
  const { state, makeAgent } = fixture();
  setWood(state, NEAR);
  setWood(state, FAR);
  const worker = makeAgent("worker-low-demand");
  worker.task = {
    source: "autonomy",
    issuedAtTick: state.tick,
    type: "gather",
    resource: "wood",
  };
  state.agents = [worker];

  const next = simulate(state).state;
  const moved = next.agents.find((entry) => entry.id === worker.id);
  assert.ok(moved);
  assert.equal(moved.task?.type, "gather");
  assert.deepEqual(moved.task.target, NEAR);
});

test("resource selection accepts a one-hop detour around a reserved crowded deposit", () => {
  const { state, makeAgent } = fixture();
  setWood(state, NEAR);
  setWood(state, FAR);
  const worker = makeAgent("worker-crowded-resource");
  worker.task = {
    source: "autonomy",
    issuedAtTick: state.tick,
    type: "gather",
    resource: "wood",
  };
  state.agents = [
    worker,
    gatherBlocker(makeAgent, 1),
    gatherBlocker(makeAgent, 2),
    gatherBlocker(makeAgent, 3),
    gatherBlocker(makeAgent, 4),
  ];

  const next = simulate(state).state;
  const moved = next.agents.find((entry) => entry.id === worker.id);
  assert.ok(moved);
  assert.equal(moved.task?.type, "gather");
  assert.deepEqual(moved.task.target, FAR);
});

function activeStorehouse(id, factionId, position) {
  return {
    id,
    factionId,
    type: "storehouse",
    position: { ...position },
    status: "active",
    progress: 1,
    requiredProgress: 1,
    storage: emptyInventory(),
  };
}

function depositBlocker(makeAgent, index, structureId) {
  const agent = makeAgent(`deposit-blocker-${index}`);
  agent.inventory.wood = 1;
  agent.task = {
    source: "autonomy",
    issuedAtTick: 1,
    type: "deposit",
    structureId,
  };
  return agent;
}

test("storage selection accepts a one-hop detour around a reserved crowded storehouse", () => {
  const { state, faction, makeAgent } = fixture();
  const near = activeStorehouse("near-storehouse", faction.id, NEAR);
  const far = activeStorehouse("far-storehouse", faction.id, FAR);
  state.structures = [near, far];
  const carrier = makeAgent("carrier-crowded-storage");
  carrier.inventory.wood = 4;
  carrier.task = {
    source: "autonomy",
    issuedAtTick: state.tick,
    type: "deposit",
  };
  state.agents = [
    carrier,
    depositBlocker(makeAgent, 1, near.id),
    depositBlocker(makeAgent, 2, near.id),
    depositBlocker(makeAgent, 3, near.id),
    depositBlocker(makeAgent, 4, near.id),
  ];

  const next = simulate(state).state;
  const moved = next.agents.find((entry) => entry.id === carrier.id);
  assert.ok(moved);
  assert.equal(moved.task?.type, "deposit");
  assert.equal(moved.task.structureId, far.id);
});
''')
