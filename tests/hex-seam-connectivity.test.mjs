import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDynamicHexHaloLinks,
  buildHexHaloLinks,
} from "../dist-ts/src/hex-halo.js";
import {
  HEX_GRID_DIRECTIONS,
  oppositeHexGridDirection,
} from "../dist-ts/src/hex-grid.js";
import {
  buildReciprocalHexSeamConnectivity,
} from "../dist-ts/src/hex-seam-connectivity.js";

const extent = { width: 40, height: 24 };
const sourceRegionId = "hex-q4-r-2";
const dynamicLinks = buildDynamicHexHaloLinks(extent, sourceRegionId);

function tileAt(position, terrain = "plain") {
  return {
    x: position.x,
    y: position.y,
    terrain,
    elevation: terrain === "water" ? 0 : 0.4,
  };
}

function snapshot(regionId, direction, revision, tick, entries) {
  return {
    regionId,
    direction,
    revision,
    tick,
    tiles: entries.map(({ position, component, terrain = "plain" }) => ({
      position: { ...position },
      tile: tileAt(position, terrain),
      ...(component === undefined ? {} : { passableComponent: component }),
    })),
  };
}

function snapshotsForLink(link, options = {}) {
  const {
    revision = 7,
    sourceTick = 20,
    neighborTick = 21,
    sourceComponent = 11,
    neighborComponent = 17,
  } = options;
  return [
    snapshot(
      link.sourceRegionId,
      link.direction,
      revision,
      sourceTick,
      [{ position: link.sourcePosition, component: sourceComponent }],
    ),
    snapshot(
      link.neighborRegionId,
      link.neighborDirection,
      revision,
      neighborTick,
      [{ position: link.neighborPosition, component: neighborComponent }],
    ),
  ];
}

function componentForRegion(edge, regionId) {
  if (edge.a.regionId === regionId) return edge.a;
  if (edge.b.regionId === regionId) return edge.b;
  return undefined;
}

test("exact reciprocal seam connects passable component snapshots", () => {
  const link = dynamicLinks[0];
  assert.ok(link);

  const graph = buildReciprocalHexSeamConnectivity(
    extent,
    [link],
    snapshotsForLink(link),
  );

  assert.equal(graph.length, 1);
  const edge = graph[0];
  assert.ok(edge);
  assert.equal(componentForRegion(edge, link.sourceRegionId)?.componentId, 11);
  assert.equal(componentForRegion(edge, link.neighborRegionId)?.componentId, 17);
  assert.equal(componentForRegion(edge, link.sourceRegionId)?.tick, 20);
  assert.equal(componentForRegion(edge, link.neighborRegionId)?.tick, 21);
});

test("missing passable component label fails closed", () => {
  const link = dynamicLinks[0];
  assert.ok(link);
  const [source, neighbor] = snapshotsForLink(link);
  assert.ok(source);
  assert.ok(neighbor);
  neighbor.tiles[0] = {
    position: { ...link.neighborPosition },
    tile: tileAt(link.neighborPosition),
  };

  assert.deepEqual(
    buildReciprocalHexSeamConnectivity(extent, [link], [source, neighbor]),
    [],
  );
});

test("negative snapshot revision or tick fails closed", () => {
  const link = dynamicLinks[0];
  assert.ok(link);

  for (const field of ["revision", "tick"]) {
    const observations = snapshotsForLink(link);
    observations[0][field] = -1;
    assert.deepEqual(
      buildReciprocalHexSeamConnectivity(extent, [link], observations),
      [],
      `negative ${field} must be rejected`,
    );
  }
});

test("malformed snapshot version poisons the edge key independent of input order", () => {
  const link = dynamicLinks[0];
  assert.ok(link);
  const [source, neighbor] = snapshotsForLink(link);
  assert.ok(source);
  assert.ok(neighbor);

  for (const field of ["revision", "tick"]) {
    const malformed = {
      ...structuredClone(neighbor),
      [field]: -1,
    };

    for (const observations of [
      [source, neighbor, malformed],
      [malformed, source, neighbor],
    ]) {
      assert.deepEqual(
        buildReciprocalHexSeamConnectivity(extent, [link], observations),
        [],
        `malformed ${field} must poison the edge key regardless of input order`,
      );
    }
  }
});

test("malformed snapshot tiles fail closed without throwing", () => {
  const link = dynamicLinks[0];
  assert.ok(link);
  const [source, neighbor] = snapshotsForLink(link);
  assert.ok(source);
  assert.ok(neighbor);

  const malformedNeighbors = [
    { ...structuredClone(neighbor), tiles: null },
    { ...structuredClone(neighbor), tiles: [null] },
    { ...structuredClone(neighbor), tiles: [{}] },
    {
      ...structuredClone(neighbor),
      tiles: [{ position: {}, passableComponent: 17 }],
    },
    {
      ...structuredClone(neighbor),
      tiles: [{
        position: { x: link.neighborPosition.x + 0.5, y: link.neighborPosition.y },
        passableComponent: 17,
      }],
    },
    {
      ...structuredClone(neighbor),
      tiles: [{
        position: { ...link.neighborPosition },
        passableComponent: -1,
      }],
    },
  ];

  for (const malformed of malformedNeighbors) {
    assert.doesNotThrow(() => {
      assert.deepEqual(
        buildReciprocalHexSeamConnectivity(extent, [link], [source, malformed]),
        [],
      );
    });
  }
});

test("freshest edge snapshot wins and can invalidate a stale component label", () => {
  const link = dynamicLinks[0];
  assert.ok(link);
  const [source, staleNeighbor] = snapshotsForLink(link, { revision: 3 });
  assert.ok(source);
  assert.ok(staleNeighbor);
  const freshNeighbor = snapshot(
    link.neighborRegionId,
    link.neighborDirection,
    4,
    1,
    [{ position: link.neighborPosition }],
  );

  assert.deepEqual(
    buildReciprocalHexSeamConnectivity(
      extent,
      [link],
      [freshNeighbor, staleNeighbor, source],
    ),
    [],
  );
});

test("same-version conflicting duplicate observations fail closed independent of input order", () => {
  const link = dynamicLinks[0];
  assert.ok(link);
  const [source, neighbor] = snapshotsForLink(link);
  assert.ok(source);
  assert.ok(neighbor);
  const conflict = snapshot(
    link.neighborRegionId,
    link.neighborDirection,
    neighbor.revision,
    neighbor.tick,
    [{ position: link.neighborPosition, component: 999 }],
  );

  for (const observations of [
    [source, neighbor, conflict],
    [conflict, source, neighbor],
  ]) {
    assert.deepEqual(
      buildReciprocalHexSeamConnectivity(extent, [link], observations),
      [],
    );
  }
});

test("same-version duplicate missing the seam cell fails closed", () => {
  const link = dynamicLinks[0];
  assert.ok(link);
  const [source, neighbor] = snapshotsForLink(link);
  assert.ok(source);
  assert.ok(neighbor);
  const incomplete = snapshot(
    link.neighborRegionId,
    link.neighborDirection,
    neighbor.revision,
    neighbor.tick,
    [{
      position: { x: link.neighborPosition.x + 1, y: link.neighborPosition.y },
      component: 17,
    }],
  );

  assert.deepEqual(
    buildReciprocalHexSeamConnectivity(
      extent,
      [link],
      [source, neighbor, incomplete],
    ),
    [],
  );
});

test("historical side-pair fallback is rejected when it is not the exact global-cell owner", () => {
  const fallbackLinks = buildHexHaloLinks(
    extent,
    ["garden-1", "legacy-east"],
    "garden-1",
  );
  const link = fallbackLinks.find((candidate) => candidate.neighborRegionId === "legacy-east");
  assert.ok(link, "fixture should expose the historical compatibility neighbor");

  assert.deepEqual(
    buildReciprocalHexSeamConnectivity(
      extent,
      [link],
      snapshotsForLink(link),
    ),
    [],
  );
});

test("slanted seam uses exact reverse cell transition rather than assuming opposite local step", () => {
  const link = dynamicLinks.find(
    (candidate) => candidate.direction !== oppositeHexGridDirection(candidate.neighborDirection),
  );
  assert.ok(link, "fixture should contain a slanted seam whose local and macro directions differ");

  const graph = buildReciprocalHexSeamConnectivity(
    extent,
    [link],
    snapshotsForLink(link),
  );
  assert.equal(graph.length, 1);

  const edge = graph[0];
  assert.ok(edge);
  const sourcePort = edge.aPort.regionId === link.sourceRegionId ? edge.aPort : edge.bPort;
  const neighborPort = edge.aPort.regionId === link.neighborRegionId ? edge.aPort : edge.bPort;
  assert.equal(sourcePort.stepDirection, link.direction);
  assert.equal(neighborPort.snapshotDirection, link.neighborDirection);
  assert.notEqual(
    neighborPort.stepDirection,
    link.neighborDirection,
    "macro edge direction must not be reused as the local reverse step on this slanted seam",
  );
});

test("multiple seam cells between the same component pair dedupe deterministically", () => {
  const groups = new Map();
  for (const link of dynamicLinks) {
    const key = JSON.stringify([
      link.direction,
      link.neighborRegionId,
      link.neighborDirection,
    ]);
    const group = groups.get(key) ?? [];
    group.push(link);
    groups.set(key, group);
  }
  const pair = [...groups.values()].find((group) => group.length >= 2)?.slice(0, 2);
  assert.ok(pair);
  const [first, second] = pair;
  assert.ok(first);
  assert.ok(second);

  const source = snapshot(
    first.sourceRegionId,
    first.direction,
    8,
    30,
    pair.map((link) => ({ position: link.sourcePosition, component: 5 })),
  );
  const neighbor = snapshot(
    first.neighborRegionId,
    first.neighborDirection,
    9,
    31,
    pair.map((link) => ({ position: link.neighborPosition, component: 6 })),
  );

  const forward = buildReciprocalHexSeamConnectivity(
    extent,
    [first, second],
    [source, neighbor],
  );
  const reversed = buildReciprocalHexSeamConnectivity(
    extent,
    [second, first],
    [neighbor, source],
  );
  assert.equal(forward.length, 1);
  assert.deepEqual(reversed, forward);
});

test("same component id observed at different ticks remains distinct across source edges", () => {
  let pair;
  for (const first of dynamicLinks) {
    for (const second of dynamicLinks) {
      if (
        first.direction !== second.direction
        && first.neighborRegionId !== second.neighborRegionId
      ) {
        pair = [first, second];
        break;
      }
    }
    if (pair !== undefined) break;
  }
  assert.ok(pair);
  const [first, second] = pair;
  assert.ok(first);
  assert.ok(second);

  const observations = [
    snapshot(
      first.sourceRegionId,
      first.direction,
      12,
      40,
      [{ position: first.sourcePosition, component: 4 }],
    ),
    snapshot(
      first.neighborRegionId,
      first.neighborDirection,
      2,
      5,
      [{ position: first.neighborPosition, component: 8 }],
    ),
    snapshot(
      second.sourceRegionId,
      second.direction,
      12,
      41,
      [{ position: second.sourcePosition, component: 4 }],
    ),
    snapshot(
      second.neighborRegionId,
      second.neighborDirection,
      2,
      6,
      [{ position: second.neighborPosition, component: 9 }],
    ),
  ];

  const graph = buildReciprocalHexSeamConnectivity(extent, pair, observations);
  assert.equal(graph.length, 2);
  const sourceRefs = graph
    .map((edge) => componentForRegion(edge, sourceRegionId))
    .filter(Boolean)
    .sort((a, b) => a.tick - b.tick);
  assert.deepEqual(sourceRefs.map((ref) => ref.tick), [40, 41]);
  assert.ok(sourceRefs.every((ref) => ref.componentId === 4));
});

test("all graph edges are stable under complete input reversal", () => {
  const links = HEX_GRID_DIRECTIONS.flatMap((direction) => {
    const candidate = dynamicLinks.find((link) => link.direction === direction);
    return candidate === undefined ? [] : [candidate];
  });
  const observations = links.flatMap((link, index) =>
    snapshotsForLink(link, {
      revision: 20 + index,
      sourceTick: 50 + index,
      neighborTick: 60 + index,
      sourceComponent: 100 + index,
      neighborComponent: 200 + index,
    })
  );

  const forward = buildReciprocalHexSeamConnectivity(extent, links, observations);
  const reversed = buildReciprocalHexSeamConnectivity(
    extent,
    [...links].reverse(),
    [...observations].reverse(),
  );
  assert.deepEqual(reversed, forward);
});
