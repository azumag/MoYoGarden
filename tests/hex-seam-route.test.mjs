import assert from "node:assert/strict";
import test from "node:test";
import { planBoundedHexSeamComponentRoute } from "../dist-ts/src/hex-seam-route.js";

function component(regionId, componentId, revision = 1, tick = 1) {
  return { regionId, revision, tick, componentId };
}

function port(regionId, x, direction) {
  return {
    regionId,
    position: { x, y: 0 },
    stepDirection: direction,
    snapshotDirection: direction,
  };
}

function edge(a, b, index = 0) {
  return {
    a,
    b,
    aPort: port(a.regionId, index, "E"),
    bPort: port(b.regionId, index, "W"),
  };
}

function regionIds(plan) {
  return plan?.components.map((entry) => entry.regionId);
}

test("strict-progress route wins before an equal-distance detour", () => {
  const start = component("hex-q1-r0", 1);
  const target = component("hex-q0-r0", 2);
  const plateau = component("hex-q1-r-1", 3);

  const plan = planBoundedHexSeamComponentRoute(
    [
      edge(start, plateau, 2),
      edge(plateau, target, 3),
      edge(start, target, 1),
    ],
    start,
    target.regionId,
  );

  assert.deepEqual(regionIds(plan), ["hex-q1-r0", "hex-q0-r0"]);
  assert.equal(plan?.usedPlateauDetour, false);
});

test("equal-distance detour is allowed only after strict routing is blocked", () => {
  const start = component("hex-q2-r0", 1);
  const plateau = component("hex-q2-r-1", 2);
  const progress = component("hex-q1-r0", 3);
  const target = component("hex-q0-r0", 4);

  const plan = planBoundedHexSeamComponentRoute(
    [
      edge(start, plateau, 1),
      edge(plateau, progress, 2),
      edge(progress, target, 3),
    ],
    start,
    target.regionId,
  );

  assert.deepEqual(regionIds(plan), [
    "hex-q2-r0",
    "hex-q2-r-1",
    "hex-q1-r0",
    "hex-q0-r0",
  ]);
  assert.equal(plan?.usedPlateauDetour, true);
});

test("distance-increasing detours remain fail-closed", () => {
  const start = component("hex-q2-r0", 1);
  const outward = component("hex-q3-r0", 2);
  const progress = component("hex-q2-r-1", 3);
  const target = component("hex-q0-r0", 4);

  assert.equal(
    planBoundedHexSeamComponentRoute(
      [
        edge(start, outward, 1),
        edge(outward, progress, 2),
        edge(progress, target, 3),
      ],
      start,
      target.regionId,
    ),
    undefined,
  );
});

test("cycles terminate and do not manufacture a route", () => {
  const start = component("hex-q2-r0", 1);
  const first = component("hex-q2-r-1", 2);
  const second = component("hex-q1-r1", 3);

  assert.equal(
    planBoundedHexSeamComponentRoute(
      [
        edge(start, first, 1),
        edge(first, second, 2),
        edge(second, start, 3),
      ],
      start,
      "hex-q0-r0",
      { maxHops: 6, maxEdgeExpansions: 32 },
    ),
    undefined,
  );
});

test("hop and edge-expansion budgets fail closed", () => {
  const start = component("hex-q2-r0", 1);
  const plateau = component("hex-q2-r-1", 2);
  const progress = component("hex-q1-r0", 3);
  const target = component("hex-q0-r0", 4);
  const edges = [
    edge(start, plateau, 1),
    edge(plateau, progress, 2),
    edge(progress, target, 3),
  ];

  assert.equal(
    planBoundedHexSeamComponentRoute(
      edges,
      start,
      target.regionId,
      { maxHops: 2 },
    ),
    undefined,
  );
  assert.equal(
    planBoundedHexSeamComponentRoute(
      edges,
      start,
      target.regionId,
      { maxEdgeExpansions: 2 },
    ),
    undefined,
  );
  assert.ok(
    planBoundedHexSeamComponentRoute(
      edges,
      start,
      target.regionId,
      { maxHops: 3, maxEdgeExpansions: 32 },
    ),
  );
});

test("route choice is invariant to graph input order", () => {
  const start = component("hex-q2-r0", 1);
  const north = component("hex-q2-r-1", 2);
  const south = component("hex-q1-r1", 3);
  const northProgress = component("hex-q1-r0", 4);
  const southProgress = component("hex-q1-r0", 5);
  const target = component("hex-q0-r0", 6);
  const edges = [
    edge(start, north, 1),
    edge(north, northProgress, 2),
    edge(northProgress, target, 3),
    edge(start, south, 4),
    edge(south, southProgress, 5),
    edge(southProgress, target, 6),
  ];

  const forward = planBoundedHexSeamComponentRoute(edges, start, target.regionId);
  const reversed = planBoundedHexSeamComponentRoute(
    [...edges].reverse(),
    start,
    target.regionId,
  );

  assert.deepEqual(reversed, forward);
});

test("same component id at a different tick or revision is not stitched together", () => {
  const start = component("hex-q2-r0", 1, 7, 20);
  const observed = component("hex-q2-r-1", 9, 7, 20);
  const target = component("hex-q0-r0", 3, 7, 20);

  for (const incompatible of [
    component(observed.regionId, observed.componentId, 7, 21),
    component(observed.regionId, observed.componentId, 8, 20),
  ]) {
    assert.equal(
      planBoundedHexSeamComponentRoute(
        [
          edge(start, observed, 1),
          edge(incompatible, target, 2),
        ],
        start,
        target.regionId,
      ),
      undefined,
    );
  }
});

test("direct exact target remains available for a legacy non-axial id", () => {
  const start = component("legacy-source", 1);
  const target = component("legacy-target", 2);

  const plan = planBoundedHexSeamComponentRoute(
    [edge(start, target, 1)],
    start,
    target.regionId,
  );

  assert.deepEqual(regionIds(plan), ["legacy-source", "legacy-target"]);
  assert.equal(plan?.usedPlateauDetour, false);
});
