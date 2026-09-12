import { hexGridBoundaryCells, hexGridDistance, type HexGridDirection } from "./hex-grid.js";
import type { HexHaloLink } from "./hex-halo.js";
import { positionKey, type Agent, type GridPosition, type WorldState } from "./protocol.js";
import { sampleWorldConditions } from "./world-scale.js";

export interface PathogenEnvironmentFrame {
  worldSeed: number;
  originX: number;
  originY: number;
}

export interface PathogenEdgePressure {
  position: GridPosition;
  pressure: number;
}

export interface PathogenEdgeSnapshot {
  regionId: string;
  direction: HexGridDirection;
  revision: number;
  tick: number;
  agents: PathogenEdgePressure[];
}

type PathogenAgent = Agent & {
  pathogenLoad?: number;
  pathogenImmunity?: number;
};

export const PATHOGEN_LOCAL_INTERVAL = 6;
export const PATHOGEN_HALO_INTERVAL = 30;
const PATHOGEN_BASE_RECOVERY_RATE = 0.06;
const PATHOGEN_RECOVERY_ENERGY_BAND = 0.015;
const PATHOGEN_CLIMATE_PERSISTENCE_GAIN = 0.35;
const PATHOGEN_SAME_CELL_CONTACT_GAIN = 0.11;
const PATHOGEN_ADJACENT_CONTACT_GAIN = 0.06;
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

function localContactExposure(state: Pick<WorldState, "agents">, target: Agent): number {
  let exposure = 0;
  for (const source of state.agents) {
    if (source.id === target.id) continue;
    const distance = hexGridDistance(source.position, target.position);
    if (distance > 1) continue;
    const gain = distance === 0
      ? PATHOGEN_SAME_CELL_CONTACT_GAIN
      : PATHOGEN_ADJACENT_CONTACT_GAIN;
    exposure = unionPressure(exposure, agentPathogenPressure(source) * gain);
  }
  return exposure;
}

/**
 * Aggregate infectious pressure on one macro-hex edge. Multiple BOTs may share
 * a cell, so combine them as a bounded union rather than adding pressure above
 * 1. Latent/subclinical burden is intentionally not exported across the seam.
 */
export function pathogenEdgeSnapshot(
  state: Pick<WorldState, "regionId" | "revision" | "tick" | "width" | "height" | "agents">,
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
  return {
    regionId: state.regionId,
    direction,
    revision: state.revision,
    tick: state.tick,
    agents: [...pressure.values()].sort((a, b) =>
      a.position.y - b.position.y || a.position.x - b.position.x
    ),
  };
}

/**
 * Map neighboring edge pressure onto the exact local source cell selected by
 * the existing depth-1 halo ownership links. The geometry/ownership contract is
 * therefore shared with water, vegetation and autonomous supply scouting.
 */
export function pathogenHaloPressureMap(
  links: readonly HexHaloLink[],
  edges: readonly PathogenEdgeSnapshot[],
): Map<string, number> {
  const index = new Map<string, number>();
  for (const edge of edges) {
    for (const entry of edge.agents) {
      index.set(
        `${edge.regionId}:${edge.direction}:${positionKey(entry.position)}`,
        clamp01(entry.pressure),
      );
    }
  }

  const result = new Map<string, number>();
  for (const link of links) {
    const pressure = index.get(
      `${link.neighborRegionId}:${link.neighborDirection}:${positionKey(link.neighborPosition)}`,
    );
    if (pressure === undefined || pressure <= 0) continue;
    const key = positionKey(link.sourcePosition);
    result.set(key, unionPressure(result.get(key) ?? 0, pressure));
  }
  return result;
}

function singlePathogenStep(
  state: WorldState,
  environment: PathogenEnvironmentFrame | undefined,
): number {
  if (state.agents.length === 0) return 0;
  const previousLoads = new Map(state.agents.map((agent) => [agent.id, agentPathogenLoad(agent)]));
  const previousImmunity = new Map(
    state.agents.map((agent) => [agent.id, agentPathogenImmunity(agent)]),
  );
  // Contact must use the pre-step loads and immunity for every BOT. Otherwise
  // array order can create an artificial within-tick infection or immunity chain.
  const previousState = {
    agents: state.agents.map((agent) => ({
      ...agent,
      pathogenLoad: previousLoads.get(agent.id) ?? 0,
      pathogenImmunity: previousImmunity.get(agent.id) ?? 0,
    })) as Agent[],
  };
  let changed = 0;

  for (const agent of state.agents) {
    const current = previousLoads.get(agent.id) ?? 0;
    const currentImmunity = previousImmunity.get(agent.id) ?? 0;
    const climatePersistence = pathogenClimatePersistence(agent.position, environment);
    const contact = localContactExposure(previousState, agent) *
      clamp01(1 - currentImmunity * PATHOGEN_IMMUNITY_MAX_EFFECT);
    // Climate controls survival/clearance of existing burden rather than acting
    // as a source term. That keeps pathogen mass causally attached to carriers
    // until a future explicit environmental reservoir is modeled.
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
    const infectiousStimulus = agentPathogenPressure(previousState.agents.find(
      (candidate) => candidate.id === agent.id,
    ) ?? agent);
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

    if (next >= PATHOGEN_SYMPTOM_THRESHOLD && agent.energy > 0) {
      agent.energy = Math.max(0, agent.energy - PATHOGEN_SYMPTOM_ENERGY_COST);
      changed += 1;
    }
  }
  return changed;
}

/**
 * Advance the pathogen layer without adding another persisted world object.
 * `pathogenLoad` and `pathogenImmunity` are optional additive Agent properties:
 * old saves read them as 0, ordinary structured-clone persistence and agent
 * handoff retain them, and fresh agents start susceptible. Local contact is
 * six-neighbor hex contact; halo exposure is applied only at exact boundary
 * cells on its slower cadence.
 *
 * Same-cell crowding is intentionally a stronger contact than sharing an edge.
 * An exact cross-region halo contact uses the same adjacent-cell gain as an
 * ordinary local six-neighbor contact, so a Durable Object seam does not change
 * transmission strength. Climate only changes persistence of existing burden;
 * it cannot create infection without a carrier. Recovery is also coupled
 * conservatively to the existing energy reserve. Prior infectious burden builds
 * bounded, slowly waning protection that reduces both local and halo exposure,
 * giving repeated outbreaks population memory without a permanent immunity bit.
 */
export function applyPathogenSteps(
  state: WorldState,
  localSteps: number,
  environment?: PathogenEnvironmentFrame,
  haloPressure: ReadonlyMap<string, number> = new Map(),
  haloSteps = 0,
): number {
  const safeLocalSteps = Math.max(0, Math.min(64, Math.floor(localSteps)));
  const safeHaloSteps = Math.max(0, Math.min(16, Math.floor(haloSteps)));
  let changed = 0;
  for (let step = 0; step < safeLocalSteps; step += 1) {
    changed += singlePathogenStep(state, environment);
  }

  if (safeHaloSteps <= 0 || haloPressure.size === 0) return changed;
  for (const agent of state.agents) {
    const pressure = haloPressure.get(positionKey(agent.position)) ?? 0;
    if (pressure <= 0) continue;
    const current = agentPathogenLoad(agent);
    const perExposure = clamp01(
      pressure * PATHOGEN_ADJACENT_CONTACT_GAIN * pathogenSusceptibility(agent),
    );
    const combinedExposure = 1 - Math.pow(1 - perExposure, safeHaloSteps);
    const next = clamp01(current + (1 - current) * combinedExposure);
    if (next - current <= PATHOGEN_EPSILON) continue;
    (agent as PathogenAgent).pathogenLoad = next;
    changed += 1;
  }
  return changed;
}
