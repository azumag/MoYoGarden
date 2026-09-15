from pathlib import Path

source = Path("src/settlement-migration.ts")
text = source.read_text()

old = '''interface SettlementSeamCandidate {
  entry: HexHaloTile;
  distance: number;
  pathCrowding: number;
  crowding: number;
  support: SettlementNeighborSupport;
}
'''
new = '''interface SettlementSeamCandidate {
  entry: HexHaloTile;
  distance: number;
  pathCrowding: number;
  crowding: number;
  support: SettlementNeighborSupport;
  factionStorageHeadroom: number | undefined;
}
'''
assert old in text
text = text.replace(old, new, 1)

anchor = '''function compareSettlementSeamCandidate(
  a: SettlementSeamCandidate,
  b: SettlementSeamCandidate,
): number {
'''
helper = '''function settlementStorageHeadroomPreference(headroom: number | undefined): number {
  if (headroom === undefined) return 1;
  return headroom > 0 ? 2 : 0;
}

function compareSettlementStorageHeadroom(
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
  halo: readonly HexHaloTile[],
  neighborRegionId: string,
  factionId: string,
): number | undefined {
  let minimumHeadroom: number | undefined;
  for (const entry of halo) {
    if (entry.neighborRegionId !== neighborRegionId) continue;
    const byFaction = entry.neighborRegionSummary?.storageHeadroomByFaction;
    if (byFaction === undefined || !Object.prototype.hasOwnProperty.call(byFaction, factionId)) continue;
    const headroom = byFaction[factionId];
    if (typeof headroom !== "number" || !Number.isFinite(headroom) || headroom < 0) continue;
    minimumHeadroom = minimumHeadroom === undefined
      ? headroom
      : Math.min(minimumHeadroom, headroom);
  }
  return minimumHeadroom;
}

'''
assert anchor in text
text = text.replace(anchor, helper + anchor, 1)

old = '''    compareSettlementSupport(a.support, b.support)
    || settlementRouteCost(a) - settlementRouteCost(b)
'''
new = '''    compareSettlementSupport(a.support, b.support)
    // Only after ecological support and existing development tie, prefer a
    // frontier where this faction has usable logistics capacity. Missing
    // rolling metadata stays neutral; known-full storage is worse than unknown.
    || compareSettlementStorageHeadroom(a.factionStorageHeadroom, b.factionStorageHeadroom)
    || settlementRouteCost(a) - settlementRouteCost(b)
'''
assert text.count(old) >= 2
text = text.replace(old, new, 2)

old = '''      const next = {
        entry,
        distance: path.distance,
        pathCrowding: path.crowding,
        crowding,
        support,
      };
'''
new = '''      const next = {
        entry,
        distance: path.distance,
        pathCrowding: path.crowding,
        crowding,
        support,
        factionStorageHeadroom: haloRegionFactionStorageHeadroom(
          halo,
          entry.neighborRegionId,
          agent.factionId,
        ),
      };
'''
assert old in text
text = text.replace(old, new, 1)

old = '''      issuedAtTick,
      support: candidate.support,
    };
'''
new = '''      issuedAtTick,
      support: candidate.support,
      factionStorageHeadroom: candidate.factionStorageHeadroom,
    };
'''
assert old in text
text = text.replace(old, new, 1)
source.write_text(text)

test_path = Path("tests/settlement-migration-support-density.test.mjs")
test_text = test_path.read_text()
addition = r'''
test("pioneer prefers own-faction storage headroom after settlement support ties", () => {
  const { state, builder } = transitPioneerFixture();
  const sharedSeam = { x: 30, y: 11 };
  const summary = {
    resources: { wood: 10, stone: 5, food: 20 },
    resourceCapacity: { wood: 20, stone: 10, food: 40 },
    activeStructures: { camp: 0, storehouse: 1, market: 0, workshop: 0 },
    passableCells: 100,
    occupants: 2,
  };
  const east = haloTile("E", sharedSeam, "hex-q1-r0", { x: 8, y: 11 }, 10, 5);
  east.neighborRegionSummary = {
    ...summary,
    storageHeadroomByFaction: { [builder.factionId]: 0 },
  };
  const west = haloTile("W", sharedSeam, "hex-q-1-r0", { x: 30, y: 11 }, 10, 5);
  west.neighborRegionSummary = {
    ...summary,
    storageHeadroomByFaction: { [builder.factionId]: 6 },
  };

  const plan = planAutonomousSettlementMigration(state, [east, west]);

  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(plan.neighborRegionId, "hex-q-1-r0");
  assert.equal(plan.direction, "W");
});

test("pioneer ignores another faction's remote storage headroom", () => {
  const { state, builder } = transitPioneerFixture();
  const sharedSeam = { x: 30, y: 11 };
  const summary = {
    resources: { wood: 10, stone: 5, food: 20 },
    resourceCapacity: { wood: 20, stone: 10, food: 40 },
    activeStructures: { camp: 0, storehouse: 1, market: 0, workshop: 0 },
    passableCells: 100,
    occupants: 2,
  };
  const east = haloTile("E", sharedSeam, "hex-q1-r0", { x: 8, y: 11 }, 10, 5);
  east.neighborRegionSummary = { ...summary };
  const west = haloTile("W", sharedSeam, "hex-q-1-r0", { x: 30, y: 11 }, 10, 5);
  west.neighborRegionSummary = {
    ...summary,
    storageHeadroomByFaction: { outsiders: 99 },
  };

  const plan = planAutonomousSettlementMigration(state, [east, west]);

  assert.ok(plan);
  assert.equal(plan.agentId, builder.id);
  assert.equal(plan.neighborRegionId, "hex-q1-r0");
  assert.equal(plan.direction, "E");
});
'''
marker = 'pioneer prefers own-faction storage headroom after settlement support ties'
assert marker not in test_text
test_path.write_text(test_text.rstrip() + "\n\n" + addition.strip() + "\n")
