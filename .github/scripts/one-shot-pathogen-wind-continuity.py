from pathlib import Path

pathogen = Path("src/pathogen.ts")
text = pathogen.read_text()

old_import = 'import { hexGridBoundaryCells, hexGridNeighbors, type HexGridDirection } from "./hex-grid.js";'
new_import = '''import {
  HEX_GRID_DIRECTIONS,
  HEX_GRID_DIRECTION_STEPS,
  hexGridBoundaryCells,
  hexGridNeighbors,
  oppositeHexGridDirection,
  type HexGridDirection,
} from "./hex-grid.js";'''
assert old_import in text, "hex-grid import marker changed"
text = text.replace(old_import, new_import, 1)

old_world_scale = 'import { sampleWorldConditions } from "./world-scale.js";'
new_world_scale = 'import { sampleWorldConditions, sampleWorldWind } from "./world-scale.js";'
assert old_world_scale in text, "world-scale import marker changed"
text = text.replace(old_world_scale, new_world_scale, 1)

old_constant = 'const PATHOGEN_ADJACENT_CONTACT_GAIN = 0.06;'
new_constant = '''const PATHOGEN_ADJACENT_CONTACT_GAIN = 0.06;
// Airflow should shape near-field transmission without making an old save more
// infectious than before. An upwind carrier keeps the legacy adjacent-contact
// gain; other directions lose at most 18% as stronger shared-world wind carries
// aerosols away from the receiving BOT. Same-cell contact is unchanged.
const PATHOGEN_NON_UPWIND_CONTACT_REDUCTION = 0.18;'''
assert old_constant in text, "adjacent contact constant marker changed"
text = text.replace(old_constant, new_constant, 1)

old_contact = '''function localContactExposure(index: PathogenContactIndex, target: Agent): number {
  let exposure = 0;
  const addBucket = (position: GridPosition, gain: number): void => {
    const bucket = index.get(positionKey(position));
    if (bucket === undefined) return;
    for (const source of bucket) {
      if (source.id === target.id) continue;
      exposure = unionPressure(exposure, agentPathogenPressure(source) * gain);
    }
  };

  addBucket(target.position, PATHOGEN_SAME_CELL_CONTACT_GAIN);
  for (const neighbor of hexGridNeighbors(target.position)) {
    addBucket(neighbor, PATHOGEN_ADJACENT_CONTACT_GAIN);
  }
  return exposure;
}
'''
new_contact = '''export function pathogenAdjacentContactGain(
  position: GridPosition,
  sourceDirection: HexGridDirection,
  environment: PathogenEnvironmentFrame | undefined,
): number {
  if (environment === undefined) return PATHOGEN_ADJACENT_CONTACT_GAIN;
  const wind = sampleWorldWind(
    environment.worldSeed,
    environment.originX + position.x,
    environment.originY + position.y,
  );
  const upwindDirection = oppositeHexGridDirection(wind.direction);
  if (sourceDirection === upwindDirection) return PATHOGEN_ADJACENT_CONTACT_GAIN;
  return PATHOGEN_ADJACENT_CONTACT_GAIN *
    (1 - wind.strength * PATHOGEN_NON_UPWIND_CONTACT_REDUCTION);
}

function localContactExposure(
  index: PathogenContactIndex,
  target: Agent,
  environment: PathogenEnvironmentFrame | undefined,
): number {
  let exposure = 0;
  const addBucket = (position: GridPosition, gain: number): void => {
    const bucket = index.get(positionKey(position));
    if (bucket === undefined) return;
    for (const source of bucket) {
      if (source.id === target.id) continue;
      exposure = unionPressure(exposure, agentPathogenPressure(source) * gain);
    }
  };

  addBucket(target.position, PATHOGEN_SAME_CELL_CONTACT_GAIN);
  for (const direction of HEX_GRID_DIRECTIONS) {
    const step = HEX_GRID_DIRECTION_STEPS[direction];
    addBucket(
      { x: target.position.x + step.x, y: target.position.y + step.y },
      pathogenAdjacentContactGain(target.position, direction, environment),
    );
  }
  return exposure;
}
'''
assert old_contact in text, "local contact block changed"
text = text.replace(old_contact, new_contact, 1)

old_map_signature = '''export function pathogenHaloPressureMap(
  links: readonly HexHaloLink[],
  edges: readonly PathogenEdgeSnapshot[],
): Map<string, number> {'''
new_map_signature = '''export function pathogenHaloPressureMap(
  links: readonly HexHaloLink[],
  edges: readonly PathogenEdgeSnapshot[],
  environment?: PathogenEnvironmentFrame,
): Map<string, number> {'''
assert old_map_signature in text, "halo pressure signature changed"
text = text.replace(old_map_signature, new_map_signature, 1)

old_map_write = '''    if (pressure === undefined || pressure <= 0) continue;
    const key = positionKey(link.sourcePosition);
    result.set(key, unionPressure(result.get(key) ?? 0, pressure));
'''
new_map_write = '''    if (pressure === undefined || pressure <= 0) continue;
    const key = positionKey(link.sourcePosition);
    // Keep exact seam behavior aligned with ordinary local adjacency. The map
    // still stores normalized infectious pressure; scaling by the ratio here
    // lets applyPathogenSteps retain its existing adjacent-contact gain while
    // shared-world wind attenuates non-upwind sources identically on both sides
    // of a Durable Object boundary.
    const gainRatio = pathogenAdjacentContactGain(
      link.sourcePosition,
      link.direction,
      environment,
    ) / PATHOGEN_ADJACENT_CONTACT_GAIN;
    result.set(key, unionPressure(result.get(key) ?? 0, pressure * gainRatio));
'''
assert old_map_write in text, "halo pressure write marker changed"
text = text.replace(old_map_write, new_map_write, 1)

old_direct = '    const directContact = localContactExposure(contactIndex, agent);'
new_direct = '    const directContact = localContactExposure(contactIndex, agent, environment);'
assert old_direct in text, "local contact call marker changed"
text = text.replace(old_direct, new_direct, 1)

old_doc = ''' * Same-cell crowding is intentionally a stronger contact than sharing an edge.
 * An exact cross-region halo contact uses the same adjacent-cell gain as an
 * ordinary local six-neighbor contact, so a Durable Object seam does not change
 * transmission strength. Environmental reservoir exposure follows the same hex
'''
new_doc = ''' * Same-cell crowding is intentionally a stronger contact than sharing an edge.
 * Shared-world wind modestly attenuates non-upwind adjacent transmission while
 * preserving the legacy gain for an upwind carrier. Exact cross-region halo
 * contact applies the same directional factor as an ordinary local six-neighbor
 * contact, so a Durable Object seam does not change transmission strength.
 * Environmental reservoir exposure follows the same hex
'''
assert old_doc in text, "pathogen behavior doc marker changed"
text = text.replace(old_doc, new_doc, 1)

pathogen.write_text(text)

region = Path("src/pathogen-region.ts")
text = region.read_text()
old_region = '''    return {
      pressure: pathogenHaloPressureMap(links, edges),
      reservoir: pathogenHaloReservoirMap(links, edges),
    };'''
new_region = '''    return {
      pressure: pathogenHaloPressureMap(links, edges, this.pathogenEnvironmentFrame(state)),
      reservoir: pathogenHaloReservoirMap(links, edges),
    };'''
assert old_region in text, "pathogen region map call changed"
region.write_text(text.replace(old_region, new_region, 1))

Path("tests/pathogen-wind-continuity.test.mjs").write_text(r'''import assert from "node:assert/strict";
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
''')
