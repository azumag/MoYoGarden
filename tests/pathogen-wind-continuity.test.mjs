import assert from "node:assert/strict";
import test from "node:test";
import {
  HEX_GRID_DIRECTION_STEPS,
  oppositeHexGridDirection,
} from "../dist-ts/src/hex-grid.js";
import {
  applyPathogenSteps,
  pathogenAdjacentContactGain,
  pathogenHaloPressureMap,
} from "../dist-ts/src/pathogen.js";
import { sampleWorldWind } from "../dist-ts/src/world-scale.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

const WORLD_SEED = 424_242;
const TARGET = { x: 19, y: 11 };

function strongWindFrame() {
  for (let originX = -768; originX <= 768; originX += 16) {
    for (let originY = -768; originY <= 768; originY += 16) {
      const wind = sampleWorldWind(WORLD_SEED, originX + TARGET.x, originY + TARGET.y);
      if (wind.strength >= 0.45) {
        return { environment: { worldSeed: WORLD_SEED, originX, originY }, wind };
      }
    }
  }
  throw new Error("expected a deterministic strong-wind sample");
}

function infectedPair(sourceDirection, environment) {
  const state = createInitialWorld({ seed: 26091541, width: 40, height: 24 });
  const target = structuredClone(state.agents[0]);
  const source = structuredClone(state.agents[1]);
  assert.ok(target);
  assert.ok(source);
  const step = HEX_GRID_DIRECTION_STEPS[sourceDirection];
  target.id = "wind-target";
  target.position = { ...TARGET };
  target.energy = 100;
  delete target.pathogenLoad;
  source.id = "wind-source";
  source.position = { x: TARGET.x + step.x, y: TARGET.y + step.y };
  source.energy = 100;
  source.pathogenLoad = 1;
  state.agents = [target, source];
  applyPathogenSteps(state, 1, environment);
  return state.agents.find((agent) => agent.id === target.id)?.pathogenLoad ?? 0;
}

test("shared world wind favors an upwind adjacent carrier without exceeding the legacy gain", () => {
  const { environment, wind } = strongWindFrame();
  const upwind = oppositeHexGridDirection(wind.direction);
  const baseline = pathogenAdjacentContactGain(TARGET, upwind, undefined);
  const upwindGain = pathogenAdjacentContactGain(TARGET, upwind, environment);
  const nonUpwindGain = pathogenAdjacentContactGain(TARGET, wind.direction, environment);

  assert.equal(upwindGain, baseline, "upwind contact keeps the legacy adjacent gain");
  assert.ok(nonUpwindGain < baseline, "airflow away from the target should attenuate exposure");
  assert.ok(nonUpwindGain >= baseline * 0.82, "wind attenuation must stay conservatively bounded");

  const upwindLoad = infectedPair(upwind, environment);
  const nonUpwindLoad = infectedPair(wind.direction, environment);
  assert.ok(upwindLoad > nonUpwindLoad, "local six-neighbor infection should follow the wind field");
});

test("cross-region pathogen pressure uses the same directional wind factor as local adjacency", () => {
  const { environment, wind } = strongWindFrame();
  const upwind = oppositeHexGridDirection(wind.direction);
  const baseline = pathogenAdjacentContactGain(TARGET, upwind, undefined);
  const directions = [upwind, wind.direction];

  for (const direction of directions) {
    const link = {
      sourceRegionId: "garden-1",
      sourcePosition: { ...TARGET },
      direction,
      neighborRegionId: "hex-q9-r9",
      neighborPosition: { x: 7, y: 7 },
      neighborDirection: oppositeHexGridDirection(direction),
    };
    const edge = {
      regionId: link.neighborRegionId,
      direction: link.neighborDirection,
      revision: 1,
      tick: 30,
      agents: [{ position: { ...link.neighborPosition }, pressure: 0.5 }],
      reservoirs: [],
    };
    const mapped = pathogenHaloPressureMap([link], [edge], environment).get("19,11") ?? 0;
    const expected = 0.5 * pathogenAdjacentContactGain(TARGET, direction, environment) / baseline;
    assert.ok(Math.abs(mapped - expected) < 1e-12, `${direction} halo factor should match local adjacency`);
  }
});
