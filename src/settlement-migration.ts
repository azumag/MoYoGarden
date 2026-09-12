import type { HexHaloTile } from "./hex-halo.js";
import {
  HEX_GRID_DIRECTIONS,
  HEX_GRID_DIRECTION_STEPS,
  hexGridDistance,
  type HexGridDirection,
} from "./hex-grid.js";
import {
  BUILD_RECIPES,
  inventoryTotal,
  positionKey,
  RESOURCE_KINDS,
  type Agent,
  type GridPosition,
  type WorldState,
} from "./protocol.js";
import { getAgent, getFaction, isPassable } from "./world.js";

const RESIDENT_CAPACITY_PER_CAMP = 6;
const CAMP_MIN_SPACING = 2;
const CAMP_LOCAL_BUILD_RADIUS = 5;
const LOW_ENERGY_THRESHOLD = 18;
export const SETTLEMENT_MIGRATION_SCOUT_INTERVAL = 12;

export interface AutonomousSettlementMigrationPlan {
  agentId: string;
  direction: HexGridDirection;
  neighborRegionId: string;
  boundaryTarget: GridPosition;
  issuedAtTick: number;
  startedAtTick: number;
}

function directionRank(direction: HexGridDirection): number {
  return HEX_GRID_DIRECTIONS.indexOf(direction);
}

function localPathDistances(state: WorldState, start: GridPosition): Map<string, number> {
  const distances = new Map<string, number>([[positionKey(start), 0]]);
  const queue: GridPosition[] = [{ ...start }];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current === undefined) break;
    const currentDistance = distances.get(positionKey(current)) ?? 0;
    for (const step of Object.values(HEX_GRID_DIRECTION_STEPS)) {
      const next = { x: current.x + step.x, y: current.y + step.y };
      const key = positionKey(next);
      if (distances.has(key) || !isPassable(state, next)) continue;
      distances.set(key, currentDistance + 1);
      queue.push(next);
    }
  }
  return distances;
}

function activeCamps(state: WorldState, factionId: string) {
  return state.structures
    .filter((structure) =>
      structure.factionId === factionId
      && structure.type === "camp"
      && structure.status === "active"
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function hasLocalSpacedCampSite(state: WorldState, factionId: string): boolean {
  const camps = activeCamps(state, factionId);
  const anchor = camps[0];
  if (anchor === undefined) return true;
  const occupied = new Set(state.structures.map((structure) => positionKey(structure.position)));
  return state.tiles.some((tile) =>
    tile.terrain !== "water"
    && !occupied.has(positionKey(tile))
    && hexGridDistance(tile, anchor.position) <= CAMP_LOCAL_BUILD_RADIUS
    && camps.every((camp) => hexGridDistance(tile, camp.position) >= CAMP_MIN_SPACING)
  );
}

export function settlementMigrationPressure(state: WorldState, factionId: string): boolean {
  const camps = activeCamps(state, factionId);
  if (camps.length === 0) return false;
  if (state.structures.some((structure) =>
    structure.factionId === factionId
    && structure.type === "camp"
    && structure.status === "building"
  )) return false;
  const population = state.agents.filter((agent) => agent.factionId === factionId).length;
  if (population < camps.length * RESIDENT_CAPACITY_PER_CAMP) return false;
  return !hasLocalSpacedCampSite(state, factionId);
}

function campKitDeficit(agent: Agent) {
  const cost = BUILD_RECIPES.camp.cost;
  return {
    wood: Math.max(0, cost.wood - agent.inventory.wood),
    stone: Math.max(0, cost.stone - agent.inventory.stone),
    food: Math.max(0, cost.food - agent.inventory.food),
  };
}

export function canPrepareSettlementMigrationKit(state: WorldState, agent: Agent): boolean {
  const faction = getFaction(state, agent.factionId);
  if (faction === undefined) return false;
  const deficit = campKitDeficit(agent);
  const load = RESOURCE_KINDS.reduce((sum, kind) => sum + deficit[kind], 0);
  if (inventoryTotal(agent.inventory) + load > agent.capacity) return false;
  return RESOURCE_KINDS.every((kind) => faction.resources[kind] >= deficit[kind]);
}

export function prepareSettlementMigrationKit(state: WorldState, agentId: string): boolean {
  const agent = getAgent(state, agentId);
  if (agent === undefined || !canPrepareSettlementMigrationKit(state, agent)) return false;
  const faction = getFaction(state, agent.factionId);
  if (faction === undefined) return false;
  const deficit = campKitDeficit(agent);
  // faction.resources is the same authoritative spendable pool used by local
  // construction. Move the missing kit into carried inventory so material
  // survives ownership handoff instead of appearing in the target region.
  for (const kind of RESOURCE_KINDS) {
    faction.resources[kind] -= deficit[kind];
    agent.inventory[kind] += deficit[kind];
  }
  return true;
}

function eligiblePioneer(agent: Agent): boolean {
  if (!agent.autonomy || agent.role !== "builder" || agent.energy <= LOW_ENERGY_THRESHOLD) return false;
  if (agent.task === undefined) return true;
  return agent.task.source === "autonomy"
    && agent.task.type === "build"
    && agent.task.structureType === "camp"
    && agent.task.structureId === undefined;
}

export function shouldScoutSettlementMigration(state: WorldState): boolean {
  if (state.tick % SETTLEMENT_MIGRATION_SCOUT_INTERVAL !== 0) return false;
  return state.factions.some((faction) =>
    settlementMigrationPressure(state, faction.id)
    && state.agents.some((agent) =>
      agent.factionId === faction.id
      && eligiblePioneer(agent)
      && canPrepareSettlementMigrationKit(state, agent)
    )
  );
}

export function planAutonomousSettlementMigration(
  state: WorldState,
  halo: readonly HexHaloTile[],
): AutonomousSettlementMigrationPlan | undefined {
  const plans: Array<{
    agent: Agent;
    entry: HexHaloTile;
    distance: number;
    issuedAtTick: number;
  }> = [];
  const pressuredFactions = new Set(
    state.factions
      .filter((faction) => settlementMigrationPressure(state, faction.id))
      .map((faction) => faction.id),
  );
  if (pressuredFactions.size === 0) return undefined;

  for (const agent of [...state.agents].sort((a, b) => a.id.localeCompare(b.id))) {
    if (
      !pressuredFactions.has(agent.factionId)
      || !eligiblePioneer(agent)
      || !canPrepareSettlementMigrationKit(state, agent)
    ) continue;
    const distances = localPathDistances(state, agent.position);
    const energyBudget = Math.max(0, agent.energy - LOW_ENERGY_THRESHOLD);
    const candidate = halo
      .flatMap((entry) => {
        if (entry.tile.terrain === "water") return [];
        const distance = distances.get(positionKey(entry.sourcePosition));
        if (distance === undefined || distance > energyBudget) return [];
        return [{ entry, distance }];
      })
      .sort((a, b) =>
        a.distance - b.distance
        || directionRank(a.entry.direction) - directionRank(b.entry.direction)
        || a.entry.neighborRegionId.localeCompare(b.entry.neighborRegionId)
        || a.entry.sourcePosition.y - b.entry.sourcePosition.y
        || a.entry.sourcePosition.x - b.entry.sourcePosition.x
      )[0];
    if (candidate === undefined) continue;
    const issuedAtTick = agent.task?.source === "autonomy" && agent.task.type === "build"
      ? agent.task.issuedAtTick
      : state.tick;
    plans.push({ agent, entry: candidate.entry, distance: candidate.distance, issuedAtTick });
  }

  const selected = plans.sort((a, b) =>
    a.distance - b.distance
    || a.agent.id.localeCompare(b.agent.id)
    || directionRank(a.entry.direction) - directionRank(b.entry.direction)
    || a.entry.neighborRegionId.localeCompare(b.entry.neighborRegionId)
  )[0];
  if (selected === undefined) return undefined;
  return {
    agentId: selected.agent.id,
    direction: selected.entry.direction,
    neighborRegionId: selected.entry.neighborRegionId,
    boundaryTarget: { ...selected.entry.sourcePosition },
    issuedAtTick: selected.issuedAtTick,
    startedAtTick: state.tick,
  };
}
