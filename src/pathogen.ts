import {
  HEX_GRID_DIRECTIONS,
  HEX_GRID_DIRECTION_STEPS,
  hexGridBoundaryCells,
  hexGridNeighbors,
  isHexGridCell,
  oppositeHexGridDirection,
  type HexGridDirection,
} from "./hex-grid.js";
import type { HexHaloLink } from "./hex-halo.js";
import { positionKey, type Agent, type GridPosition, type Tile, type WorldState } from "./protocol.js";
import { sampleWorldConditions, sampleWorldWind } from "./world-scale.js";

export interface PathogenEnvironmentFrame {
  worldSeed: number;
  originX: number;
  originY: number;
}

export interface PathogenEdgePressure {
  position: GridPosition;
  pressure: number;
}

export interface PathogenEdgeReservoir {
  position: GridPosition;
  burden: number;
}

export interface PathogenEdgeSnapshot {
  regionId: string;
  direction: HexGridDirection;
  revision: number;
  tick: number;
  agents: PathogenEdgePressure[];
  // Optional during rolling deploys so a newer region can still consume an
  // older neighbor snapshot that predates environmental reservoir export.
  reservoirs?: PathogenEdgeReservoir[];
}

type PathogenAgent = Agent & {
  pathogenLoad?: number;
  pathogenImmunity?: number;
};

type PathogenTile = Tile & {
  pathogenReservoir?: number;
};

export const PATHOGEN_LOCAL_INTERVAL = 6;
export const PATHOGEN_HALO_INTERVAL = 30;
const PATHOGEN_BASE_RECOVERY_RATE = 0.06;
const PATHOGEN_RECOVERY_ENERGY_BAND = 0.015;
const PATHOGEN_CLIMATE_PERSISTENCE_GAIN = 0.35;
const PATHOGEN_SAME_CELL_CONTACT_GAIN = 0.11;
const PATHOGEN_ADJACENT_CONTACT_GAIN = 0.06;
// Airflow should shape near-field transmission without making an old save more
// infectious than before. An upwind carrier keeps the legacy adjacent-contact
// gain; other directions lose at most 18% as stronger shared-world wind carries
// aerosols away from the receiving BOT. Same-cell contact is unchanged.
const PATHOGEN_NON_UPWIND_CONTACT_REDUCTION = 0.18;
const PATHOGEN_RESERVOIR_SHEDDING_GAIN = 0.04;
const PATHOGEN_RESERVOIR_EXPOSURE_GAIN = 0.035;
const PATHOGEN_RESERVOIR_ADJACENT_EXPOSURE_GAIN =
  PATHOGEN_RESERVOIR_EXPOSURE_GAIN *
  (PATHOGEN_ADJACENT_CONTACT_GAIN / PATHOGEN_SAME_CELL_CONTACT_GAIN);
const PATHOGEN_RESERVOIR_BASE_CLEARANCE_RATE = 0.18;
const PATHOGEN_RESERVOIR_CLIMATE_PERSISTENCE_GAIN = 0.55;
const PATHOGEN_RESERVOIR_RUNOFF_TRANSPORT_GAIN = 0.08;
export const PATHOGEN_INFECTIOUS_THRESHOLD = 0.12;
const PATHOGEN_SYMPTOM_THRESHOLD = 0.65;
const PATHOGEN_SYMPTOM_ENERGY_COST = 1;
const PATHOGEN_IMMUNITY_GAIN_RATE = 0.04;
const PATHOGEN_IMMUNITY_DECAY_RATE = 0.003;
const PATHOGEN_IMMUNITY_MAX_EFFECT = 0.65;
const PATHOGEN_EPSILON = 1e-4;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function agentPathogenLoad(agent: Agent): number {
  const value = (agent as PathogenAgent).pathogenLoad;
  return typeof value === "number" && Number.isFinite(value) ? clamp01(value) : 0;
}

/**
 * Return the slowly changing protection accumulated by prior pathogen burden.
 *
 * This is an additive optional Agent property rather than a schema migration:
 * old saves and fresh BOTs read as zero, while ordinary state persistence and
 * ownership handoff retain the value once an exposed BOT has acquired it.
 */
export function agentPathogenImmunity(agent: Agent): number {
  const value = (agent as PathogenAgent).pathogenImmunity;
  return typeof value === "number" && Number.isFinite(value) ? clamp01(value) : 0;
}

function pathogenSusceptibility(agent: Agent): number {
  return clamp01(1 - agentPathogenImmunity(agent) * PATHOGEN_IMMUNITY_MAX_EFFECT);
}

/**
 * Convert the existing low-level energy reserve into a modest recovery modifier.
 *
 * A well-fed BOT can clear pathogen burden a little faster while an exhausted
 * BOT recovers a little slower. Keep the range tightly bounded around the old
 * fixed 6% rate (4.5%..7.5%) so food/energy state becomes epidemiologically
 * meaningful without turning disease recovery into a hard threshold or changing
 * persisted schema. At 50 energy the legacy 6% behavior is preserved exactly.
 */
export function pathogenRecoveryRate(agent: Pick<Agent, "energy">): number {
  const energy = clamp01(agent.energy / 100);
  return clamp01(
    PATHOGEN_BASE_RECOVERY_RATE + (energy - 0.5) * PATHOGEN_RECOVERY_ENERGY_BAND * 2,
  );
}

/**
 * Convert internal pathogen burden into transmissible pressure.
 *
 * Very small loads are useful as latent ecological state, but treating every
 * non-zero value as fully infectious makes tiny residual burdens seed immediate
 * person-to-person and cross-DO spread. Keep burden continuous while requiring a
 * modest subclinical buildup before shedding begins. Infectiousness then rises
 * smoothly to 1, well before the separate symptom threshold, so asymptomatic
 * transmission still exists.
 */
export function agentPathogenPressure(agent: Agent): number {
  // Direct contact and active shedding require a living host. Keep any tile
  // reservoir already left behind by the carrier; corpse/environmental
  // persistence, if modeled later, must be an explicit low-level reservoir path
  // rather than a dead Agent continuing to breathe across local or halo contact.
  if (agent.hp <= 0) return 0;
  const load = agentPathogenLoad(agent);
  if (load <= PATHOGEN_INFECTIOUS_THRESHOLD) return 0;
  return clamp01(
    (load - PATHOGEN_INFECTIOUS_THRESHOLD) / (1 - PATHOGEN_INFECTIOUS_THRESHOLD),
  );
}

function unionPressure(current: number, incoming: number): number {
  return clamp01(1 - (1 - clamp01(current)) * (1 - clamp01(incoming)));
}

/**
 * Count cadence boundaries crossed while a region advances from one persisted
 * tick to another. This keeps slow ecological dynamics compatible with virtual
 * catch-up: a 60-tick cold-region catch-up still receives ten 6-tick pathogen
 * updates rather than one wall-clock update.
 */
export function pathogenStepCount(fromTick: number, toTick: number, interval: number): number {
  if (!Number.isInteger(interval) || interval <= 0 || toTick <= fromTick) return 0;
  return Math.max(0, Math.floor(toTick / interval) - Math.floor(fromTick / interval));
}

/**
 * Derive how strongly the shared low-level climate preserves an existing
 * pathogen burden. Damp, moderately warm cells slow clearance a little, while
 * dry or thermally hostile cells leave recovery unchanged.
 *
 * This is deliberately persistence, not spontaneous exposure: climate alone
 * must never create pathogen mass from zero. New burden still requires an
 * existing carrier through local six-neighbor contact or the exact hex halo.
 */
export function pathogenClimatePersistence(
  position: GridPosition,
  environment: PathogenEnvironmentFrame | undefined,
): number {
  if (environment === undefined) return 0;
  const conditions = sampleWorldConditions(
    environment.worldSeed,
    environment.originX + position.x,
    environment.originY + position.y,
  );
  const dampness = clamp01((conditions.wetness - 0.42) / 0.48);
  const thermalSuitability = clamp01(1 - Math.abs(conditions.temperature - 0.62) / 0.42);
  return dampness * thermalSuitability;
}

/**
 * Read the low-level environmental burden persisted on a hex tile.
 *
 * The field is optional so existing saves remain valid. A value is only created
 * by shedding from an infectious carrier; climate may preserve that burden but
 * cannot create it from an uncontaminated tile.
 */
export function tilePathogenReservoir(tile: Tile): number {
  const value = (tile as PathogenTile).pathogenReservoir;
  return typeof value === "number" && Number.isFinite(value) ? clamp01(value) : 0;
}

function pathogenReservoirIndex(tiles: readonly Tile[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const tile of tiles) {
    const load = tilePathogenReservoir(tile);
    if (load > PATHOGEN_EPSILON) {
      result.set(positionKey(tile), load);
    }
  }
  return result;
}

/**
 * Move a small, bounded share of existing environmental burden along the local
 * hydrology graph before clearance/shedding are applied.
 *
 * `flowTo` and `drainage` are already derived from the six-neighbor elevation
 * field, so this couples infection ecology to the same low-level water routing
 * without inventing a river/pathogen category. Only targets owned by this local
 * state are eligible: cross-DO flow ownership is still a separate Issue #3 step,
 * and an unresolved boundary outlet must not teleport contamination or mutate a
 * neighbor.
 *
 * All transfer requests are planned from the immutable pre-step reservoir. When
 * several upstream cells converge on a nearly full downstream cell, they share
 * the remaining capacity proportionally rather than letting tile iteration order
 * decide who arrives first. Applying the accumulated in/out deltas together also
 * guarantees newly arrived burden cannot travel a second hydrology edge in the
 * same pathogen step. The accepted transfer is subtracted exactly from its
 * sources, so advection alone neither creates nor destroys reservoir burden.
 */
function advectPathogenReservoirs(
  tilesByPosition: ReadonlyMap<string, Tile>,
  previousReservoir: ReadonlyMap<string, number>,
): Map<string, number> {
  const requests: Array<{ sourceKey: string; targetKey: string; amount: number }> = [];
  const requestedByTarget = new Map<string, number>();

  for (const [sourceKey, current] of previousReservoir) {
    if (current <= PATHOGEN_EPSILON) continue;
    const tile = tilesByPosition.get(sourceKey);
    const targetPosition = tile?.flowTo;
    if (tile === undefined || targetPosition === undefined) continue;
    const targetKey = positionKey(targetPosition);
    if (targetKey === sourceKey || !tilesByPosition.has(targetKey)) continue;
    const drainage = Number.isFinite(tile.drainage ?? Number.NaN)
      ? clamp01(tile.drainage ?? 0)
      : 0;
    if (drainage <= 0) continue;

    const amount = current * drainage * PATHOGEN_RESERVOIR_RUNOFF_TRANSPORT_GAIN;
    if (amount <= PATHOGEN_EPSILON) continue;
    requests.push({ sourceKey, targetKey, amount });
    requestedByTarget.set(targetKey, (requestedByTarget.get(targetKey) ?? 0) + amount);
  }

  const acceptedScaleByTarget = new Map<string, number>();
  for (const [targetKey, requested] of requestedByTarget) {
    const targetCurrent = previousReservoir.get(targetKey) ?? 0;
    const capacity = Math.max(0, 1 - targetCurrent);
    acceptedScaleByTarget.set(
      targetKey,
      requested > 0 ? Math.min(1, capacity / requested) : 0,
    );
  }

  const outbound = new Map<string, number>();
  const inbound = new Map<string, number>();
  for (const request of requests) {
    const transferred = request.amount * (acceptedScaleByTarget.get(request.targetKey) ?? 0);
    if (transferred <= PATHOGEN_EPSILON) continue;
    outbound.set(request.sourceKey, (outbound.get(request.sourceKey) ?? 0) + transferred);
    inbound.set(request.targetKey, (inbound.get(request.targetKey) ?? 0) + transferred);
  }

  const advected = new Map(previousReservoir);
  const changedKeys = new Set([...outbound.keys(), ...inbound.keys()]);
  for (const key of changedKeys) {
    advected.set(
      key,
      (previousReservoir.get(key) ?? 0) - (outbound.get(key) ?? 0) + (inbound.get(key) ?? 0),
    );
  }
  return advected;
}

function localReservoirExposure(
  reservoir: ReadonlyMap<string, number>,
  position: GridPosition,
): number {
  let exposure = (reservoir.get(positionKey(position)) ?? 0) * PATHOGEN_RESERVOIR_EXPOSURE_GAIN;
  for (const neighbor of hexGridNeighbors(position)) {
    const burden = reservoir.get(positionKey(neighbor)) ?? 0;
    exposure = unionPressure(
      exposure,
      burden * PATHOGEN_RESERVOIR_ADJACENT_EXPOSURE_GAIN,
    );
  }
  return exposure;
}

/**
 * Advance environmental contamination after agent exposure has been evaluated.
 *
 * Sources are the immutable pre-step carriers, so a BOT cannot contaminate a
 * tile and infect another BOT through that reservoir in the same pathogen step.
 * This gives the reservoir a real temporal path: carrier -> tile -> later BOT.
 */
function advancePathogenReservoirs(
  tiles: readonly Tile[],
  previousAgents: readonly Agent[],
  environment: PathogenEnvironmentFrame | undefined,
  previousReservoir: ReadonlyMap<string, number>,
): number {
  if (tiles.length === 0) return 0;

  const tilesByPosition = new Map(tiles.map((tile) => [positionKey(tile), tile]));
  const advectedReservoir = advectPathogenReservoirs(tilesByPosition, previousReservoir);
  const shedding = new Map<string, number>();
  for (const source of previousAgents) {
    const pressure = agentPathogenPressure(source);
    if (pressure <= PATHOGEN_EPSILON) continue;
    const key = positionKey(source.position);
    shedding.set(
      key,
      unionPressure(shedding.get(key) ?? 0, pressure * PATHOGEN_RESERVOIR_SHEDDING_GAIN),
    );
  }

  const keys = new Set([...advectedReservoir.keys(), ...shedding.keys()]);
  let changed = 0;
  for (const key of keys) {
    const tile = tilesByPosition.get(key);
    if (tile === undefined) continue;
    const current = advectedReservoir.get(key) ?? 0;
    const persistence = pathogenClimatePersistence(tile, environment);
    const clearanceRate = PATHOGEN_RESERVOIR_BASE_CLEARANCE_RATE *
      (1 - persistence * PATHOGEN_RESERVOIR_CLIMATE_PERSISTENCE_GAIN);
    const residual = clamp01(current * (1 - clearanceRate));
    const next = unionPressure(residual, shedding.get(key) ?? 0);

    const target = tile as PathogenTile;
    if (next <= PATHOGEN_EPSILON) {
      if (target.pathogenReservoir !== undefined) {
        delete target.pathogenReservoir;
        changed += 1;
      }
    } else if (Math.abs(next - tilePathogenReservoir(tile)) > PATHOGEN_EPSILON) {
      target.pathogenReservoir = next;
      changed += 1;
    }
  }
  return changed;
}

type PathogenContactIndex = ReadonlyMap<string, readonly Agent[]>;

/**
 * Bucket the immutable pre-step population by logical hex. Pathogen contact is
 * local by definition (same cell or one of six neighbors), so scanning every BOT
 * for every target needlessly turns a contact step into O(N²) work as population
 * grows. The index keeps the exact same contact geometry while making the common
 * sparse case proportional to population plus the agents in seven nearby cells.
 */
function buildPathogenContactIndex(agents: readonly Agent[]): PathogenContactIndex {
  const mutable = new Map<string, Agent[]>();
  for (const agent of agents) {
    const key = positionKey(agent.position);
    const bucket = mutable.get(key);
    if (bucket === undefined) {
      mutable.set(key, [agent]);
    } else {
      bucket.push(agent);
    }
  }
  return mutable;
}

export function pathogenAdjacentContactGain(
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

/**
 * Aggregate infectious pressure and environmental burden on one macro-hex edge.
 * Multiple BOTs may share a cell, so combine them as a bounded union rather than
 * adding pressure above 1. Latent/subclinical BOT burden is intentionally not
 * exported, while an already contaminated boundary tile remains observable even
 * after its carrier leaves.
 */
export function pathogenEdgeSnapshot(
  state: Pick<
    WorldState,
    "regionId" | "revision" | "tick" | "width" | "height" | "agents" | "tiles"
  >,
  direction: HexGridDirection,
): PathogenEdgeSnapshot {
  const boundary = new Set(
    hexGridBoundaryCells(state, direction).map((position) => positionKey(position)),
  );
  const pressure = new Map<string, PathogenEdgePressure>();
  for (const agent of state.agents) {
    const key = positionKey(agent.position);
    if (!boundary.has(key)) continue;
    const infectiousPressure = agentPathogenPressure(agent);
    if (infectiousPressure <= PATHOGEN_EPSILON) continue;
    const current = pressure.get(key);
    pressure.set(key, {
      position: { ...agent.position },
      pressure: unionPressure(current?.pressure ?? 0, infectiousPressure),
    });
  }
  const reservoirs: PathogenEdgeReservoir[] = [];
  for (const tile of state.tiles ?? []) {
    if (!boundary.has(positionKey(tile))) continue;
    const burden = tilePathogenReservoir(tile);
    if (burden <= PATHOGEN_EPSILON) continue;
    reservoirs.push({ position: { x: tile.x, y: tile.y }, burden });
  }
  reservoirs.sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
  return {
    regionId: state.regionId,
    direction,
    revision: state.revision,
    tick: state.tick,
    agents: [...pressure.values()].sort((a, b) =>
      a.position.y - b.position.y || a.position.x - b.position.x
    ),
    reservoirs,
  };
}

/**
 * Map neighboring edge pressure onto the exact local source cell selected by
 * the existing depth-1 halo ownership links. The geometry/ownership contract is
 * therefore shared with water, vegetation and autonomous supply scouting.
 */
interface MaterializedPathogenHaloMaps {
  // Preserve raw maps for helper compatibility while runtime also receives
  // already-composed exposure. A macro-hex corner can touch two remote
  // regions, so each ghost adjacency must apply its own gain before union.
  pressure: Map<string, number>;
  reservoir: Map<string, number>;
  pressureExposure: Map<string, number>;
  reservoirExposure: Map<string, number>;
}

function pathogenHaloRemoteKey(
  regionId: string,
  direction: HexGridDirection,
  position: GridPosition,
): string {
  return `${regionId}:${direction}:${positionKey(position)}`;
}

function materializePathogenHaloMaps(
  links: readonly HexHaloLink[],
  edges: readonly PathogenEdgeSnapshot[],
  environment: PathogenEnvironmentFrame | undefined,
  includePressure: boolean,
  includeReservoir: boolean,
): MaterializedPathogenHaloMaps {
  const pressureIndex = new Map<string, number>();
  const reservoirIndex = new Map<string, number>();
  for (const edge of edges) {
    if (includePressure) {
      for (const entry of edge.agents) {
        pressureIndex.set(
          pathogenHaloRemoteKey(edge.regionId, edge.direction, entry.position),
          clamp01(entry.pressure),
        );
      }
    }
    if (includeReservoir) {
      for (const entry of edge.reservoirs ?? []) {
        reservoirIndex.set(
          pathogenHaloRemoteKey(edge.regionId, edge.direction, entry.position),
          clamp01(entry.burden),
        );
      }
    }
  }

  const pressure = new Map<string, number>();
  const reservoir = new Map<string, number>();
  const pressureExposure = new Map<string, number>();
  const reservoirExposure = new Map<string, number>();
  for (const link of links) {
    const remoteKey = pathogenHaloRemoteKey(
      link.neighborRegionId,
      link.neighborDirection,
      link.neighborPosition,
    );
    const localKey = positionKey(link.sourcePosition);
    if (includePressure) {
      const remotePressure = pressureIndex.get(remoteKey);
      if (remotePressure !== undefined && remotePressure > 0) {
        // Preserve the historical raw-map value while composing true exposure
        // independently for every ghost adjacency at macro-hex corners.
        const gain = pathogenAdjacentContactGain(
          link.sourcePosition,
          link.direction,
          environment,
        );
        const gainRatio = gain / PATHOGEN_ADJACENT_CONTACT_GAIN;
        pressure.set(
          localKey,
          unionPressure(pressure.get(localKey) ?? 0, remotePressure * gainRatio),
        );
        pressureExposure.set(
          localKey,
          unionPressure(pressureExposure.get(localKey) ?? 0, remotePressure * gain),
        );
      }
    }
    if (includeReservoir) {
      const burden = reservoirIndex.get(remoteKey);
      if (burden !== undefined && burden > 0) {
        reservoir.set(
          localKey,
          unionPressure(reservoir.get(localKey) ?? 0, burden),
        );
        reservoirExposure.set(
          localKey,
          unionPressure(
            reservoirExposure.get(localKey) ?? 0,
            burden * PATHOGEN_RESERVOIR_ADJACENT_EXPOSURE_GAIN,
          ),
        );
      }
    }
  }
  return { pressure, reservoir, pressureExposure, reservoirExposure };
}

/**
 * Materialize both cross-seam carrier pressure and environmental burden
 * in one pass. Runtime pathogen alarms need both maps together, so sharing
 * the remote-key lookup and halo-link traversal avoids repeating the same
 * geometry/string-index work on every cross-region pathogen step.
 */
export function pathogenHaloMaps(
  links: readonly HexHaloLink[],
  edges: readonly PathogenEdgeSnapshot[],
  environment?: PathogenEnvironmentFrame,
): MaterializedPathogenHaloMaps {
  return materializePathogenHaloMaps(links, edges, environment, true, true);
}

export function pathogenHaloPressureMap(
  links: readonly HexHaloLink[],
  edges: readonly PathogenEdgeSnapshot[],
  environment?: PathogenEnvironmentFrame,
): Map<string, number> {
  return materializePathogenHaloMaps(links, edges, environment, true, false).pressure;
}

/**
 * Materialize environmental burden from the exact ghost cells paired with local
 * boundary cells. This is read-only: the neighbor keeps ownership of its tile
 * reservoir, while the local region receives only a transient exposure input.
 */
export function pathogenHaloReservoirMap(
  links: readonly HexHaloLink[],
  edges: readonly PathogenEdgeSnapshot[],
): Map<string, number> {
  return materializePathogenHaloMaps(links, edges, undefined, false, true).reservoir;
}

function singlePathogenStep(
  state: WorldState,
  environment: PathogenEnvironmentFrame | undefined,
): number {
  const allTiles = state.tiles ?? [];
  // WorldState still persists the historical 40x24 compatibility envelope, but
  // only the regular axial hex is simulation-owned terrain. Ignore compatibility
  // cells here so a hidden reservoir cannot infect an active boundary BOT or
  // advect back into the playable world. Partial unit fixtures without an extent
  // retain their legacy behavior for focused pathogen math tests.
  const hasHexExtent =
    Number.isInteger(state.width) && state.width > 0 &&
    Number.isInteger(state.height) && state.height > 0;
  const tiles = hasHexExtent
    ? allTiles.filter((tile) => isHexGridCell(state, tile))
    : allTiles;
  const previousReservoir = pathogenReservoirIndex(tiles);
  const previousLoads = new Map(state.agents.map((agent) => [agent.id, agentPathogenLoad(agent)]));
  const previousImmunity = new Map(
    state.agents.map((agent) => [agent.id, agentPathogenImmunity(agent)]),
  );
  // Contact must use the pre-step loads, immunity and reservoir for every BOT.
  // Otherwise array order can create an artificial within-tick infection chain.
  const previousState = {
    agents: state.agents.map((agent) => ({
      ...agent,
      pathogenLoad: previousLoads.get(agent.id) ?? 0,
      pathogenImmunity: previousImmunity.get(agent.id) ?? 0,
    })) as Agent[],
  };
  const previousAgentsById = new Map(previousState.agents.map((agent) => [agent.id, agent]));
  const contactIndex = buildPathogenContactIndex(previousState.agents);
  let changed = 0;

  for (const agent of state.agents) {
    const current = previousLoads.get(agent.id) ?? 0;
    const currentImmunity = previousImmunity.get(agent.id) ?? 0;
    const climatePersistence = pathogenClimatePersistence(agent.position, environment);
    // Death is a single epidemiological gate: a corpse can retain/decay burden
    // already present in persistent state, but it cannot acquire fresh burden from
    // nearby hosts or contaminated ground after hp reaches zero.
    const isAlive = agent.hp > 0;
    const directContact = isAlive ? localContactExposure(contactIndex, agent, environment) : 0;
    const environmentalExposure = isAlive
      ? localReservoirExposure(previousReservoir, agent.position)
      : 0;
    const contact = unionPressure(directContact, environmentalExposure) *
      clamp01(1 - currentImmunity * PATHOGEN_IMMUNITY_MAX_EFFECT);
    // Climate controls survival/clearance of existing burden rather than acting
    // as a source term. New burden comes from another carrier directly or from a
    // tile that an earlier infectious carrier contaminated.
    const recoveryRate = pathogenRecoveryRate(agent) *
      (1 - climatePersistence * PATHOGEN_CLIMATE_PERSISTENCE_GAIN);
    const next = clamp01(current * (1 - recoveryRate) + (1 - current) * contact);
    const target = agent as PathogenAgent;
    if (next <= PATHOGEN_EPSILON) {
      if (target.pathogenLoad !== undefined) {
        delete target.pathogenLoad;
        changed += 1;
      }
    } else if (Math.abs(next - current) > PATHOGEN_EPSILON) {
      target.pathogenLoad = next;
      changed += 1;
    }

    // Prior infectious burden leaves a gradually acquired, gradually waning
    // protection. This creates history-dependent epidemics from low-level agent
    // state without a permanent immune flag or a new WorldState schema version.
    const infectiousStimulus = agentPathogenPressure(previousAgentsById.get(agent.id) ?? agent);
    const nextImmunity = infectiousStimulus > 0
      ? clamp01(
        currentImmunity +
          (1 - currentImmunity) * PATHOGEN_IMMUNITY_GAIN_RATE * infectiousStimulus,
      )
      : clamp01(currentImmunity * (1 - PATHOGEN_IMMUNITY_DECAY_RATE));
    if (nextImmunity <= PATHOGEN_EPSILON) {
      if (target.pathogenImmunity !== undefined) {
        delete target.pathogenImmunity;
        changed += 1;
      }
    } else if (Math.abs(nextImmunity - currentImmunity) > PATHOGEN_EPSILON) {
      target.pathogenImmunity = nextImmunity;
      changed += 1;
    }

    if (isAlive && next >= PATHOGEN_SYMPTOM_THRESHOLD && agent.energy > 0) {
      agent.energy = Math.max(0, agent.energy - PATHOGEN_SYMPTOM_ENERGY_COST);
      changed += 1;
    }
  }

  // Reservoir mutation intentionally happens after all BOT exposure calculations,
  // so newly shed or advected burden cannot shortcut the one-step environmental
  // path. Hydrology therefore moves contamination for the next pathogen step.
  changed += advancePathogenReservoirs(
    tiles,
    previousState.agents,
    environment,
    previousReservoir,
  );
  return changed;
}

/**
 * Advance the pathogen layer using only additive optional state.
 * `pathogenLoad` / `pathogenImmunity` live on Agent and `pathogenReservoir`
 * lives on Tile. Old saves read all three as zero/absent, while ordinary
 * structured-clone persistence retains them once they appear. Local contact is
 * six-neighbor hex contact; halo exposure is applied only at exact boundary
 * cells on its slower cadence.
 *
 * Same-cell crowding is intentionally a stronger contact than sharing an edge.
 * Shared-world wind modestly attenuates non-upwind adjacent transmission while
 * preserving the legacy gain for an upwind carrier. Exact cross-region halo
 * contact applies the same directional factor as an ordinary local six-neighbor
 * contact, so a Durable Object seam does not change transmission strength.
 * Environmental reservoir exposure follows the same hex
 * geometry: same-cell burden is strongest, immediate six-neighbor burden is
 * weaker, and a ghost-cell burden across a DO seam uses that exact adjacent
 * strength without copying or mutating the remote tile. Existing local `flowTo`
 * and drainage also advect a small conserved share of environmental burden one
 * hydrology edge per pathogen step; unresolved cross-DO outlets remain inert
 * until catchment ownership itself becomes continuous. Climate only changes
 * persistence of existing burden; it cannot create infection without a carrier.
 * Recovery is also coupled conservatively to the existing energy reserve. Prior
 * infectious burden builds bounded, slowly waning protection that reduces direct,
 * environmental and halo exposure. Dead Agents neither shed nor acquire new
 * contact/reservoir burden; any burden already present only decays.
 */
export function applyPathogenSteps(
  state: WorldState,
  localSteps: number,
  environment?: PathogenEnvironmentFrame,
  haloPressure: ReadonlyMap<string, number> = new Map(),
  haloSteps = 0,
  haloReservoir: ReadonlyMap<string, number> = new Map(),
  haloPressureExposure?: ReadonlyMap<string, number>,
  haloReservoirExposure?: ReadonlyMap<string, number>,
): number {
  const safeLocalSteps = Math.max(0, Math.min(64, Math.floor(localSteps)));
  const safeHaloSteps = Math.max(0, Math.min(16, Math.floor(haloSteps)));
  let changed = 0;
  for (let step = 0; step < safeLocalSteps; step += 1) {
    changed += singlePathogenStep(state, environment);
  }

  if (
    safeHaloSteps <= 0 ||
    (
      haloPressure.size === 0 &&
      haloReservoir.size === 0 &&
      (haloPressureExposure?.size ?? 0) === 0 &&
      (haloReservoirExposure?.size ?? 0) === 0
    )
  ) return changed;
  for (const agent of state.agents) {
    // A living BOT sharing the same boundary cell may legitimately trigger the
    // edge fetch, but a co-located corpse still must not absorb that halo burden.
    if (agent.hp <= 0) continue;
    const key = positionKey(agent.position);
    const pressure = haloPressure.get(key) ?? 0;
    const reservoirBurden = haloReservoir.get(key) ?? 0;
    const carrierExposure = haloPressureExposure === undefined
      ? pressure * PATHOGEN_ADJACENT_CONTACT_GAIN
      : haloPressureExposure.get(key) ?? 0;
    const environmentalExposure = haloReservoirExposure === undefined
      ? reservoirBurden * PATHOGEN_RESERVOIR_ADJACENT_EXPOSURE_GAIN
      : haloReservoirExposure.get(key) ?? 0;
    if (carrierExposure <= 0 && environmentalExposure <= 0) continue;
    const rawExposure = unionPressure(carrierExposure, environmentalExposure);
    const perExposure = clamp01(rawExposure * pathogenSusceptibility(agent));
    const combinedExposure = 1 - Math.pow(1 - perExposure, safeHaloSteps);
    const current = agentPathogenLoad(agent);
    const next = clamp01(current + (1 - current) * combinedExposure);
    if (next - current <= PATHOGEN_EPSILON) continue;
    (agent as PathogenAgent).pathogenLoad = next;
    changed += 1;
  }
  return changed;
}

/**
 * Replay pathogen cadence boundaries in chronological order across a virtual
 * catch-up range. A normal real-time tick that reaches both cadence boundaries
 * runs local progression before halo exposure; catch-up must preserve that same
 * ordering instead of applying every local recovery first and all halo exposure
 * afterwards.
 *
 * The remote halo snapshot is intentionally still one bounded observation for
 * the alarm batch. This function only fixes temporal ordering of that observation
 * relative to local recovery/shedding, without inventing historical neighbor
 * state or changing persisted schema.
 */
export function applyPathogenTickRange(
  state: WorldState,
  fromTick: number,
  toTick: number,
  environment?: PathogenEnvironmentFrame,
  haloPressure: ReadonlyMap<string, number> = new Map(),
  haloReservoir: ReadonlyMap<string, number> = new Map(),
  haloPressureExposure?: ReadonlyMap<string, number>,
  haloReservoirExposure?: ReadonlyMap<string, number>,
): number {
  const start = Math.floor(fromTick);
  const end = Math.floor(toTick);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;

  let localRemaining = Math.min(
    64,
    pathogenStepCount(start, end, PATHOGEN_LOCAL_INTERVAL),
  );
  let haloRemaining = Math.min(
    16,
    pathogenStepCount(start, end, PATHOGEN_HALO_INTERVAL),
  );
  let nextLocal = (Math.floor(start / PATHOGEN_LOCAL_INTERVAL) + 1) *
    PATHOGEN_LOCAL_INTERVAL;
  let nextHalo = (Math.floor(start / PATHOGEN_HALO_INTERVAL) + 1) *
    PATHOGEN_HALO_INTERVAL;
  let changed = 0;

  while (localRemaining > 0 || haloRemaining > 0) {
    const boundary = Math.min(
      localRemaining > 0 ? nextLocal : Number.POSITIVE_INFINITY,
      haloRemaining > 0 ? nextHalo : Number.POSITIVE_INFINITY,
    );
    if (!Number.isFinite(boundary) || boundary > end) break;

    if (localRemaining > 0 && nextLocal === boundary) {
      changed += applyPathogenSteps(state, 1, environment);
      localRemaining -= 1;
      nextLocal += PATHOGEN_LOCAL_INTERVAL;
    }
    if (haloRemaining > 0 && nextHalo === boundary) {
      changed += applyPathogenSteps(
        state,
        0,
        environment,
        haloPressure,
        1,
        haloReservoir,
        haloPressureExposure,
        haloReservoirExposure,
      );
      haloRemaining -= 1;
      nextHalo += PATHOGEN_HALO_INTERVAL;
    }
  }
  return changed;
}

