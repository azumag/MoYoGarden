import assert from "node:assert/strict";
import test from "node:test";
import { planMaterialReturnDetour } from "../dist-ts/src/material-return-route.js";

function ref(regionId, componentId = 1, revision = 1, tick = 1) {
  return { regionId, revision, tick, componentId };
}

function edge(a, b) {
  return {
    a,
    b,
    aPort: {
      regionId: a.regionId,
      position: { x: 0, y: 0 },
      stepDirection: "east",
      snapshotDirection: "east",
    },
    bPort: {
      regionId: b.regionId,
      position: { x: 0, y: 0 },
      stepDirection: "west",
      snapshotDirection: "west",
    },
  };
}

const generous = { maxHops: 8, maxExpandedEdges: 64 };

test("plans a strict-progress return route", () => {
  const start = ref("hex-q2-r0", 10);
  const middle = ref("garden-2", 20);
  const target = ref("garden-1", 30);
  const plan = planMaterialReturnDetour(
    start,
    "garden-1",
    [edge(start, middle), edge(middle, target)],
    generous,
  );

  assert.equal(plan.status, "planned");
  assert.deepEqual(plan.route.map((node) => node.regionId), [
    "hex-q2-r0",
    "garden-2",
    "garden-1",
  ]);
  assert.equal(plan.equalDistanceHops, 0);
});

test("allows a bounded equal-distance detour before resuming strict progress", () => {
  const start = ref("hex-q2-r0", 10);
  const detour = ref("hex-q2-r-1", 20);
  const middle = ref("garden-3", 30);
  const target = ref("garden-1", 40);
  const plan = planMaterialReturnDetour(
    start,
    "garden-1",
    [
      edge(start, detour),
      edge(detour, middle),
      edge(middle, target),
    ],
    generous,
  );

  assert.equal(plan.status, "planned");
  assert.deepEqual(plan.route.map((node) => node.regionId), [
    "hex-q2-r0",
    "hex-q2-r-1",
    "garden-3",
    "garden-1",
  ]);
  assert.equal(plan.equalDistanceHops, 1);
});

test("prefers strict progress over an available equal-distance detour", () => {
  const start = ref("hex-q2-r0", 10);
  const strict = ref("garden-2", 20);
  const detour = ref("hex-q2-r-1", 30);
  const detourMiddle = ref("garden-3", 40);
  const target = ref("garden-1", 50);
  const plan = planMaterialReturnDetour(
    start,
    "garden-1",
    [
      edge(start, detour),
      edge(detour, detourMiddle),
      edge(detourMiddle, target),
      edge(start, strict),
      edge(strict, target),
    ],
    generous,
  );

  assert.equal(plan.status, "planned");
  assert.deepEqual(plan.route.map((node) => node.regionId), [
    "hex-q2-r0",
    "garden-2",
    "garden-1",
  ]);
  assert.equal(plan.equalDistanceHops, 0);
});

test("equal-distance cycles terminate without revisiting a more expensive component state", () => {
  const start = ref("hex-q2-r0", 10);
  const peer = ref("hex-q2-r-1", 20);
  const plan = planMaterialReturnDetour(
    start,
    "garden-1",
    [edge(start, peer)],
    generous,
  );

  assert.equal(plan.status, "noKnownRoute");
  assert.ok(plan.expandedEdges <= 2);
});

test("does not report hop budget exhaustion when only a dominated equal-distance cycle remains", () => {
  const start = ref("hex-q2-r0", 10);
  const peer = ref("hex-q2-r-1", 20);
  const plan = planMaterialReturnDetour(
    start,
    "garden-1",
    [edge(start, peer)],
    { maxHops: 1, maxExpandedEdges: 64 },
  );

  assert.deepEqual(plan, { status: "noKnownRoute", expandedEdges: 1 });
});

test("reports hop budget exhaustion without inventing a partial route", () => {
  const start = ref("hex-q2-r0", 10);
  const middle = ref("garden-2", 20);
  const target = ref("garden-1", 30);
  const plan = planMaterialReturnDetour(
    start,
    "garden-1",
    [edge(start, middle), edge(middle, target)],
    { maxHops: 1, maxExpandedEdges: 64 },
  );

  assert.deepEqual(plan, { status: "budgetExhausted", expandedEdges: 1 });
});

test("reports edge-expansion budget exhaustion", () => {
  const start = ref("hex-q2-r0", 10);
  const middle = ref("garden-2", 20);
  const target = ref("garden-1", 30);
  const plan = planMaterialReturnDetour(
    start,
    "garden-1",
    [edge(start, middle), edge(middle, target)],
    { maxHops: 8, maxExpandedEdges: 1 },
  );

  assert.deepEqual(plan, { status: "budgetExhausted", expandedEdges: 1 });
});

test("does not silently join the same component id across revision or tick changes", () => {
  const start = ref("hex-q2-r0", 10);
  const observedMiddle = ref("garden-2", 20, 1, 10);
  const staleMiddle = ref("garden-2", 20, 2, 10);
  const otherTickMiddle = ref("garden-2", 20, 1, 11);
  const target = ref("garden-1", 30);

  for (const disconnected of [staleMiddle, otherTickMiddle]) {
    const plan = planMaterialReturnDetour(
      start,
      "garden-1",
      [edge(start, observedMiddle), edge(disconnected, target)],
      generous,
    );
    assert.equal(plan.status, "noKnownRoute");
  }
});

test("does not connect distinct passable components merely because they share a region", () => {
  const start = ref("hex-q2-r0", 10);
  const entry = ref("garden-2", 20);
  const exit = ref("garden-2", 21);
  const target = ref("garden-1", 30);
  const plan = planMaterialReturnDetour(
    start,
    "garden-1",
    [edge(start, entry), edge(exit, target)],
    generous,
  );

  assert.equal(plan.status, "noKnownRoute");
});

test("route selection is invariant to input edge order", () => {
  const start = ref("hex-q2-r0", 10);
  const strict = ref("garden-2", 20);
  const detour = ref("hex-q2-r-1", 30);
  const detourMiddle = ref("garden-3", 40);
  const target = ref("garden-1", 50);
  const edges = [
    edge(start, detour),
    edge(detour, detourMiddle),
    edge(detourMiddle, target),
    edge(start, strict),
    edge(strict, target),
  ];

  const forward = planMaterialReturnDetour(start, "garden-1", edges, generous);
  const reversed = planMaterialReturnDetour(start, "garden-1", [...edges].reverse(), generous);
  assert.deepEqual(reversed, forward);
});

test("malformed seam ports fail closed without mutating the input", () => {
  const start = ref("garden-2", 10);
  const target = ref("garden-1", 20);
  const valid = edge(start, target);
  const cases = [
    { ...valid, aPort: undefined },
    { ...valid, bPort: undefined },
    { ...valid, aPort: { ...valid.aPort, regionId: "garden-3" } },
    {
      ...valid,
      aPort: {
        ...valid.aPort,
        position: { ...valid.aPort.position, x: 0.5 },
      },
    },
    { ...valid, aPort: { ...valid.aPort, stepDirection: "north" } },
    { ...valid, bPort: { ...valid.bPort, snapshotDirection: "south" } },
  ];

  for (const candidate of cases) {
    const edges = [candidate];
    const before = structuredClone(edges);
    assert.doesNotThrow(() => {
      const plan = planMaterialReturnDetour(start, "garden-1", edges, generous);
      assert.deepEqual(plan, { status: "noKnownRoute", expandedEdges: 0 });
    });
    assert.deepEqual(edges, before);
  }
});

test("malformed graph observations fail closed without mutating the input", () => {
  const start = ref("hex-q2-r0", 10);
  const middle = ref("garden-2", 20);
  const target = ref("garden-1", 30);
  const malformed = [
    null,
    {},
    { a: start },
    { a: { ...start, revision: -1 }, b: middle },
    { a: start, b: { ...middle, componentId: 1.5 } },
  ];
  const edges = [
    ...malformed,
    edge(start, middle),
    edge(middle, target),
  ];
  const before = structuredClone(edges);

  assert.doesNotThrow(() => {
    const plan = planMaterialReturnDetour(start, "garden-1", edges, generous);
    assert.equal(plan.status, "planned");
  });
  assert.deepEqual(edges, before);
});

test("unknown legacy ids keep direct-to-source compatibility but do not invent relay topology", () => {
  const legacyStart = ref("legacy-a", 10);
  const legacyMiddle = ref("legacy-b", 20);
  const target = ref("legacy-source", 30);

  const direct = planMaterialReturnDetour(
    legacyStart,
    "legacy-source",
    [edge(legacyStart, target)],
    generous,
  );
  assert.equal(direct.status, "planned");
  assert.deepEqual(direct.route.map((node) => node.regionId), [
    "legacy-a",
    "legacy-source",
  ]);

  const relayed = planMaterialReturnDetour(
    legacyStart,
    "legacy-source",
    [edge(legacyStart, legacyMiddle), edge(legacyMiddle, target)],
    generous,
  );
  assert.equal(relayed.status, "noKnownRoute");
});
