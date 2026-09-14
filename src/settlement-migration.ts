import type { HexHaloTile } from "./hex-halo.js";
import {
  HEX_GRID_DIRECTIONS,
  HEX_GRID_DIRECTION_STEPS,
  hexGridDistance,
  isHexGridCell,
  type HexGridDirection,
} from "./hex-grid.js";
import {
  BUILD_RECIPES,
  inventoryTotal,
  positionKey,
  RESOURCE_KINDS,
  type Agent,
  type GridPosition,
  type ResourceKind,
  type WorldState,
} from "./protocol.js";
import { hexDistance, regionAxialCoordinate } from "./region-topology.js";
import { getAgent, getFaction, isPassable } from "./world.js";

const RESIDENT_CAPACITY_PER_CAMP = 6;
const CAMP_MIN_SPACING = 2;
const CAMP_LOCAL_BUILD_RADIUS = 5;
const LOW_ENERGY_THRESHOLD = 18;
const SETTLEMENT_DRAINAGE_EPSILON = 1e-6;
const SETTLEMENT_PATHOGEN_EPSILON = 1e-6;
const SETTLEMENT_RESOURCE_CAPACITY_EPSILON = 1e-6;
const SETTLEMENT_RESOURCE_AMOUNT_EPSILON = 1e-6;
const SETTLEMENT_WATER_FRACTION_EPSILON = 1e-6;
export const SETTLEMENT_MIGRATION_SCOUT_INTERVAL = 12;

export interface AutonomousSettlementMigrationPlan {
  agentId: string;
  direction: HexGridDirection;
  neighborRegionId: string;
  boundaryTarget: GridPosition;
  issuedAtTick: number;
  startedAtTick: number;
}

interface SettlementNeighborSupport {
  passableCells: number;
  waterCells: number;
  drainageTotal: number;
  drainageSamples: number;
  pathogenReservoirTotal: number;
  pathogenReservoirSamples: number;
  resources: Record<ResourceKind, number>;
  resourceCapacity: Record<ResourceKind, number>;
}

interface SettlementSeamCandidate {
  entry: HexHaloTile;
  distance: number;
  pathCrowding: number;
  crowding: number;
  support: SettlementNeighborSupport;
}

interface SettlementPlanCandidate extends SettlementSeamCandidate {
  agent: Agent;
  issuedAtTick: number;
}

interface LocalPathScore {
  distance: number;
  crowding: number;
}

function directionRank(direction: HexGridDirection): number {
  return HEX_GRID_DIRECTIONS.indexOf(direction);
}

function emptySettlementNeighborSupport(): SettlementNeighborSupport {
  return {
    passableCells: 0,
    waterCells: 0,
    drainageTotal: 0,
    drainageSamples: 0,
    pathogenReservoirTotal: 0,
    pathogenReservoirSamples: 0,
    resources: { wood: 0, stone: 0, food: 0 },
    resourceCapacity: { wood: 0, stone: 0, food: 0 },
  };
}

function pathogenReservoirSample(tile: HexHaloTile["tile"]): number | undefined {
  const value = (tile as HexHaloTile["tile"] & { pathogenReservoir?: unknown }).pathogenReservoir;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(1, value));
}

function addSettlementSupportTile(
  support: SettlementNeighborSupport,
  tile: HexHaloTile["tile"],
): void {
  if (tile.terrain === "water") {
    support.waterCells += 1;
    return;
  }
  support.passableCells += 1;
  if (Number.isFinite(tile.drainage ?? Number.NaN)) {
    support.drainageTotal += Math.max(0, Math.min(1, tile.drainage ?? 0));
    support.drainageSamples += 1;
  }
  const pathogenReservoir = pathogenReservoirSample(tile);
  if (pathogenReservoir !== undefined) {
    support.pathogenReservoirTotal += pathogenReservoir;
    support.pathogenReservoirSamples += 1;
  }
  const resource = tile.resource;
  if (resource === undefined) return;
  if (resource.maxAmount > 0) support.resourceCapacity[resource.kind] += resource.maxAmount;
  if (resource.amount > 0) support.resources[resource.kind] += resource.amount;
}

function settlementNeighborSupports(
  halo: readonly HexHaloTile[],
): Map<string, SettlementNeighborSupport> {
  const supportByRegion = new Map<string, SettlementNeighborSupport>();
  const seenNeighborCells = new Set<string>();
  for (const entry of halo) {
    const cellKey = `${entry.neighborRegionId}:${entry.neighborPosition.x},${entry.neighborPosition.y}`;
    if (seenNeighborCells.has(cellKey)) continue;
    seenNeighborCells.add(cellKey);
    let support = supportByRegion.get(entry.neighborRegionId);
    if (support === undefined) {
      support = emptySettlementNeighborSupport();
      supportByRegion.set(entry.neighborRegionId, support);
    }
    addSettlementSupportTile(support, entry.tile);
  }
  return supportByRegion;
}

function localSettlementSupport(state: WorldState): SettlementNeighborSupport {
  const support = emptySettlementNeighborSupport();
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile)) continue;
    addSettlementSupportTile(support, tile);
  }
  return support;
}

function resourceDiversity(support: SettlementNeighborSupport): number {
  return RESOURCE_KINDS.reduce(
    (count, kind) => count + (support.resourceCapacity[kind] > 0 ? 1 : 0),
    0,
  );
}

function averageDrainage(support: SettlementNeighborSupport): number {
  return support.drainageSamples > 0
    ? support.drainageTotal / support.drainageSamples
    : 0;
}

function compareAverageDrainage(
  a: SettlementNeighborSupport,
  b: SettlementNeighborSupport,
): number {
  if (a.drainageSamples === 0 || b.drainageSamples === 0) return 0;
  const delta = averageDrainage(b) - averageDrainage(a);
  return Math.abs(delta) > SETTLEMENT_DRAINAGE_EPSILON ? delta : 0;
}

function averagePathogenReservoir(support: SettlementNeighborSupport): number {
  return support.pathogenReservoirSamples > 0
    ? support.pathogenReservoirTotal / support.pathogenReservoirSamples
    : 0;
}

function compareAveragePathogenReservoir(
  a: SettlementNeighborSupport,
  b: SettlementNeighborSupport,
): number {
  if (a.pathogenReservoirSamples === 0 || b.pathogenReservoirSamples === 0) return 0;
  const delta = averagePathogenReservoir(a) - averagePathogenReservoir(b);
  return Math.abs(delta) > SETTLEMENT_PATHOGEN_EPSILON ? delta : 0;
}

function settlementContinuationRank(support: SettlementNeighborSupport): number {
  return (support.resourceCapacity.food > 0 ? 4 : 0)
    + (support.resourceCapacity.wood > 0 ? 2 : 0)
    + (support.resourceCapacity.stone > 0 ? 1 : 0);
}

function resourceCapacityDensity(
  support: SettlementNeighborSupport,
  kind: ResourceKind,
): number {
  return support.passableCells > 0
    ? support.resourceCapacity[kind] / support.passableCells
    : 0;
}

function compareResourceCapacityDensity(
  a: SettlementNeighborSupport,
  b: SettlementNeighborSupport,
  kind: ResourceKind,
): number {
  const delta = resourceCapacityDensity(b, kind) - resourceCapacityDensity(a, kind);
  return Math.abs(delta) > SETTLEMENT_RESOURCE_CAPACITY_EPSILON ? delta : 0;
}

function resourceAmountDensity(
  support: SettlementNeighborSupport,
  kind: ResourceKind,
): number {
  return support.passableCells > 0
    ? support.resources[kind] / support.passableCells
    : 0;
}

function compareResourceAmountDensity(
  a: SettlementNeighborSupport,
  b: SettlementNeighborSupport,
  kind: ResourceKind,
): number {
  const delta = resourceAmountDensity(b, kind) - resourceAmountDensity(a, kind);
  return Math.abs(delta) > SETTLEMENT_RESOURCE_AMOUNT_EPSILON ? delta : 0;
}

function surfaceWaterFraction(support: SettlementNeighborSupport): number {
  const observedCells = support.passableCells + support.waterCells;
  return observedCells > 0 ? support.waterCells / observedCells : 0;
}

function compareSurfaceWaterFraction(
  a: SettlementNeighborSupport,
  b: SettlementNeighborSupport,
): number {
  const delta = surfaceWaterFraction(b) - surfaceWaterFraction(a);
  return Math.abs(delta) > SETTLEMENT_WATER_FRACTION_EPSILON ? delta : 0;
}

function compareContinuationResourceCapacity(
  candidate: SettlementNeighborSupport,
  local: SettlementNeighborSupport,
): number {
  for (const kind of ["food", "wood", "stone"] as const) {
    const delta = resourceCapacityDensity(candidate, kind) - resourceCapacityDensity(local, kind);
    if (Math.abs(delta) > SETTLEMENT_RESOURCE_CAPACITY_EPSILON) return delta;
  }
  return 0;
}

function shouldContinueSettlementMigration(
  candidate: SettlementNeighborSupport,
  local: SettlementNeighborSupport,
): boolean {
  const candidateRank = settlementContinuationRank(candidate);
  const localRank = settlementContinuationRank(local);
  if (candidateRank !== localRank) return candidateRank > localRank;

  const resourceCapacityDelta = compareContinuationResourceCapacity(candidate, local);
  if (resourceCapacityDelta !== 0) return resourceCapacityDelta > 0;

  if (candidate.pathogenReservoirSamples > 0 && local.pathogenReservoirSamples > 0) {
    const candidatePathogen = averagePathogenReservoir(candidate);
    const localPathogen = averagePathogenReservoir(local);
    if (candidatePathogen < localPathogen - SETTLEMENT_PATHOGEN_EPSILON) return true;
    if (candidatePathogen > localPathogen + SETTLEMENT_PATHOGEN_EPSILON) return false;
  }

  const waterFractionDelta = surfaceWaterFraction(candidate) - surfaceWaterFraction(local);
  if (Math.abs(waterFractionDelta) > SETTLEMENT_WATER_FRACTION_EPSILON) {
    return waterFractionDelta > 0;
  }

  if (candidate.drainageSamples === 0 || local.drainageSamples === 0) return false;
  return averageDrainage(candidate) > averageDrainage(local) + SETTLEMENT_DRAINAGE_EPSILON;
}

function compareSettlementSupport(
  a: SettlementNeighborSupport,
  b: SettlementNeighborSupport,
): number {
  return (
    resourceDiversity(b) - resourceDiversity(a)
    || compareResourceCapacityDensity(a, b, "food")
    || compareResourceCapacityDensity(a, b, "wood")
    || compareResourceCapacityDensity(a, b, "stone")
    || compareAveragePathogenReservoir(a, b)
    || compareResourceAmountDensity(a, b, "food")
    || compareResourceAmountDensity(a, b, "wood")
    || compareResourceAmountDensity(a, b, "stone")
    || compareAverageDrainage(a, b)
    || compareSurfaceWaterFraction(a, b)
  );
}

function settlementRouteCost(candidate: SettlementSeamCandidate): number {
  // General movement already minimizes cumulative crowding among equally short
  // paths. Settlement migration additionally chooses between different seam
  // targets, so price each occupied hex encountered on that target's shortest
  // path as one extra step of travel effort. This lets population pressure spill
  // through a nearby quiet seam instead of always choosing a geometrically closer
  // but jammed exit, while destination support remains the primary criterion.
  return candidate.distance + candidate.pathCrowding;
}

function compareSettlementSeamCandidate(
  a: SettlementSeamCandidate,
  b: SettlementSeamCandidate,
): number {
  return (
    compareSettlementSupport(a.support, b.support)
    || settlementRouteCost(a) - settlementRouteCost(b)
    || a.distance - b.distance
    || a.pathCrowding - b.pathCrowding
    || a.crowding - b.crowding
    || directionRank(a.entry.direction) - directionRank(b.entry.direction)
    || a.entry.neighborRegionId.localeCompare(b.entry.neighborRegionId)
    || a.entry.sourcePosition.y - b.entry.sourcePosition.y
    || a.entry.sourcePosition.x - b.entry.sourcePosition.x
  );
}

function compareSettlementPlanCandidate(
  a: SettlementPlanCandidate,
  b: SettlementPlanCandidate,
): number {
  return (
    compareSettlementSupport(a.support, b.support)
    || settlementRouteCost(a) - settlementRouteCost(b)
    || a.distance - b.distance
    || a.pathCrowding - b.pathCrowding
    || a.crowding - b.crowding
    // Equivalent migration plans should use the builder with the larger
    // remaining energy reserve before falling back to stable agent ID order.
    || b.agent.energy - a.agent.energy
    || a.agent.id.localeCompare(b.agent.id)
    || directionRank(a.entry.direction) - directionRank(b.entry.direction)
    || a.entry.neighborRegionId.localeCompare(b.entry.neighborRegionId)
  );
}

function localPathScores(
  state: WorldState,
  start: GridPosition,
  crowdingByPosition: ReadonlyMap<string, number>,
): Map<string, LocalPathScore> {
  const scores = new Map<string, LocalPathScore>([
    [positionKey(start), { distance: 0, crowding: 0 }],
  ]);
  const queue: GridPosition[] = [{ ...start }];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current === undefined) break;
    const currentScore = scores.get(positionKey(current));
    if (currentScore === undefined) continue;
    for (const step of Object.values(HEX_GRID_DIRECTION_STEPS)) {
      const next = { x: current.x + step.x, y: current.y + step.y };
      if (!isPassable(state, next)) continue;
      const key = positionKey(next);
      const candidate: LocalPathScore = {
        distance: currentScore.distance + 1,
        crowding: currentScore.crowding + (crowdingByPosition.get(key) ?? 0),
      };
      const existing = scores.get(key);
      if (
        existing !== undefined &&
        (existing.distance < candidate.distance ||
          (existing.distance === candidate.distance && existing.crowding <= candidate.crowding))
      ) {
        continue;
      }
      scores.set(key, candidate);
      // Keep each endpoint on a shortest route, selecting the least crowded one
      // among equal-length paths. The seam comparator may then choose a slightly
      // farther endpoint when its total travel effort is lower.
      queue.push(next);
    }
  }
  return scores;
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
  if (camps.length === 0) return true;
  const occupied = new Set(state.structures.map((structure) => positionKey(structure.position)));
  return state.tiles.some((tile) =>
    isHexGridCell(state, tile)
    && tile.terrain !== "water"
    && !occupied.has(positionKey(tile))
    && camps.some((camp) => hexGridDistance(tile, camp.position) <= CAMP_LOCAL_BUILD_RADIUS)
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
  const hasLocalCamp = state.structures.some((structure) =>
    structure.factionId === agent.factionId
    && structure.type === "camp"
    && (structure.status === "active" || structure.status === "building")
  );
  // Starting from an established settlement defines a fresh route origin. A
  // camp-less transit region keeps the existing origin so the pioneer can make
  // bounded monotonic progress across several handoffs without a visited log.
  if (hasLocalCamp || agent.settlementMigrationOriginRegionId === undefined) {
    agent.settlementMigrationOriginRegionId = state.regionId;
  }
  const deficit = campKitDeficit(agent);
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

function isTransitPioneer(state: WorldState, agent: Agent): boolean {
  if (!eligiblePioneer(agent)) return false;
  if (state.structures.some((structure) =>
    structure.factionId === agent.factionId
    && structure.type === "camp"
    && (structure.status === "active" || structure.status === "building")
  )) return false;
  const task = agent.task;
  if (
    task?.source !== "autonomy"
    || task.type !== "build"
    || task.structureType !== "camp"
    || task.structureId !== undefined
    || task.target !== undefined
  ) return false;
  const deficit = campKitDeficit(agent);
  return RESOURCE_KINDS.every((kind) => deficit[kind] === 0);
}

function sameSettlementRegion(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  if (a === b) return true;
  const aAxial = regionAxialCoordinate(a);
  const bAxial = regionAxialCoordinate(b);
  return aAxial !== undefined
    && bAxial !== undefined
    && aAxial.q === bAxial.q
    && aAxial.r === bAxial.r;
}

function settlementRouteHysteresisBlocks(
  previousRegionId: string | undefined,
  candidateRegionId: string,
): boolean {
  if (sameSettlementRegion(previousRegionId, candidateRegionId)) return true;
  if (previousRegionId === undefined) return false;
  const previousAxial = regionAxialCoordinate(previousRegionId);
  const candidateAxial = regionAxialCoordinate(candidateRegionId);
  return previousAxial !== undefined
    && candidateAxial !== undefined
    && hexDistance(previousAxial, candidateAxial) === 1;
}

function settlementOriginProgressBlocks(
  originRegionId: string | undefined,
  currentRegionId: string,
  candidateRegionId: string,
): boolean {
  if (originRegionId === undefined) return false;
  const originAxial = regionAxialCoordinate(originRegionId);
  const currentAxial = regionAxialCoordinate(currentRegionId);
  const candidateAxial = regionAxialCoordinate(candidateRegionId);
  if (originAxial === undefined || currentAxial === undefined || candidateAxial === undefined) {
    return false;
  }
  return hexDistance(originAxial, candidateAxial) <= hexDistance(originAxial, currentAxial);
}

export function shouldScoutSettlementMigration(state: WorldState): boolean {
  if (state.agents.some((agent) => isTransitPioneer(state, agent))) return true;
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
  const pressuredFactions = new Set(
    state.factions
      .filter((faction) => settlementMigrationPressure(state, faction.id))
      .map((faction) => faction.id),
  );
  const supportByRegion = settlementNeighborSupports(halo);
  let localSupport: SettlementNeighborSupport | undefined;
  const pathsByOrigin = new Map<string, Map<string, LocalPathScore>>();
  const crowdingByPosition = new Map<string, number>();
  for (const occupant of state.agents) {
    const key = positionKey(occupant.position);
    crowdingByPosition.set(key, (crowdingByPosition.get(key) ?? 0) + 1);
  }
  const candidateAgents = state.agents
    .flatMap((agent) => {
      const transitPioneer = isTransitPioneer(state, agent);
      return (
        (pressuredFactions.has(agent.factionId) || transitPioneer)
        && eligiblePioneer(agent)
        && canPrepareSettlementMigrationKit(state, agent)
      ) ? [{ agent, transitPioneer }] : [];
    })
    .sort((a, b) => a.agent.id.localeCompare(b.agent.id));
  let selected: SettlementPlanCandidate | undefined;

  for (const { agent, transitPioneer } of candidateAgents) {
    const originKey = positionKey(agent.position);
    let paths = pathsByOrigin.get(originKey);
    if (paths === undefined) {
      paths = localPathScores(state, agent.position, crowdingByPosition);
      pathsByOrigin.set(originKey, paths);
    }
    const energyBudget = Math.max(0, agent.energy - LOW_ENERGY_THRESHOLD);
    let candidate: SettlementSeamCandidate | undefined;
    for (const entry of halo) {
      if (entry.tile.terrain === "water") continue;
      if (
        transitPioneer
        && agent.task?.source === "autonomy"
        && agent.task.type === "build"
        && (
          settlementRouteHysteresisBlocks(
            agent.task.settlementPreviousRegionId,
            entry.neighborRegionId,
          )
          || settlementOriginProgressBlocks(
            agent.settlementMigrationOriginRegionId,
            state.regionId,
            entry.neighborRegionId,
          )
        )
      ) {
        // The immediate previous-region wedge prevents reversals and the shortest
        // triangular loop. Once a persisted migration origin is available, every
        // further hop must also increase axial distance from that origin. This
        // bounded O(1) memory prevents longer same-ring circulation without deep
        // neighbor reads or an unbounded visited-region history.
        continue;
      }
      const targetKey = positionKey(entry.sourcePosition);
      const path = paths.get(targetKey);
      if (path === undefined || path.distance > energyBudget) continue;
      const support = supportByRegion.get(entry.neighborRegionId) ?? emptySettlementNeighborSupport();
      if (transitPioneer) {
        localSupport ??= localSettlementSupport(state);
        if (!shouldContinueSettlementMigration(support, localSupport)) continue;
      }
      const crowding = Math.max(
        0,
        (crowdingByPosition.get(targetKey) ?? 0) - (targetKey === originKey ? 1 : 0),
      );
      const next = {
        entry,
        distance: path.distance,
        pathCrowding: path.crowding,
        crowding,
        support,
      };
      if (candidate === undefined || compareSettlementSeamCandidate(next, candidate) < 0) {
        candidate = next;
      }
    }
    if (candidate === undefined) continue;
    const issuedAtTick = agent.task?.source === "autonomy" && agent.task.type === "build"
      ? agent.task.issuedAtTick
      : state.tick;
    const planCandidate: SettlementPlanCandidate = {
      agent,
      entry: candidate.entry,
      distance: candidate.distance,
      pathCrowding: candidate.pathCrowding,
      crowding: candidate.crowding,
      issuedAtTick,
      support: candidate.support,
    };
    if (selected === undefined || compareSettlementPlanCandidate(planCandidate, selected) < 0) {
      selected = planCandidate;
    }
  }

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