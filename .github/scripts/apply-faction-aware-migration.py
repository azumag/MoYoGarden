from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected exactly one match, got {count}")
    p.write_text(text.replace(old, new, 1))


replace_once(
    "src/hex-halo.ts",
    """  // Optional during rolling deploys. This bounded observed-headroom map can
  // contain zero for a faction whose active storage is known to be full. An
  // omitted faction stays unknown (for example after top-N truncation).
  storageHeadroomByFaction?: Record<string, number>;
  passableCells: number;
  occupants: number;
""",
    """  // Optional during rolling deploys. This bounded observed-headroom map can
  // contain zero for a faction whose active storage is known to be full. An
  // omitted faction stays unknown (for example after top-N truncation).
  storageHeadroomByFaction?: Record<string, number>;
  // Optional bounded population composition. Counts are whole-region residents,
  // not remote Agent snapshots. Consumers must treat a missing faction as
  // unknown unless the summarized counts add up to `occupants`, because top-N
  // truncation can omit small factions in highly mixed regions.
  occupantsByFaction?: Record<string, number>;
  passableCells: number;
  occupants: number;
""",
)

replace_once(
    "src/hex-halo.ts",
    """          ...(observed.regionSummary.storageHeadroomByFaction === undefined ? {} : {
            storageHeadroomByFaction: { ...observed.regionSummary.storageHeadroomByFaction },
          }),
          passableCells: observed.regionSummary.passableCells,
""",
    """          ...(observed.regionSummary.storageHeadroomByFaction === undefined ? {} : {
            storageHeadroomByFaction: { ...observed.regionSummary.storageHeadroomByFaction },
          }),
          ...(observed.regionSummary.occupantsByFaction === undefined ? {} : {
            occupantsByFaction: { ...observed.regionSummary.occupantsByFaction },
          }),
          passableCells: observed.regionSummary.passableCells,
""",
)

replace_once(
    "src/halo-region.ts",
    "const MAX_SUMMARIZED_STORAGE_FACTIONS = 8;\n",
    "const MAX_SUMMARIZED_STORAGE_FACTIONS = 8;\nconst MAX_SUMMARIZED_OCCUPANT_FACTIONS = 8;\n",
)

replace_once(
    "src/halo-region.ts",
    """    const storageHeadroomByFaction = Object.fromEntries(
      [...storageHeadroom.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, MAX_SUMMARIZED_STORAGE_FACTIONS),
    );
    let passableCells = 0;
""",
    """    const storageHeadroomByFaction = Object.fromEntries(
      [...storageHeadroom.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, MAX_SUMMARIZED_STORAGE_FACTIONS),
    );
    const occupantCounts = new Map<string, number>();
    for (const agent of state.agents) {
      occupantCounts.set(
        agent.factionId,
        (occupantCounts.get(agent.factionId) ?? 0) + 1,
      );
    }
    const occupantsByFaction = Object.fromEntries(
      [...occupantCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, MAX_SUMMARIZED_OCCUPANT_FACTIONS),
    );
    let passableCells = 0;
""",
)

replace_once(
    "src/halo-region.ts",
    """      activeStructures,
      storageHeadroomByFaction,
      passableCells,
      occupants: state.agents.length,
""",
    """      activeStructures,
      storageHeadroomByFaction,
      occupantsByFaction,
      passableCells,
      occupants: state.agents.length,
""",
)

replace_once(
    "src/settlement-migration.ts",
    """interface SettlementSeamCandidate {
  entry: HexHaloTile;
  distance: number;
  pathCrowding: number;
  crowding: number;
  support: SettlementNeighborSupport;
  factionStorageHeadroom: number | undefined;
}
""",
    """interface SettlementFactionOccupancy {
  own: number;
  foreign: number;
}

interface SettlementSeamCandidate {
  entry: HexHaloTile;
  distance: number;
  pathCrowding: number;
  crowding: number;
  support: SettlementNeighborSupport;
  factionStorageHeadroom: number | undefined;
  factionOccupancy: SettlementFactionOccupancy | undefined;
}
""",
)

replace_once(
    "src/settlement-migration.ts",
    """function compareSettlementStorageHeadroom(
  a: number | undefined,
  b: number | undefined,
): number {
  const preferenceDelta = settlementStorageHeadroomPreference(b)
    - settlementStorageHeadroomPreference(a);
  if (preferenceDelta !== 0) return preferenceDelta;
  if (a === undefined || b === undefined) return 0;
  return b - a;
}

function haloRegionFactionStorageHeadroom(
""",
    """function compareSettlementStorageHeadroom(
  a: number | undefined,
  b: number | undefined,
): number {
  const preferenceDelta = settlementStorageHeadroomPreference(b)
    - settlementStorageHeadroomPreference(a);
  if (preferenceDelta !== 0) return preferenceDelta;
  if (a === undefined || b === undefined) return 0;
  return b - a;
}

function compareFactionOccupancy(
  a: SettlementFactionOccupancy | undefined,
  b: SettlementFactionOccupancy | undefined,
): number {
  if (a === undefined || b === undefined) return 0;
  // Whole-region population density is already compared as ecological pressure.
  // When that total pressure ties, prefer fewer foreign residents and then an
  // existing same-faction foothold. This is only a soft tie-break: richer/safer
  // land still wins, and rolling summaries without composition remain neutral.
  return a.foreign - b.foreign
    || Number(b.own > 0) - Number(a.own > 0);
}

function haloRegionFactionOccupancy(
  halo: readonly HexHaloTile[],
  neighborRegionId: string,
  factionId: string,
): SettlementFactionOccupancy | undefined {
  let observation: { occupants: number; counts: Record<string, number> } | undefined;
  for (const entry of halo) {
    if (entry.neighborRegionId !== neighborRegionId) continue;
    const summary = entry.neighborRegionSummary;
    const counts = summary?.occupantsByFaction;
    if (summary === undefined || counts === undefined) continue;
    if (!Number.isInteger(summary.occupants) || summary.occupants < 0) continue;
    const entries = Object.entries(counts);
    if (entries.some(([, count]) => !Number.isInteger(count) || count < 0)) continue;
    const summarized = entries.reduce((sum, [, count]) => sum + count, 0);
    if (summarized > summary.occupants) continue;
    if (observation !== undefined) {
      const previousEntries = Object.entries(observation.counts);
      if (
        observation.occupants !== summary.occupants
        || previousEntries.length !== entries.length
        || previousEntries.some(([id, count]) => counts[id] !== count)
      ) {
        // Independent edge reads can straddle a remote tick. Mixed population
        // composition is not coherent, so leave this preference neutral.
        return undefined;
      }
      continue;
    }
    observation = { occupants: summary.occupants, counts };
  }
  if (observation === undefined) return undefined;
  const own = observation.counts[factionId];
  const summarized = Object.values(observation.counts).reduce((sum, count) => sum + count, 0);
  // Absence means zero only when the bounded summary is complete. Otherwise the
  // faction may simply have fallen below the top-N export cutoff.
  if (own === undefined && summarized !== observation.occupants) return undefined;
  const ownCount = own ?? 0;
  return { own: ownCount, foreign: Math.max(0, observation.occupants - ownCount) };
}

function haloRegionFactionStorageHeadroom(
""",
)

migration_file = Path("src/settlement-migration.ts")
text = migration_file.read_text()
old_comparator = """    compareSettlementSupport(a.support, b.support)
    // Only after ecological support and existing development tie, prefer a
"""
new_comparator = """    compareSettlementSupport(a.support, b.support)
    || compareFactionOccupancy(a.factionOccupancy, b.factionOccupancy)
    // Only after ecological support and existing development tie, prefer a
"""
count = text.count(old_comparator)
if count != 2:
    raise SystemExit(f"src/settlement-migration.ts: expected two comparator matches, got {count}")
migration_file.write_text(text.replace(old_comparator, new_comparator))

replace_once(
    "src/settlement-migration.ts",
    """        factionStorageHeadroom: haloRegionFactionStorageHeadroom(
          halo,
          entry.neighborRegionId,
          agent.factionId,
        ),
      };
""",
    """        factionStorageHeadroom: haloRegionFactionStorageHeadroom(
          halo,
          entry.neighborRegionId,
          agent.factionId,
        ),
        factionOccupancy: haloRegionFactionOccupancy(
          halo,
          entry.neighborRegionId,
          agent.factionId,
        ),
      };
""",
)

Path("tests/settlement-migration-faction-occupancy.test.mjs").write_text(r'''import assert from "node:assert/strict";
import test from "node:test";
import { isHexGridCell } from "../dist-ts/src/hex-grid.js";
import { planAutonomousSettlementMigration } from "../dist-ts/src/settlement-migration.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function fixture() {
  const state = createInitialWorld({ seed: 260916, width: 40, height: 24 });
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile)) continue;
    tile.terrain = "plain";
    delete tile.resource;
  }
  const builder = state.agents.find((agent) => agent.role === "builder");
  assert.ok(builder);
  state.agents = [builder];
  state.structures = [];
  state.tick = 25;
  builder.autonomy = true;
  builder.energy = 100;
  builder.position = { x: 19, y: 11 };
  builder.inventory = { wood: 8, stone: 4, food: 0 };
  builder.task = {
    source: "autonomy",
    issuedAtTick: state.tick,
    type: "build",
    structureType: "camp",
  };
  for (let index = 0; index < 9; index += 1) {
    const resident = structuredClone(builder);
    resident.id = `resident-${index}`;
    resident.autonomy = false;
    delete resident.task;
    state.agents.push(resident);
  }
  return { state, builder };
}

function candidate(direction, sourcePosition, regionId, neighborPosition, summary) {
  return {
    direction,
    sourcePosition,
    neighborRegionId: regionId,
    neighborPosition,
    tile: {
      ...neighborPosition,
      terrain: "plain",
      elevation: 0.5,
    },
    neighborRegionSummary: summary,
  };
}

function summary(occupants, occupantsByFaction) {
  return {
    resources: { wood: 0, stone: 0, food: 0 },
    resourceCapacity: { wood: 0, stone: 0, food: 0 },
    activeStructures: { camp: 0, storehouse: 0, market: 0, workshop: 0 },
    passableCells: 100,
    occupants,
    ...(occupantsByFaction === undefined ? {} : { occupantsByFaction }),
  };
}

test("migration prefers a same-faction foothold when total pressure and ecology tie", () => {
  const { state, builder } = fixture();
  const seam = { x: 30, y: 11 };
  const plan = planAutonomousSettlementMigration(state, [
    candidate(
      "E",
      seam,
      "hex-q1-r0",
      { x: 8, y: 11 },
      summary(2, { [builder.factionId]: 1, rival: 1 }),
    ),
    candidate(
      "W",
      seam,
      "hex-q-1-r0",
      { x: 30, y: 11 },
      summary(2, { rival: 2 }),
    ),
  ]);

  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(plan.neighborRegionId, "hex-q1-r0");
  assert.equal(plan.direction, "E");
});

test("truncated faction composition stays neutral when the pioneer faction is omitted", () => {
  const { state, builder } = fixture();
  const seam = { x: 30, y: 11 };
  const plan = planAutonomousSettlementMigration(state, [
    candidate(
      "E",
      seam,
      "hex-q1-r0",
      { x: 8, y: 11 },
      summary(3, { rival: 2 }),
    ),
    candidate(
      "W",
      seam,
      "hex-q-1-r0",
      { x: 30, y: 11 },
      summary(3, { rival: 3 }),
    ),
  ]);

  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(
    plan.neighborRegionId,
    "hex-q1-r0",
    "an omitted faction in an incomplete top-N summary must not be treated as zero residents",
  );
});
''')
