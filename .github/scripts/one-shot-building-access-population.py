from pathlib import Path

runtime = Path("src/runtime.ts")
text = runtime.read_text()
old = "const POPULATION_GROWTH_INTERVAL = 60;"
new = """// Population growth is demographic, not a minute-scale work cadence. With the
// production 10s virtual tick, 8,640 ticks is one day. Virtual-time catch-up
// deliberately preserves this elapsed-time meaning without creating a burst of
// new residents every few minutes when a sleeping region wakes up.
const POPULATION_GROWTH_INTERVAL = 8_640;"""
assert old in text, "population interval marker changed"
runtime.write_text(text.replace(old, new, 1))

simulation = Path("src/simulation.ts")
text = simulation.read_text()
marker = "function findBuildSite(\n"
assert marker in text, "findBuildSite marker changed"
helper = r'''function structureAccessCells(
  state: Pick<WorldState, "width" | "height" | "tiles" | "structures">,
  structurePosition: GridPosition,
  blockedPosition?: GridPosition,
): GridPosition[] {
  return NEIGHBORS
    .map((step) => ({ x: structurePosition.x + step.x, y: structurePosition.y + step.y }))
    .filter((candidate) => inBounds(state, candidate) && isPassable(state, candidate))
    .filter((candidate) => blockedPosition === undefined || !samePosition(candidate, blockedPosition))
    .filter((candidate) =>
      !state.structures.some((structure) => samePosition(structure.position, candidate))
    );
}

function hasUsableStructureAccess(
  state: Pick<WorldState, "width" | "height" | "tiles" | "structures">,
  structurePosition: GridPosition,
  blockedPosition?: GridPosition,
): boolean {
  return structureAccessCells(state, structurePosition, blockedPosition).some((accessCell) =>
    NEIGHBORS.some((step) => {
      const next = { x: accessCell.x + step.x, y: accessCell.y + step.y };
      if (samePosition(next, structurePosition)) return false;
      if (blockedPosition !== undefined && samePosition(next, blockedPosition)) return false;
      if (!inBounds(state, next) || !isPassable(state, next)) return false;
      return !state.structures.some((structure) => samePosition(structure.position, next));
    })
  );
}

function buildSitePreservesStructureAccess(state: WorldState, position: GridPosition): boolean {
  if (!inBounds(state, position) || !isPassable(state, position)) return false;
  if (state.structures.some((structure) => samePosition(structure.position, position))) return false;

  // Dense blocks are allowed, but every new footprint needs at least one
  // person-sized approach hex that itself connects onward to another open hex.
  // This prevents a decorative one-cell pocket from counting as an entrance.
  if (!hasUsableStructureAccess(state, position, position)) return false;

  // A new building may share an alley with its neighbors, but it must never
  // consume the last usable entrance / construction approach of an adjacent
  // existing building.
  return state.structures
    .filter((structure) => hexGridDistance(structure.position, position) === 1)
    .every((structure) => hasUsableStructureAccess(state, structure.position, position));
}

'''
text = text.replace(marker, helper + marker, 1)

old_candidates = '''  const candidates = state.tiles
    .filter((tile) => tile.terrain !== "water" && !occupied.has(`${tile.x},${tile.y}`))
    .filter((tile) => manhattanDistance(tile, origin) <= 5)
'''
new_candidates = '''  const candidates = state.tiles
    .filter((tile) => tile.terrain !== "water" && !occupied.has(`${tile.x},${tile.y}`))
    .filter((tile) => buildSitePreservesStructureAccess(state, tile))
    .filter((tile) => manhattanDistance(tile, origin) <= 5)
'''
assert old_candidates in text, "build candidate block changed"
text = text.replace(old_candidates, new_candidates, 1)

old_start = '''  if (state.structures.some((structure) => samePosition(structure.position, target))) {
    agent.status = "build site occupied";
    delete agent.task;
    return undefined;
  }
  const recipe = BUILD_RECIPES[task.structureType];
'''
new_start = '''  if (state.structures.some((structure) => samePosition(structure.position, target))) {
    agent.status = "build site occupied";
    delete agent.task;
    return undefined;
  }
  if (!buildSitePreservesStructureAccess(state, target)) {
    agent.status = "build site lacks structure access";
    delete agent.task;
    return undefined;
  }
  const recipe = BUILD_RECIPES[task.structureType];
'''
assert old_start in text, "startConstruction block changed"
text = text.replace(old_start, new_start, 1)
simulation.write_text(text)

population_test = Path("tests/population-housing-capacity.test.mjs")
text = population_test.read_text()
assert "state.tick = 59;" in text
assert "blocked.tick = 119;" in text
text = text.replace("state.tick = 59;", "state.tick = 8_639;", 1)
text = text.replace("blocked.tick = 119;", "blocked.tick = 17_279;", 1)
population_test.write_text(text)

simulation_test = Path("tests/simulation.test.mjs")
text = simulation_test.read_text()
anchor = 'test("food-secure settlements can grow their population when local hex space is available", () => {'
index = text.index(anchor)
suffix = text[index:]
assert "state.tick = 59;" in suffix
suffix = suffix.replace("state.tick = 59;", "state.tick = 8_639;", 1)
simulation_test.write_text(text[:index] + suffix)

Path("tests/population-growth-cadence.test.mjs").write_text(r'''import assert from "node:assert/strict";
import test from "node:test";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("population growth no longer runs at the former ten-minute cadence", () => {
  const state = createInitialWorld({ seed: 26091531 });
  const faction = state.factions.find((entry) => entry.id === "ember");
  assert.ok(faction);
  const members = state.agents.filter((agent) => agent.factionId === faction.id);
  assert.ok(members.length >= 2);

  for (const tile of state.tiles) {
    if (tile.terrain === "water") tile.terrain = "plain";
  }
  for (const member of members) {
    member.hp = 100;
    member.energy = 100;
    delete member.task;
  }
  const campPosition = { ...members[0].position };
  state.structures.push({
    id: "cadence-growth-camp",
    factionId: faction.id,
    type: "camp",
    position: campPosition,
    status: "active",
    progress: 6,
    requiredProgress: 6,
    storage: { wood: 0, stone: 0, food: 100 },
  });
  faction.resources.food = 100;
  state.tick = 59;

  const next = new WorldRuntime({ state }).tick().state;
  const nextFaction = next.factions.find((entry) => entry.id === faction.id);
  const nextCamp = next.structures.find((structure) => structure.id === "cadence-growth-camp");
  assert.ok(nextFaction);
  assert.ok(nextCamp);
  assert.equal(next.agents.filter((agent) => agent.factionId === faction.id).length, members.length);
  assert.equal(nextFaction.resources.food, 100);
  assert.equal(nextCamp.storage.food, 100);
});
''')

Path("tests/simulation-building-access.test.mjs").write_text(r'''import assert from "node:assert/strict";
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
''')
