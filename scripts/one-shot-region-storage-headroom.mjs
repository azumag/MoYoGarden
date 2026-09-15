import fs from "node:fs";

function patch(path, replacements) {
  let text = fs.readFileSync(path, "utf8");
  for (const [before, after] of replacements) {
    if (!text.includes(before)) {
      throw new Error(`patch anchor missing in ${path}: ${before.slice(0, 120)}`);
    }
    text = text.replace(before, after);
  }
  fs.writeFileSync(path, text);
}

patch("src/hex-halo.ts", [
  [
    "  activeStructures?: Record<StructureType, number>;\n  passableCells: number;",
    "  activeStructures?: Record<StructureType, number>;\n  // Optional during rolling deploys. This is a bounded positive-headroom map\n  // (at most a handful of factions), used only as a planning preference; an\n  // omitted faction is unknown rather than proof that remote storage is full.\n  storageHeadroomByFaction?: Record<string, number>;\n  passableCells: number;",
  ],
  [
    "          ...(observed.regionSummary.activeStructures === undefined ? {} : {\n            activeStructures: { ...observed.regionSummary.activeStructures },\n          }),\n          passableCells: observed.regionSummary.passableCells,",
    "          ...(observed.regionSummary.activeStructures === undefined ? {} : {\n            activeStructures: { ...observed.regionSummary.activeStructures },\n          }),\n          ...(observed.regionSummary.storageHeadroomByFaction === undefined ? {} : {\n            storageHeadroomByFaction: { ...observed.regionSummary.storageHeadroomByFaction },\n          }),\n          passableCells: observed.regionSummary.passableCells,",
  ],
]);

patch("src/halo-region.ts", [
  [
    "import type { ResourceKind, WorldState } from \"./protocol.js\";",
    "import {\n  BUILD_RECIPES,\n  inventoryTotal,\n  type ResourceKind,\n  type WorldState,\n} from \"./protocol.js\";",
  ],
  [
    "const HALO_REGROWTH_BOUNDARY_DEPTH = 3;\nconst DEFAULT_WORLD_SEED = 424_242;",
    "const HALO_REGROWTH_BOUNDARY_DEPTH = 3;\n// Keep the whole-region logistics hint constant-size even if future worlds\n// contain many factions. Missing entries remain neutral to remote planners.\nconst MAX_SUMMARIZED_STORAGE_FACTIONS = 8;\nconst DEFAULT_WORLD_SEED = 424_242;",
  ],
  [
    "    const activeStructures = { camp: 0, storehouse: 0, market: 0, workshop: 0 };\n    for (const structure of state.structures) {\n      if (structure.status === \"active\") activeStructures[structure.type] += 1;\n    }\n    let passableCells = 0;",
    "    const activeStructures = { camp: 0, storehouse: 0, market: 0, workshop: 0 };\n    const storageHeadroom = new Map<string, number>();\n    for (const structure of state.structures) {\n      if (structure.status !== \"active\") continue;\n      activeStructures[structure.type] += 1;\n      const headroom = Math.max(\n        0,\n        BUILD_RECIPES[structure.type].storageCapacity - inventoryTotal(structure.storage),\n      );\n      if (headroom <= 0) continue;\n      storageHeadroom.set(\n        structure.factionId,\n        (storageHeadroom.get(structure.factionId) ?? 0) + headroom,\n      );\n    }\n    const storageHeadroomByFaction = Object.fromEntries(\n      [...storageHeadroom.entries()]\n        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))\n        .slice(0, MAX_SUMMARIZED_STORAGE_FACTIONS),\n    );\n    let passableCells = 0;",
  ],
  [
    "      activeStructures,\n      passableCells,",
    "      activeStructures,\n      storageHeadroomByFaction,\n      passableCells,",
  ],
]);

patch("src/autonomy-region.ts", [
  [
    "function availableHaloSupplyForAgent(\n  state: Pick<WorldState, \"tick\">,",
    "function haloRegionFactionStorageHeadroom(\n  halo: readonly HexHaloTile[],\n  neighborRegionId: string,\n  factionId: string,\n): number | undefined {\n  let minimumHeadroom: number | undefined;\n  for (const entry of halo) {\n    if (entry.neighborRegionId !== neighborRegionId) continue;\n    const headroom = entry.neighborRegionSummary?.storageHeadroomByFaction?.[factionId];\n    if (typeof headroom !== \"number\" || !Number.isFinite(headroom) || headroom <= 0) continue;\n    // Multiple seam reads can straddle ticks. Treat this as a routing hint, not\n    // a reservation, and use the most conservative positive observation.\n    minimumHeadroom = Math.min(minimumHeadroom ?? headroom, headroom);\n  }\n  return minimumHeadroom;\n}\n\nfunction availableHaloSupplyForAgent(\n  state: Pick<WorldState, \"tick\">,",
  ],
  [
    "    destinationCrowding: number;\n    costPerUnit: number;",
    "    destinationCrowding: number;\n    destinationStorageHeadroom?: number;\n    costPerUnit: number;",
  ],
  [
    "    const candidates = halo.flatMap((entry) => {\n      const pathScore = pathScores.get(positionKey(entry.sourcePosition));",
    "    const destinationStorageHeadroom = new Map<string, number | undefined>();\n    for (const neighborRegionId of new Set(halo.map((entry) => entry.neighborRegionId))) {\n      destinationStorageHeadroom.set(\n        neighborRegionId,\n        haloRegionFactionStorageHeadroom(halo, neighborRegionId, agent.factionId),\n      );\n    }\n    const candidates = halo.flatMap((entry) => {\n      const pathScore = pathScores.get(positionKey(entry.sourcePosition));",
  ],
  [
    "        destinationCrowding: entry.neighborOccupants ?? 0,\n      }];",
    "        destinationCrowding: entry.neighborOccupants ?? 0,\n        destinationStorageHeadroom: destinationStorageHeadroom.get(entry.neighborRegionId),\n      }];",
  ],
  [
    "      .flatMap(({ entry, travelDistance, pathCrowding, destinationCrowding }) => {",
    "      .flatMap(({ entry, travelDistance, pathCrowding, destinationCrowding, destinationStorageHeadroom }) => {",
  ],
  [
    "          destinationCrowding,\n          visibleSupply: supply,",
    "          destinationCrowding,\n          destinationStorageHeadroom,\n          visibleSupply: supply,",
  ],
  [
    "        || a.destinationCrowding - b.destinationCrowding\n        || directionRank(a.entry.direction) - directionRank(b.entry.direction)",
    "        || a.destinationCrowding - b.destinationCrowding\n        // Equivalent routes should prefer a region that currently has positive\n        // storage headroom for this BOT's own faction. This is deliberately a\n        // tie-break only: remote headroom is not reserved and can change before\n        // arrival, while the existing source-return promise remains the fallback.\n        || Number((b.destinationStorageHeadroom ?? 0) > 0)\n          - Number((a.destinationStorageHeadroom ?? 0) > 0)\n        || (b.destinationStorageHeadroom ?? 0) - (a.destinationStorageHeadroom ?? 0)\n        || directionRank(a.entry.direction) - directionRank(b.entry.direction)",
  ],
  [
    "      destinationCrowding: candidate.destinationCrowding,\n      costPerUnit: candidate.costPerUnit,",
    "      destinationCrowding: candidate.destinationCrowding,\n      destinationStorageHeadroom: candidate.destinationStorageHeadroom,\n      costPerUnit: candidate.costPerUnit,",
  ],
  [
    "    || a.destinationCrowding - b.destinationCrowding\n    // Equivalent expeditions should use the BOT with more remaining energy;",
    "    || a.destinationCrowding - b.destinationCrowding\n    || Number((b.destinationStorageHeadroom ?? 0) > 0)\n      - Number((a.destinationStorageHeadroom ?? 0) > 0)\n    || (b.destinationStorageHeadroom ?? 0) - (a.destinationStorageHeadroom ?? 0)\n    // Equivalent expeditions should use the BOT with more remaining energy;",
  ],
]);

const testPath = "tests/autonomy-region-storage-headroom-summary.test.mjs";
fs.writeFileSync(testPath, `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { planAutonomousHaloTravel } from "../dist-ts/src/autonomy-region.js";\nimport {\n  hexGridBoundaryCells,\n  hexGridCenter,\n  hexGridHandoffTarget,\n  isHexGridCell,\n} from "../dist-ts/src/hex-grid.js";\nimport { materializeHexHalo } from "../dist-ts/src/hex-halo.js";\nimport { createInitialWorld } from "../dist-ts/src/world.js";\n\nfunction fixture() {\n  const state = createInitialWorld({ seed: 150926, width: 40, height: 24, regionId: "garden-1" });\n  const agent = state.agents[0];\n  assert.ok(agent);\n  for (const tile of state.tiles) {\n    if (tile.resource?.kind === "wood") tile.resource.amount = 0;\n    if (isHexGridCell(state, tile)) tile.terrain = "plain";\n  }\n  state.agents = [agent];\n  state.tick = 24;\n  agent.autonomy = true;\n  agent.role = "woodcutter";\n  agent.energy = 100;\n  agent.position = hexGridCenter(state);\n  agent.inventory = { wood: 0, stone: 0, food: 0 };\n  agent.task = { source: "autonomy", issuedAtTick: 20, type: "gather", resource: "wood" };\n  return { state, agent };\n}\n\nfunction halo(state, direction, regionId, factionId, headroom) {\n  const cells = hexGridBoundaryCells(state, direction);\n  const sourcePosition = cells[Math.floor(cells.length / 2)];\n  assert.ok(sourcePosition);\n  const neighborPosition = hexGridHandoffTarget(state, sourcePosition, direction);\n  assert.ok(neighborPosition);\n  return {\n    sourceRegionId: state.regionId,\n    sourcePosition: { ...sourcePosition },\n    direction,\n    neighborRegionId: regionId,\n    neighborPosition: { ...neighborPosition },\n    tile: {\n      x: neighborPosition.x,\n      y: neighborPosition.y,\n      terrain: "plain",\n      resource: { kind: "wood", amount: 8, maxAmount: 8 },\n    },\n    neighborRegionSummary: {\n      resources: { wood: 8, stone: 0, food: 0 },\n      passableCells: 397,\n      occupants: 1,\n      ...(headroom > 0 ? { storageHeadroomByFaction: { [factionId]: headroom } } : {}),\n    },\n  };\n}\n\ntest("materialized halo carries bounded faction storage headroom without mutating the snapshot", () => {\n  const summary = {\n    resources: { wood: 8, stone: 0, food: 0 },\n    storageHeadroomByFaction: { settlers: 12 },\n    passableCells: 397,\n    occupants: 2,\n  };\n  const link = {\n    sourceRegionId: "garden-1", sourcePosition: { x: 30, y: 11 }, direction: "east",\n    neighborRegionId: "garden-2", neighborPosition: { x: 8, y: 11 }, neighborDirection: "west",\n  };\n  const materialized = materializeHexHalo([link], [{\n    regionId: "garden-2", direction: "west", revision: 1, tick: 10, regionSummary: summary,\n    tiles: [{ position: { x: 8, y: 11 }, tile: { x: 8, y: 11, terrain: "plain", elevation: 0.5 } }],\n  }]);\n  assert.deepEqual(materialized[0].neighborRegionSummary?.storageHeadroomByFaction, { settlers: 12 });\n  materialized[0].neighborRegionSummary.storageHeadroomByFaction.settlers = 1;\n  assert.equal(summary.storageHeadroomByFaction.settlers, 12);\n});\n\ntest("equivalent resource expeditions prefer own-faction destination storage headroom", () => {\n  const { state, agent } = fixture();\n  const east = halo(state, "east", "garden-2", agent.factionId, 0);\n  const west = halo(state, "west", "hex-q-1-r0", agent.factionId, 10);\n  const plan = planAutonomousHaloTravel(state, [east, west]);\n  assert.ok(plan);\n  assert.equal(plan.direction, "west");\n  assert.equal(plan.neighborRegionId, "hex-q-1-r0");\n});\n\ntest("storage headroom for another faction does not bias expedition routing", () => {\n  const { state, agent } = fixture();\n  const east = halo(state, "east", "garden-2", agent.factionId, 0);\n  const west = halo(state, "west", "hex-q-1-r0", "other-faction", 20);\n  const plan = planAutonomousHaloTravel(state, [west, east]);\n  assert.ok(plan);\n  assert.equal(plan.direction, "east", "legacy deterministic route order should remain when own-faction headroom is unknown");\n});\n`);

console.log("one-shot storage headroom summary patch applied");
