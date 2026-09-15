import assert from "node:assert/strict";
import test from "node:test";
import { HEX_GRID_STEPS } from "../dist-ts/src/hex-grid.js";
import { simulate } from "../dist-ts/src/simulation.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

const emptyInventory = () => ({ wood: 0, stone: 0, food: 0 });

function activeCamp(id, factionId, position) {
  return {
    id,
    factionId,
    type: "camp",
    position: { ...position },
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: emptyInventory(),
  };
}

function accessFixture(blockerCount) {
  const state = createInitialWorld({ seed: 26091532, width: 40, height: 24 });
  const builder = state.agents.find((agent) => agent.role === "builder");
  assert.ok(builder);
  const faction = state.factions.find((entry) => entry.id === builder.factionId);
  assert.ok(faction);

  const center = { x: 19, y: 11 };
  const ring = HEX_GRID_STEPS.map((step) => ({ x: center.x + step.x, y: center.y + step.y }));
  const target = ring[0];
  assert.ok(target);

  for (const tile of state.tiles) {
    if (tile.terrain === "water") tile.terrain = "plain";
  }
  for (const position of [center, ...ring]) {
    const tile = state.tiles.find((entry) => entry.x === position.x && entry.y === position.y);
    assert.ok(tile);
    tile.terrain = "plain";
    delete tile.resource;
  }

  builder.position = { ...target };
  builder.hp = 100;
  builder.energy = 100;
  builder.inventory = emptyInventory();
  builder.autonomy = false;
  builder.task = {
    source: "external",
    issuedAtTick: state.tick,
    type: "build",
    structureType: "storehouse",
    target: { ...target },
  };
  state.agents = [builder];
  state.structures = [
    activeCamp("access-center", faction.id, center),
    ...ring.slice(1, 1 + blockerCount).map((position, index) =>
      activeCamp(`access-blocker-${index + 1}`, faction.id, position)
    ),
  ];
  faction.resources = { wood: 100, stone: 100, food: 100 };
  return { state, builder, faction, center, target, ring };
}

test("construction cannot seal the last usable access hex of an adjacent building", () => {
  const { state, builder, faction, target } = accessFixture(5);
  const before = { ...faction.resources };

  const next = simulate(state).state;
  const moved = next.agents.find((agent) => agent.id === builder.id);
  const nextFaction = next.factions.find((entry) => entry.id === faction.id);
  assert.ok(moved);
  assert.ok(nextFaction);
  assert.equal(
    next.structures.some((structure) => structure.type === "storehouse" && structure.position.x === target.x && structure.position.y === target.y),
    false,
  );
  assert.equal(moved.status, "build site lacks structure access");
  assert.deepEqual(nextFaction.resources, before, "rejected construction must not consume materials");
});

test("dense construction is still allowed when a connected access gap remains", () => {
  const { state, builder, faction, target, ring } = accessFixture(4);
  const remainingGap = ring[5];
  assert.ok(remainingGap);

  const next = simulate(state).state;
  const structure = next.structures.find((entry) =>
    entry.type === "storehouse" && entry.position.x === target.x && entry.position.y === target.y
  );
  assert.ok(structure, "a dense block may grow when another usable access hex remains");
  assert.equal(structure.status, "building");
  assert.equal(
    next.structures.some((entry) => entry.position.x === remainingGap.x && entry.position.y === remainingGap.y),
    false,
  );
  assert.ok(next.agents.some((agent) => agent.id === builder.id));
  assert.ok(next.factions.some((entry) => entry.id === faction.id));
});
