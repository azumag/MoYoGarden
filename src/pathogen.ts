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

type PathogenAgent = Agent & { pathogenLoad?: number };

export const PATHOGEN_LOCAL_INTERVAL = 6;
export const PATHOGEN_HALO_INTERVAL = 30;
const PATHOGEN_RECOVERY_RATE = 0.06;
const PATHOGEN_AMBIENT_GAIN = 0.012;
const PATHOGEN_CONTACT_GAIN = 0.11;
const PATHOGEN_HALO_GAIN = 0.10;
const PATHOGEN_SYMPTOM_THRESHOLD = 0.65;
const PATHOGEN_SYMPTOM_ENERGY_COST = 1;
const PATHOGEN_EPSILON = 1e-4;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function agentPathogenLoad(agent: Agent): number {
  const value = (agent as PathogenAgent).pathogenLoad;
  return typeof value === "number" && Number.isFinite(value) ? clamp01(value) : 0;
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

function ambientPathogenPressure(
  position: GridPosition,
  environment: PathogenEnvironmentFrame | undefined,
): number {
  if (environment === undefined) return 0;
  const conditions = sampleWorldConditions(
    environment.worldSeed,
    environment.originX + position.x,
    environment.originY + position.y,
  );
  // Pathogen persistence emerges from the same continuous low-level climate as
  // vegetation: damp, moderately warm cells support more environmental load,
  // while dry, very hot or very cold cells suppress it. This is a pressure, not
  // a biome/event switch, and ambient exposure alone stays sub-symptomatic.
  const dampness = clamp01((conditions.wetness - 0.42) / 0.48);
  const thermalSuitability = clamp01(1 - Math.abs(conditions.temperature - 0.62) / 0.42);
  return dampness * thermalSuitability;
}

function localContactPressure(state: Pick<WorldState, "agents">, target: Agent): number {
  let pressure = 0;
  for (const source of state.agents) {
    if (source.id === target.id || hexGridDistance(source.position, target.position) > 1) continue;
    pressure = unionPressure(pressure, agentPathogenLoad(source));
  }
  return pressure;
}

/**
 * Aggregate infectious pressure on one macro-hex edge. Multiple BOTs may share
 * a cell, so combine them as a bounded union rather than adding load above 1.
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
    const load = agentPathogenLoad(agent);
    if (load <= PATHOGEN_EPSILON) continue;
    const current = pressure.get(key);
    pressure.set(key, {
      position: { ...agent.position },
      pressure: unionPressure(current?.pressure ?? 0, load),
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
  // Contact must use the pre-step loads for every BOT. Otherwise array order can
  // create an artificial within-tick infection chain.
  const previousState = {
    agents: state.agents.map((agent) => ({
      ...agent,
      pathogenLoad: previousLoads.get(agent.id) ?? 0,
    })) as Agent[],
  };
  let changed = 0;

  for (const agent of state.agents) {
    const current = previousLoads.get(agent.id) ?? 0;
    const ambient = ambientPathogenPressure(agent.position, environment) * PATHOGEN_AMBIENT_GAIN;
    const contact = localContactPressure(previousState, agent) * PATHOGEN_CONTACT_GAIN;
    const exposure = unionPressure(ambient, contact);
    const next = clamp01(current * (1 - PATHOGEN_RECOVERY_RATE) + (1 - current) * exposure);
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
    if (next >= PATHOGEN_SYMPTOM_THRESHOLD && agent.energy > 0) {
      agent.energy = Math.max(0, agent.energy - PATHOGEN_SYMPTOM_ENERGY_COST);
      changed += 1;
    }
  }
  return changed;
}

/**
 * Advance the pathogen layer without adding another persisted world object.
 * `pathogenLoad` is an optional additive Agent property: old saves read it as 0,
 * ordinary structured-clone persistence and agent handoff retain it, and fresh
 * agents start susceptible. Local contact is six-neighbor hex contact; halo
 * exposure is applied only at exact boundary cells on its slower cadence.
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
    const perExposure = clamp01(pressure * PATHOGEN_HALO_GAIN);
    const combinedExposure = 1 - Math.pow(1 - perExposure, safeHaloSteps);
    const next = clamp01(current + (1 - current) * combinedExposure);
    if (next - current <= PATHOGEN_EPSILON) continue;
    (agent as PathogenAgent).pathogenLoad = next;
    changed += 1;
  }
  return changed;
}
