import assert from "node:assert/strict";
import test from "node:test";
import { hexGridBoundaryCells } from "../dist-ts/src/hex-grid.js";
import {
  agentPathogenLoad,
  applyPathogenSteps,
  pathogenEdgeSnapshot,
  pathogenHaloMaps,
  pathogenHaloPressureMap,
  pathogenHaloReservoirMap,
} from "../dist-ts/src/pathogen.js";

function agent(id, position) {
  return {
    id,
    name: id,
    factionId: "faction-a",
    role: "forager",
    position: { ...position },
    hp: 100,
    energy: 50,
    capacity: 24,
    inventory: { wood: 0, stone: 0, food: 0 },
    autonomy: true,
    goal: "test",
    status: "idle",
  };
}

function tile(position, pathogenReservoir = undefined) {
  return {
    ...position,
    terrain: "plain",
    ...(pathogenReservoir === undefined ? {} : { pathogenReservoir }),
  };
}

test("environmental reservoir uses the same adjacent-hex strength across a region seam", () => {
  const localTarget = agent("local-target", { x: 1, y: 0 });
  applyPathogenSteps({
    agents: [localTarget],
    tiles: [tile({ x: 0, y: 0 }, 0.8)],
  }, 1);
  const localAdjacentLoad = agentPathogenLoad(localTarget);
  assert.ok(localAdjacentLoad > 0, "an immediately adjacent contaminated hex should expose a BOT");

  const link = {
    sourceRegionId: "garden-1",
    sourcePosition: { x: 30, y: 11 },
    direction: "east",
    neighborRegionId: "garden-2",
    neighborPosition: { x: 8, y: 11 },
    neighborDirection: "west",
  };
  const haloReservoir = pathogenHaloReservoirMap([link], [{
    regionId: "garden-2",
    direction: "west",
    revision: 4,
    tick: 30,
    agents: [],
    reservoirs: [{ position: { ...link.neighborPosition }, burden: 0.8 }],
  }]);
  assert.equal(haloReservoir.get("30,11"), 0.8);

  const seamTarget = agent("seam-target", link.sourcePosition);
  applyPathogenSteps(
    { agents: [seamTarget], tiles: [] },
    0,
    undefined,
    new Map(),
    1,
    haloReservoir,
  );
  assert.ok(
    Math.abs(agentPathogenLoad(seamTarget) - localAdjacentLoad) < 1e-12,
    "a DO boundary must not change immediate-neighbor environmental exposure strength",
  );
});

test("pathogen edge snapshot exports only contaminated boundary tiles", () => {
  const extent = { width: 40, height: 24 };
  const boundary = hexGridBoundaryCells(extent, "east")[0];
  assert.ok(boundary);
  const interior = { x: 19, y: 11 };
  const snapshot = pathogenEdgeSnapshot({
    regionId: "garden-1",
    revision: 9,
    tick: 30,
    ...extent,
    agents: [],
    tiles: [
      tile(boundary, 0.7),
      tile(interior, 0.9),
    ],
  }, "east");

  assert.deepEqual(snapshot.reservoirs, [{ position: boundary, burden: 0.7 }]);
});

test("combined pathogen halo materialization preserves pressure and reservoir semantics", () => {
  const links = [
    {
      sourceRegionId: "garden-1",
      sourcePosition: { x: 30, y: 11 },
      direction: "east",
      neighborRegionId: "garden-2",
      neighborPosition: { x: 8, y: 11 },
      neighborDirection: "west",
    },
    {
      sourceRegionId: "garden-1",
      sourcePosition: { x: 30, y: 11 },
      direction: "northeast",
      neighborRegionId: "hex-q1-r-1",
      neighborPosition: { x: 18, y: 22 },
      neighborDirection: "southwest",
    },
  ];
  const edges = [
    {
      regionId: "garden-2",
      direction: "west",
      revision: 8,
      tick: 60,
      agents: [{ position: { x: 8, y: 11 }, pressure: 0.35 }],
      reservoirs: [{ position: { x: 8, y: 11 }, burden: 0.4 }],
    },
    {
      regionId: "hex-q1-r-1",
      direction: "southwest",
      revision: 3,
      tick: 60,
      agents: [{ position: { x: 18, y: 22 }, pressure: 0.5 }],
      reservoirs: [{ position: { x: 18, y: 22 }, burden: 0.25 }],
    },
  ];

  const combined = pathogenHaloMaps(links, edges);
  assert.deepEqual(combined.pressure, pathogenHaloPressureMap(links, edges));
  assert.deepEqual(combined.reservoir, pathogenHaloReservoirMap(links, edges));
  assert.ok((combined.pressure.get("30,11") ?? 0) > 0.35);
  assert.ok((combined.reservoir.get("30,11") ?? 0) > 0.4);
});
