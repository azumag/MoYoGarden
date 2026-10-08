import assert from "node:assert/strict";
import test from "node:test";
import { buildDynamicHexHaloLinks, buildHexHaloLinks } from "../dist-ts/src/hex-halo.js";
import { HEX_GRID_DIRECTION_STEPS } from "../dist-ts/src/hex-grid.js";
import {
  hexDistance,
  regionAxialCoordinate,
  regionCellTransition,
} from "../dist-ts/src/region-topology.js";
import { planMaterialReturnRoute } from "../dist-ts/src/material-return-plan.js";

const extent = { width: 40, height: 24 };
const sourceRegionId = "hex-q4-r-2";

const sourceLinks = buildDynamicHexHaloLinks(extent, sourceRegionId);
const neighborIds = [...new Set(sourceLinks.map((link) => link.neighborRegionId))].sort();

const regionDistance = (a, b) => {
  const from = regionAxialCoordinate(a);
  const to = regionAxialCoordinate(b);
  if (from === undefined || to === undefined) return undefined;
  return hexDistance(from, to);
};

const targetRegionId = neighborIds[0];
const middleRegionId = neighborIds.find(
  (candidate) => candidate !== targetRegionId && regionDistance(candidate, targetRegionId) === 1,
);
assert.ok(targetRegionId, "fixture requires a target neighbor region");
assert.ok(middleRegionId, "fixture requires a common neighbor of source and target");

const linkTo = (regionId, neighborRegionId) => {
  const link = (regionId === sourceRegionId
    ? sourceLinks
    : buildDynamicHexHaloLinks(extent, regionId))
    .find((candidate) => candidate.neighborRegionId === neighborRegionId);
  assert.ok(link, `fixture requires a ${regionId} -> ${neighborRegionId} seam link`);
  return link;
};

// source -> middle -> target detour, plus the direct source -> target seam.
const linkMiddle = linkTo(sourceRegionId, middleRegionId);
const linkMiddleToTarget = linkTo(middleRegionId, targetRegionId);
const linkTarget = linkTo(sourceRegionId, targetRegionId);

const REVISION = { source: 11, middle: 12, target: 13 };
const TICK = { source: 40, middle: 41, target: 42 };
const COMPONENT = { source: 101, middle: 202, target: 303, directTarget: 304 };
const FACTION = "solar";

function tileAt(position) {
  return { x: position.x, y: position.y, terrain: "plain", elevation: 0.4 };
}

function summaryWith(storageComponentsByFaction) {
  return {
    resources: { wood: 0, stone: 0, food: 0 },
    storageComponentsByFaction,
    passableCells: 397,
    occupants: 0,
  };
}

/**
 * One region generation produces at most one edge snapshot per direction, and
 * that snapshot carries every boundary tile observed for that direction. Tests
 * must group same-direction entries the same way the runtime does, otherwise a
 * duplicate same-version snapshot legitimately poisons the edge lookup.
 */
function snapshotsFor({ regionId, revision, tick, entries, storage }) {
  const byDirection = new Map();
  for (const entry of entries) {
    const group = byDirection.get(entry.direction) ?? [];
    group.push(entry);
    byDirection.set(entry.direction, group);
  }
  const regionSummary = storage === undefined ? undefined : summaryWith(storage);
  return [...byDirection.entries()].map(([direction, group]) => ({
    regionId,
    direction,
    revision,
    tick,
    ...(regionSummary === undefined ? {} : { regionSummary }),
    tiles: group.map(({ position, component }) => ({
      position: { ...position },
      tile: tileAt(position),
      ...(component === undefined ? {} : { passableComponent: component }),
    })),
  }));
}

const SOURCE_ENTRY = {
  direction: linkMiddle.direction,
  position: linkMiddle.sourcePosition,
  component: COMPONENT.source,
};
const MIDDLE_ENTRIES = [
  {
    direction: linkMiddle.neighborDirection,
    position: linkMiddle.neighborPosition,
    component: COMPONENT.middle,
  },
  {
    direction: linkMiddleToTarget.direction,
    position: linkMiddleToTarget.sourcePosition,
    component: COMPONENT.middle,
  },
];
const TARGET_ENTRY = {
  direction: linkMiddleToTarget.neighborDirection,
  position: linkMiddleToTarget.neighborPosition,
  component: COMPONENT.target,
};
const DIRECT_SOURCE_ENTRY = {
  direction: linkTarget.direction,
  position: linkTarget.sourcePosition,
  component: COMPONENT.source,
};
const DIRECT_TARGET_ENTRY = {
  direction: linkTarget.neighborDirection,
  position: linkTarget.neighborPosition,
  component: COMPONENT.directTarget,
};

const startRef = {
  regionId: sourceRegionId,
  revision: REVISION.source,
  tick: TICK.source,
  componentId: COMPONENT.source,
};
const middle = {
  regionId: middleRegionId,
  revision: REVISION.middle,
  tick: TICK.middle,
  componentId: COMPONENT.middle,
};
const target = {
  regionId: targetRegionId,
  revision: REVISION.target,
  tick: TICK.target,
  componentId: COMPONENT.target,
};
const directTarget = {
  regionId: targetRegionId,
  revision: REVISION.target,
  tick: TICK.target,
  componentId: COMPONENT.directTarget,
};

function baseSnapshots({
  targetStorage = { [FACTION]: [COMPONENT.target] },
  sourceExtra = [],
  targetExtra = [],
} = {}) {
  return [
    ...snapshotsFor({
      regionId: sourceRegionId,
      revision: REVISION.source,
      tick: TICK.source,
      entries: [...sourceExtra, SOURCE_ENTRY],
    }),
    ...snapshotsFor({
      regionId: middleRegionId,
      revision: REVISION.middle,
      tick: TICK.middle,
      entries: MIDDLE_ENTRIES,
    }),
    ...snapshotsFor({
      regionId: targetRegionId,
      revision: REVISION.target,
      tick: TICK.target,
      entries: [...targetExtra, TARGET_ENTRY],
      storage: targetStorage,
    }),
  ];
}

const detourLinks = [linkMiddle, linkMiddleToTarget];
const budget = { maxHops: 4, maxExpandedEdges: 32 };

function plan(overrides = {}) {
  return planMaterialReturnRoute({
    extent,
    links: detourLinks,
    snapshots: baseSnapshots(),
    start: startRef,
    targetRegionId,
    factionId: FACTION,
    budget,
    ...overrides,
  });
}

function exactCrossingTarget(nextHop) {
  const step = HEX_GRID_DIRECTION_STEPS[nextHop.direction];
  return regionCellTransition(
    nextHop.fromRegionId,
    { x: nextHop.position.x + step.x, y: nextHop.position.y + step.y },
    extent.width,
    extent.height,
  )?.targetRegionId;
}

test("equal-distance detour returns the exact first crossing once storage is proven", () => {
  const decision = plan();
  assert.equal(decision.status, "planned");
  assert.deepEqual(decision.route.map((ref) => ref.regionId), [
    sourceRegionId,
    middleRegionId,
    targetRegionId,
  ]);
  assert.equal(decision.hops, 2);
  assert.equal(decision.equalDistanceHops, 1, "the only known route starts with a detour");
  assert.equal(decision.storageComponentId, COMPONENT.target);
  assert.ok(decision.expandedEdges > 0);

  const nextHop = decision.nextHop;
  assert.equal(nextHop?.fromRegionId, sourceRegionId);
  assert.equal(nextHop?.toRegionId, middleRegionId);
  assert.deepEqual(nextHop?.position, linkMiddle.sourcePosition);
  assert.equal(nextHop?.direction, linkMiddle.direction);
  assert.equal(
    exactCrossingTarget(nextHop),
    middleRegionId,
    "the crossing step must land in the region the route actually enters",
  );
});

test("storage reachability requires positive membership for the arriving component", () => {
  const rejected = [
    { [FACTION]: [COMPONENT.directTarget] },
    { [FACTION]: [] },
    { lunar: [COMPONENT.target] },
    {},
    { [FACTION]: [COMPONENT.target, "303"] },
    { [FACTION]: [COMPONENT.target, -1] },
    { [FACTION]: COMPONENT.target },
    { [FACTION]: null },
  ];

  for (const targetStorage of rejected) {
    const decision = plan({ snapshots: baseSnapshots({ targetStorage }) });
    assert.equal(
      decision.status,
      "noStorageProof",
      `expected no proof for ${JSON.stringify(targetStorage)}`,
    );
    assert.ok(decision.expandedEdges > 0, "the planner must still have run");
  }

  const withoutSummary = baseSnapshots().map((snapshot) => {
    const { regionSummary, ...rest } = snapshot;
    return rest;
  });
  assert.equal(plan({ snapshots: withoutSummary }).status, "noStorageProof");
});

test("a malformed summary beside a valid positive one stays unknown, not authoritative", () => {
  const snapshots = [
    ...baseSnapshots().filter((snapshot) => snapshot.regionId !== targetRegionId),
    ...snapshotsFor({
      regionId: targetRegionId,
      revision: REVISION.target,
      tick: TICK.target,
      entries: [TARGET_ENTRY],
      storage: { [FACTION]: "not-an-array" },
    }),
    ...snapshotsFor({
      regionId: targetRegionId,
      revision: REVISION.target,
      tick: TICK.target,
      entries: [DIRECT_TARGET_ENTRY],
      storage: { [FACTION]: [COMPONENT.target] },
    }),
  ];

  assert.equal(plan({ snapshots }).status, "planned");
});

test("the proof must come from the same generation as the arrival component", () => {
  const snapshots = [
    ...baseSnapshots().map((snapshot) => {
      if (snapshot.regionId !== targetRegionId) return snapshot;
      const { regionSummary, ...rest } = snapshot;
      return rest;
    }),
    ...snapshotsFor({
      regionId: targetRegionId,
      revision: REVISION.target + 1,
      tick: TICK.target + 5,
      entries: [DIRECT_TARGET_ENTRY],
      storage: { [FACTION]: [COMPONENT.target] },
    }),
  ];

  assert.equal(plan({ snapshots }).status, "noStorageProof");
});

test("strict progress wins whenever a proven direct seam is observed", () => {
  const snapshots = baseSnapshots({
    sourceExtra: [DIRECT_SOURCE_ENTRY],
    targetExtra: [DIRECT_TARGET_ENTRY],
    targetStorage: { [FACTION]: [COMPONENT.directTarget, COMPONENT.target] },
  });

  const decision = plan({ links: [...detourLinks, linkTarget], snapshots });
  assert.equal(decision.status, "planned");
  assert.equal(decision.hops, 1);
  assert.equal(decision.equalDistanceHops, 0);
  assert.equal(decision.storageComponentId, COMPONENT.directTarget);
  assert.deepEqual(decision.route[1], directTarget);
  assert.equal(decision.nextHop?.direction, linkTarget.direction);
  assert.equal(exactCrossingTarget(decision.nextHop), targetRegionId);
});

test("an unproven direct seam does not block a proven equal-distance detour", () => {
  const snapshots = baseSnapshots({
    sourceExtra: [DIRECT_SOURCE_ENTRY],
    targetExtra: [DIRECT_TARGET_ENTRY],
    targetStorage: { [FACTION]: [COMPONENT.target] },
  });

  const decision = plan({ links: [...detourLinks, linkTarget], snapshots });
  assert.equal(decision.status, "planned");
  assert.equal(decision.hops, 2);
  assert.equal(decision.equalDistanceHops, 1);
  assert.equal(decision.storageComponentId, COMPONENT.target);
  assert.equal(decision.nextHop?.direction, linkMiddle.direction);
});

test("already inside the target region plans without inventing a crossing", () => {
  const decision = plan({ start: target });
  assert.equal(decision.status, "planned");
  assert.equal(decision.hops, 0);
  assert.equal(decision.nextHop, undefined);
  assert.equal(decision.storageComponentId, COMPONENT.target);

  const unproven = plan({
    start: target,
    snapshots: baseSnapshots({ targetStorage: { [FACTION]: [] } }),
  });
  assert.equal(unproven.status, "noStorageProof");
});

test("unknown legacy topology and empty observations fail closed", () => {
  const legacyLinks = buildHexHaloLinks(extent, ["garden-1", "legacy-east"], "garden-1");
  const legacyLink = legacyLinks.find((link) => link.neighborRegionId === "legacy-east");
  assert.ok(legacyLink);

  const unknownStart = plan({
    start: { regionId: "legacy-unknown", revision: 1, tick: 1, componentId: 5 },
  });
  assert.deepEqual(
    { status: unknownStart.status, expandedEdges: unknownStart.expandedEdges },
    { status: "noKnownRoute", expandedEdges: 0 },
  );

  assert.equal(plan({ links: [], snapshots: [] }).status, "noKnownRoute");
  assert.equal(plan({ links: [legacyLink] }).status, "noKnownRoute");
  assert.equal(
    plan({ snapshots: baseSnapshots().filter((s) => s.regionId !== middleRegionId) }).status,
    "noKnownRoute",
    "a disconnected frontier must never teleport to the target",
  );
});

test("budget exhaustion and malformed inputs never throw", () => {
  const hopLimited = plan({ budget: { maxHops: 0, maxExpandedEdges: 0 } });
  assert.equal(hopLimited.status, "budgetExhausted");
  assert.equal(hopLimited.expandedEdges, 0);

  const edgeLimited = plan({ budget: { maxHops: 4, maxExpandedEdges: 1 } });
  assert.equal(edgeLimited.status, "budgetExhausted");
  assert.ok(edgeLimited.expandedEdges >= 1);

  const malformed = [
    { start: { regionId: sourceRegionId, revision: -1, tick: 1, componentId: 1 } },
    { start: { regionId: sourceRegionId, revision: 1, tick: 1 } },
    { start: { regionId: "", revision: 1, tick: 1, componentId: 1 } },
    { start: undefined },
    { targetRegionId: "" },
    { targetRegionId: undefined },
    { factionId: "" },
    { factionId: "x".repeat(129) },
    { factionId: undefined },
    { extent: { width: 0, height: 24 } },
    { extent: { width: 40.5, height: 24 } },
    { extent: undefined },
    { budget: { maxHops: -1, maxExpandedEdges: 4 } },
    { links: undefined },
    { snapshots: undefined },
    { links: null, snapshots: null },
  ];

  for (const overrides of malformed) {
    let decision;
    assert.doesNotThrow(() => {
      decision = plan(overrides);
    }, JSON.stringify(overrides));
    assert.equal(decision.status, "noKnownRoute", JSON.stringify(overrides));
    assert.equal(decision.expandedEdges, 0, JSON.stringify(overrides));
  }
});

test("the decision is stable under complete observation reversal", () => {
  const snapshots = baseSnapshots();
  const forward = plan({ snapshots });
  const reversed = plan({
    links: [...detourLinks].reverse(),
    snapshots: [...snapshots].reverse(),
  });
  assert.deepEqual(reversed, forward);
  assert.deepEqual(plan().route[1], middle);
});

test("inputs are never mutated", () => {
  const links = detourLinks;
  const snapshots = baseSnapshots();
  const before = structuredClone({ links, snapshots, start: startRef });
  plan({ links, snapshots });
  assert.deepEqual({ links, snapshots, start: startRef }, before);
});
