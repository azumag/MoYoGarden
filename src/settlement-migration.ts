import type { HexHaloRegionSummary, HexHaloTile } from "./hex-halo.js";
import {
  HEX_GRID_DIRECTIONS,
  HEX_GRID_DIRECTION_STEPS,
  hexGridDistance,
  isHexGridCell,
  type HexGridDirection,
} from "./hex-grid.js";
import { dependentCaregiverId } from "./demography.js";
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
import { activeFactionStructures, getAgent, getFaction, isPassable } from "./world.js";

const RESIDENT_CAPACITY_PER_CAMP = 6;
const CAMP_MIN_SPACING = 2;
const CAMP_LOCAL_BUILD_RADIUS = 5;
const LOW_ENERGY_THRESHOLD = 18;
const SETTLEMENT_DRAINAGE_EPSILON = 1e-6;
const SETTLEMENT_EROSION_EPSILON = 1e-6;
const SETTLEMENT_PATHOGEN_EPSILON = 1e-6;
const SETTLEMENT_POPULATION_DENSITY_EPSILON = 1e-6;
const SETTLEMENT_CAMP_DENSITY_EPSILON = 1e-6;
const SETTLEMENT_STRUCTURE_DENSITY_EPSILON = 1e-6;
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

export interface SettlementFamilyFollowPlan {
  agentId: string;
  direction: HexGridDirection;
  neighborRegionId: string;
  targetRegionId: string;
  boundaryTarget: GridPosition;
}

export interface SettlementFamilyRegistrationResult {
  agentIds: string[];
  candidateCount: number;
}

export function settlementFamilyRegistrationDeferred(
  result: SettlementFamilyRegistrationResult,
): boolean {
  return result.agentIds.length < result.candidateCount;
}

const MAX_SETTLEMENT_FAMILY_FOLLOWERS = 6;
const GLOBAL_AGENT_PREFIX = "agent-global:";

function sourceResidentGlobalId(state: WorldState, agentId: string): string {
  return agentId.startsWith(GLOBAL_AGENT_PREFIX)
    ? agentId
    : `${GLOBAL_AGENT_PREFIX}${state.regionId}:${agentId}`;
}

function sourceResidentMatchesReference(
  state: WorldState,
  resident: Agent,
  referenceId: string | undefined,
): boolean {
  return referenceId !== undefined
    && (resident.id === referenceId || sourceResidentGlobalId(state, resident.id) === referenceId);
}

function familyFollowPriority(agent: Agent): number {
  if (agent.pregnancy !== undefined) return 0;
  if (agent.lifeStage === "infant" || agent.lifeStage === "juvenile") return 2;
  return 1;
}

export function registerSettlementFamilyFollowers(
  state: WorldState,
  pioneerId: string,
  targetRegionId: string,
  factionId: string,
  pioneerPartnerId?: string,
  maxFollowers = MAX_SETTLEMENT_FAMILY_FOLLOWERS,
): SettlementFamilyRegistrationResult {
  if (
    regionAxialCoordinate(targetRegionId) === undefined
    || sameSettlementRegion(state.regionId, targetRegionId)
  ) {
    return { agentIds: [], candidateCount: 0 };
  }

  const priorities = new Map<string, number>();
  const requiredFollowerLinks = new Map<string, Set<string>>();
  const add = (agent: Agent | undefined, priority: number): void => {
    if (
      agent === undefined
      || agent.hp <= 0
      || agent.factionId !== factionId
      || sourceResidentMatchesReference(state, agent, pioneerId)
    ) return;
    const previous = priorities.get(agent.id);
    if (previous === undefined || priority < previous) priorities.set(agent.id, priority);
  };
  const linkFollowers = (leftId: string, rightId: string): void => {
    if (leftId === rightId || !priorities.has(leftId) || !priorities.has(rightId)) return;
    let left = requiredFollowerLinks.get(leftId);
    if (left === undefined) {
      left = new Set<string>();
      requiredFollowerLinks.set(leftId, left);
    }
    let right = requiredFollowerLinks.get(rightId);
    if (right === undefined) {
      right = new Set<string>();
      requiredFollowerLinks.set(rightId, right);
    }
    left.add(rightId);
    right.add(leftId);
  };

  for (const relative of state.agents) {
    if (relative.factionId !== factionId || relative.hp <= 0) continue;
    if (sourceResidentMatchesReference(state, relative, pioneerPartnerId)) add(relative, 0);
    if (relative.pregnancy?.partnerId === pioneerId) add(relative, 0);
    if (
      (relative.lifeStage === "infant" || relative.lifeStage === "juvenile")
      && relative.parents?.includes(pioneerId)
    ) {
      add(relative, 2);
      const caregiverId = dependentCaregiverId(state, relative);
      const caregiver = state.agents.find((agent) => agent.id === caregiverId);
      add(caregiver, 0);
      if (caregiver !== undefined) linkFollowers(relative.id, caregiver.id);
      for (const parentId of relative.parents) {
        if (parentId === pioneerId) continue;
        add(state.agents.find((agent) =>
          sourceResidentMatchesReference(state, agent, parentId)
        ), 1);
      }
    }
  }

  const followerLimit = Number.isFinite(maxFollowers)
    ? Math.max(0, Math.min(MAX_SETTLEMENT_FAMILY_FOLLOWERS, Math.floor(maxFollowers)))
    : MAX_SETTLEMENT_FAMILY_FOLLOWERS;
  const ordered = [...priorities]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  const selected: string[] = [];
  const visited = new Set<string>();
  for (const [agentId] of ordered) {
    if (visited.has(agentId)) continue;
    const component: string[] = [];
    const queue = [agentId];
    visited.add(agentId);
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const current = queue[cursor];
      if (current === undefined) continue;
      component.push(current);
      const linked = [...(requiredFollowerLinks.get(current) ?? [])]
        .sort((a, b) => a.localeCompare(b));
      for (const linkedId of linked) {
        if (visited.has(linkedId)) continue;
        visited.add(linkedId);
        queue.push(linkedId);
      }
    }
    component.sort((a, b) =>
      (priorities.get(a) ?? Number.MAX_SAFE_INTEGER)
        - (priorities.get(b) ?? Number.MAX_SAFE_INTEGER)
      || a.localeCompare(b)
    );
    // A dependent and the source-side caregiver that currently pays its care
    // cost are one admission unit. If the destination cannot admit the whole
    // unit, wait for more headroom instead of splitting the care relationship.
    if (selected.length + component.length > followerLimit) continue;
    selected.push(...component);
  }
  for (const agentId of selected) {
    const agent = state.agents.find((entry) => entry.id === agentId);
    if (agent !== undefined) agent.settlementFamilyTargetRegionId = targetRegionId;
  }
  return { agentIds: selected, candidateCount: priorities.size };
}

export function settlementFamilyHousingHeadroom(state: WorldState, factionId: string): number {
  const activeCamps = state.structures.filter((structure) =>
    structure.factionId === factionId
    && structure.status === "active"
    && structure.type === "camp"
  ).length;
  const residents = state.agents.filter((agent) =>
    agent.factionId === factionId && agent.hp > 0
  ).length;
  return Math.max(0, activeCamps * RESIDENT_CAPACITY_PER_CAMP - residents);
}

export function settlementFamilyAdmissionHeadroom(state: WorldState, factionId: string): number {
  const faction = getFaction(state, factionId);
  if (faction === undefined) return 0;
  const activeStructures = state.structures.filter((structure) =>
    structure.factionId === factionId && structure.status === "active"
  );
  if (!activeStructures.some((structure) => structure.type === "camp")) return 0;
  const housingHeadroom = settlementFamilyHousingHeadroom(state, factionId);
  if (housingHeadroom <= 0) return 0;
  const storageHeadroom = activeStructures.reduce(
    (sum, structure) => sum + Math.max(
      0,
      BUILD_RECIPES[structure.type].storageCapacity - inventoryTotal(structure.storage),
    ),
    0,
  );
  if (storageHeadroom <= 0) return 0;

  const storedFood = activeStructures.reduce(
    (sum, structure) => sum + Math.max(0, structure.storage.food),
    0,
  );
  const ledgerFood = Math.max(0, faction.resources.food);
  // The faction ledger and structure inventories can describe the same
  // stock, especially across rolling persisted states, so never add them.
  // Live food deposits are physically separate support that settlers can
  // harvest after arrival and therefore can extend the bounded headroom.
  const liveFood = state.tiles.reduce((sum, tile) =>
    sum + (
      isHexGridCell(state, tile)
      && tile.terrain !== "water"
      && tile.resource?.kind === "food"
      && tile.resource.amount > 0
        ? tile.resource.amount
        : 0
    ),
    0,
  );
  const foodSupport = Math.max(ledgerFood, storedFood) + liveFood;
  return Math.max(0, Math.min(housingHeadroom, Math.floor(foodSupport)));
}

export function settlementFamilyAdmissionReady(state: WorldState, factionId: string): boolean {
  return settlementFamilyAdmissionHeadroom(state, factionId) > 0;
}

export function hasSettlementFamilyFollow(state: WorldState): boolean {
  return state.agents.some((agent) =>
    agent.hp > 0
    && agent.settlementFamilyTargetRegionId !== undefined
    && !sameSettlementRegion(state.regionId, agent.settlementFamilyTargetRegionId)
  );
}

export function planSettlementFamilyFollow(
  state: WorldState,
  halo: readonly HexHaloTile[],
): SettlementFamilyFollowPlan | undefined {
  const currentAxial = regionAxialCoordinate(state.regionId);
  if (currentAxial === undefined) return undefined;
  const crowdingByPosition = new Map<string, number>();
  for (const occupant of state.agents) {
    if (occupant.hp <= 0) continue;
    const key = positionKey(occupant.position);
    crowdingByPosition.set(key, (crowdingByPosition.get(key) ?? 0) + 1);
  }

  const followers = state.agents
    .filter((agent) =>
      agent.hp > 0
      && agent.energy > 0
      && agent.settlementFamilyTargetRegionId !== undefined
      && !sameSettlementRegion(state.regionId, agent.settlementFamilyTargetRegionId)
      && agent.task?.source !== "external"
    )
    .sort((a, b) => familyFollowPriority(a) - familyFollowPriority(b) || a.id.localeCompare(b.id));

  for (const agent of followers) {
    const targetRegionId = agent.settlementFamilyTargetRegionId;
    if (targetRegionId === undefined) continue;
    const targetAxial = regionAxialCoordinate(targetRegionId);
    if (targetAxial === undefined) continue;
    const currentDistance = hexDistance(currentAxial, targetAxial);
    if (currentDistance <= 0) continue;
    const paths = localPathScores(state, agent.position, crowdingByPosition);
    const dependent = agent.lifeStage === "infant" || agent.lifeStage === "juvenile";
    const energyBudget = Math.max(0, agent.energy - (dependent ? 0 : LOW_ENERGY_THRESHOLD));
    let best: { entry: HexHaloTile; distance: number; crowding: number; remaining: number } | undefined;
    for (const entry of halo) {
      if (entry.tile.terrain === "water") continue;
      const neighborAxial = regionAxialCoordinate(entry.neighborRegionId);
      if (neighborAxial === undefined) continue;
      const remaining = hexDistance(neighborAxial, targetAxial);
      if (remaining >= currentDistance) continue;
      const path = paths.get(positionKey(entry.sourcePosition));
      if (path === undefined || path.distance > energyBudget) continue;
      const candidate = {
        entry,
        distance: path.distance,
        crowding: path.crowding,
        remaining,
      };
      if (
        best === undefined
        || candidate.remaining < best.remaining
        || (candidate.remaining === best.remaining && candidate.distance + candidate.crowding < best.distance + best.crowding)
        || (
          candidate.remaining === best.remaining
          && candidate.distance + candidate.crowding === best.distance + best.crowding
          && directionRank(candidate.entry.direction) < directionRank(best.entry.direction)
        )
        || (
          candidate.remaining === best.remaining
          && candidate.distance + candidate.crowding === best.distance + best.crowding
          && directionRank(candidate.entry.direction) === directionRank(best.entry.direction)
          && candidate.entry.neighborRegionId.localeCompare(best.entry.neighborRegionId) < 0
        )
      ) {
        best = candidate;
      }
    }
    if (best !== undefined) {
      return {
        agentId: agent.id,
        direction: best.entry.direction,
        neighborRegionId: best.entry.neighborRegionId,
        targetRegionId,
        boundaryTarget: { ...best.entry.sourcePosition },
      };
    }
  }
  return undefined;
}

interface SettlementNeighborSupport {
  passableCells: number;
  resourceSampleCells: number;
  populationSampleCells: number;
  occupants: number;
  campSampleCells: number;
  activeCamps: number;
  structureSampleCells: number;
  activeStructures: number;
  waterCells: number;
  drainageTotal: number;
  drainageSamples: number;
  erosionPressureTotal: number;
  erosionPressureSamples: number;
  pathogenReservoirTotal: number;
  pathogenReservoirSamples: number;
  resources: Record<ResourceKind, number>;
  resourceCapacity: Record<ResourceKind, number>;
}

interface SettlementFactionOccupancy {
  own: number;
  foreign: number;
}

interface SettlementSeamCandidate {
  entry: HexHaloTile;
  distance: number;
  pathCrowding: number;
  crowding: number;
  support: SettlementNeighborSupport;
  factionStorageHeadroom: number | undefined;
  factionOccupancy: SettlementFactionOccupancy | undefined;
}

interface SettlementPlanCandidate extends SettlementSeamCandidate {
  agent: Agent;
  issuedAtTick: number;
  familySeparationCost: number;
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
    resourceSampleCells: 0,
    populationSampleCells: 0,
    occupants: 0,
    campSampleCells: 0,
    activeCamps: 0,
    structureSampleCells: 0,
    activeStructures: 0,
    waterCells: 0,
    drainageTotal: 0,
    drainageSamples: 0,
    erosionPressureTotal: 0,
    erosionPressureSamples: 0,
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
  support.resourceSampleCells += 1;
  if (Number.isFinite(tile.drainage ?? Number.NaN)) {
    support.drainageTotal += Math.max(0, Math.min(1, tile.drainage ?? 0));
    support.drainageSamples += 1;
  }
  if (Number.isFinite(tile.erosionPressure ?? Number.NaN)) {
    support.erosionPressureTotal += Math.max(0, Math.min(1, tile.erosionPressure ?? 0));
    support.erosionPressureSamples += 1;
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

function validRegionResourceSummary(
  summary: HexHaloRegionSummary | undefined,
): summary is HexHaloRegionSummary & { resourceCapacity: Record<ResourceKind, number> } {
  return summary !== undefined
    && summary.resourceCapacity !== undefined
    && Number.isInteger(summary.passableCells)
    && summary.passableCells > 0
    && RESOURCE_KINDS.every((kind) =>
      Number.isFinite(summary.resources[kind])
      && summary.resources[kind] >= 0
      && Number.isFinite(summary.resourceCapacity?.[kind])
      && (summary.resourceCapacity?.[kind] ?? -1) >= 0
    );
}

function sameRegionResourceSummary(
  a: HexHaloRegionSummary & { resourceCapacity: Record<ResourceKind, number> },
  b: HexHaloRegionSummary & { resourceCapacity: Record<ResourceKind, number> },
): boolean {
  return a.passableCells === b.passableCells
    && RESOURCE_KINDS.every((kind) =>
      a.resources[kind] === b.resources[kind]
      && a.resourceCapacity[kind] === b.resourceCapacity[kind]
    );
}

function applyRegionResourceSummary(
  support: SettlementNeighborSupport,
  summary: HexHaloRegionSummary & { resourceCapacity: Record<ResourceKind, number> },
): void {
  support.resourceSampleCells = summary.passableCells;
  for (const kind of RESOURCE_KINDS) {
    support.resources[kind] = summary.resources[kind];
    support.resourceCapacity[kind] = summary.resourceCapacity[kind];
  }
}

function validRegionPopulationSummary(
  summary: HexHaloRegionSummary | undefined,
): summary is HexHaloRegionSummary {
  return summary !== undefined
    && Number.isInteger(summary.passableCells)
    && summary.passableCells > 0
    && Number.isInteger(summary.occupants)
    && summary.occupants >= 0;
}

function sameRegionPopulationSummary(
  a: HexHaloRegionSummary,
  b: HexHaloRegionSummary,
): boolean {
  return a.passableCells === b.passableCells && a.occupants === b.occupants;
}

function applyRegionPopulationSummary(
  support: SettlementNeighborSupport,
  summary: HexHaloRegionSummary,
): void {
  support.populationSampleCells = summary.passableCells;
  support.occupants = summary.occupants;
}

function validRegionCampSummary(
  summary: HexHaloRegionSummary | undefined,
): summary is HexHaloRegionSummary & { activeStructures: NonNullable<HexHaloRegionSummary["activeStructures"]> } {
  return summary !== undefined
    && summary.activeStructures !== undefined
    && Number.isInteger(summary.passableCells)
    && summary.passableCells > 0
    && Number.isInteger(summary.activeStructures.camp)
    && summary.activeStructures.camp >= 0
    && Number.isInteger(summary.activeStructures.storehouse)
    && summary.activeStructures.storehouse >= 0
    && Number.isInteger(summary.activeStructures.market)
    && summary.activeStructures.market >= 0
    && Number.isInteger(summary.activeStructures.workshop)
    && summary.activeStructures.workshop >= 0;
}

function sameRegionCampSummary(
  a: HexHaloRegionSummary & { activeStructures: NonNullable<HexHaloRegionSummary["activeStructures"]> },
  b: HexHaloRegionSummary & { activeStructures: NonNullable<HexHaloRegionSummary["activeStructures"]> },
): boolean {
  return a.passableCells === b.passableCells
    && a.activeStructures.camp === b.activeStructures.camp
    && a.activeStructures.storehouse === b.activeStructures.storehouse
    && a.activeStructures.market === b.activeStructures.market
    && a.activeStructures.workshop === b.activeStructures.workshop;
}

function applyRegionCampSummary(
  support: SettlementNeighborSupport,
  summary: HexHaloRegionSummary & { activeStructures: NonNullable<HexHaloRegionSummary["activeStructures"]> },
): void {
  support.campSampleCells = summary.passableCells;
  support.activeCamps = summary.activeStructures.camp;
  support.structureSampleCells = summary.passableCells;
  support.activeStructures = summary.activeStructures.camp
    + summary.activeStructures.storehouse
    + summary.activeStructures.market
    + summary.activeStructures.workshop;
}

function settlementNeighborSupports(
  halo: readonly HexHaloTile[],
): Map<string, SettlementNeighborSupport> {
  const supportByRegion = new Map<string, SettlementNeighborSupport>();
  const resourceSummaryByRegion = new Map<
    string,
    HexHaloRegionSummary & { resourceCapacity: Record<ResourceKind, number> }
  >();
  const inconsistentResourceSummaryRegions = new Set<string>();
  const populationSummaryByRegion = new Map<string, HexHaloRegionSummary>();
  const inconsistentPopulationSummaryRegions = new Set<string>();
  const campSummaryByRegion = new Map<
    string,
    HexHaloRegionSummary & { activeStructures: NonNullable<HexHaloRegionSummary["activeStructures"]> }
  >();
  const inconsistentCampSummaryRegions = new Set<string>();
  const seenNeighborCells = new Set<string>();
  for (const entry of halo) {
    const regionSummary = entry.neighborRegionSummary;
    if (validRegionResourceSummary(regionSummary)) {
      const current = resourceSummaryByRegion.get(entry.neighborRegionId);
      if (current === undefined) {
        resourceSummaryByRegion.set(entry.neighborRegionId, regionSummary);
      } else if (!sameRegionResourceSummary(current, regionSummary)) {
        // Different edge reads may straddle a neighbor tick. Do not combine two
        // whole-region observations into a synthetic state; fall back to the
        // exact boundary sample for this planning pass.
        inconsistentResourceSummaryRegions.add(entry.neighborRegionId);
      }
    }
    if (validRegionPopulationSummary(regionSummary)) {
      const current = populationSummaryByRegion.get(entry.neighborRegionId);
      if (current === undefined) {
        populationSummaryByRegion.set(entry.neighborRegionId, regionSummary);
      } else if (!sameRegionPopulationSummary(current, regionSummary)) {
        // Population can change independently of resource totals across adjacent
        // edge reads. Avoid manufacturing a regional density from mixed ticks.
        inconsistentPopulationSummaryRegions.add(entry.neighborRegionId);
      }
    }
    if (validRegionCampSummary(regionSummary)) {
      const current = campSummaryByRegion.get(entry.neighborRegionId);
      if (current === undefined) {
        campSummaryByRegion.set(entry.neighborRegionId, regionSummary);
      } else if (!sameRegionCampSummary(current, regionSummary)) {
        // Structure completion can land between independent edge reads. Keep
        // mixed-tick service-footprint observations neutral for this plan.
        inconsistentCampSummaryRegions.add(entry.neighborRegionId);
      }
    }
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
  for (const [regionId, summary] of resourceSummaryByRegion) {
    if (inconsistentResourceSummaryRegions.has(regionId)) continue;
    const support = supportByRegion.get(regionId);
    if (support !== undefined) applyRegionResourceSummary(support, summary);
  }
  for (const [regionId, summary] of populationSummaryByRegion) {
    if (inconsistentPopulationSummaryRegions.has(regionId)) continue;
    const support = supportByRegion.get(regionId);
    if (support !== undefined) applyRegionPopulationSummary(support, summary);
  }
  for (const [regionId, summary] of campSummaryByRegion) {
    if (inconsistentCampSummaryRegions.has(regionId)) continue;
    const support = supportByRegion.get(regionId);
    if (support !== undefined) applyRegionCampSummary(support, summary);
  }
  return supportByRegion;
}

function localSettlementSupport(state: WorldState): SettlementNeighborSupport {
  const support = emptySettlementNeighborSupport();
  for (const tile of state.tiles) {
    if (!isHexGridCell(state, tile)) continue;
    addSettlementSupportTile(support, tile);
  }
  support.populationSampleCells = support.passableCells;
  support.occupants = state.agents.filter((agent) => agent.hp > 0).length;
  support.campSampleCells = support.passableCells;
  support.activeCamps = state.structures.filter((structure) =>
    structure.type === "camp" && structure.status === "active"
  ).length;
  support.structureSampleCells = support.passableCells;
  support.activeStructures = state.structures.filter((structure) =>
    structure.status === "active"
  ).length;
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

function averageErosionPressure(support: SettlementNeighborSupport): number {
  return support.erosionPressureSamples > 0
    ? support.erosionPressureTotal / support.erosionPressureSamples
    : 0;
}

function compareAverageErosionPressure(
  a: SettlementNeighborSupport,
  b: SettlementNeighborSupport,
): number {
  if (a.erosionPressureSamples === 0 || b.erosionPressureSamples === 0) return 0;
  const delta = averageErosionPressure(a) - averageErosionPressure(b);
  return Math.abs(delta) > SETTLEMENT_EROSION_EPSILON ? delta : 0;
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

function populationDensity(support: SettlementNeighborSupport): number {
  return support.populationSampleCells > 0
    ? support.occupants / support.populationSampleCells
    : 0;
}

function comparePopulationDensity(
  a: SettlementNeighborSupport,
  b: SettlementNeighborSupport,
): number {
  if (a.populationSampleCells === 0 || b.populationSampleCells === 0) return 0;
  const delta = populationDensity(a) - populationDensity(b);
  return Math.abs(delta) > SETTLEMENT_POPULATION_DENSITY_EPSILON ? delta : 0;
}

function campDensity(support: SettlementNeighborSupport): number {
  return support.campSampleCells > 0
    ? support.activeCamps / support.campSampleCells
    : 0;
}

function compareCampDensity(
  a: SettlementNeighborSupport,
  b: SettlementNeighborSupport,
): number {
  if (a.campSampleCells === 0 || b.campSampleCells === 0) return 0;
  const delta = campDensity(a) - campDensity(b);
  return Math.abs(delta) > SETTLEMENT_CAMP_DENSITY_EPSILON ? delta : 0;
}

function structureDensity(support: SettlementNeighborSupport): number {
  return support.structureSampleCells > 0
    ? support.activeStructures / support.structureSampleCells
    : 0;
}

function compareStructureDensity(
  a: SettlementNeighborSupport,
  b: SettlementNeighborSupport,
): number {
  if (a.structureSampleCells === 0 || b.structureSampleCells === 0) return 0;
  const delta = structureDensity(a) - structureDensity(b);
  return Math.abs(delta) > SETTLEMENT_STRUCTURE_DENSITY_EPSILON ? delta : 0;
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
  return support.resourceSampleCells > 0
    ? support.resourceCapacity[kind] / support.resourceSampleCells
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
  return support.resourceSampleCells > 0
    ? support.resources[kind] / support.resourceSampleCells
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

  if (candidate.erosionPressureSamples > 0 && local.erosionPressureSamples > 0) {
    const candidateErosion = averageErosionPressure(candidate);
    const localErosion = averageErosionPressure(local);
    if (candidateErosion < localErosion - SETTLEMENT_EROSION_EPSILON) return true;
    if (candidateErosion > localErosion + SETTLEMENT_EROSION_EPSILON) return false;
  }

  if (candidate.populationSampleCells > 0 && local.populationSampleCells > 0) {
    const candidatePopulation = populationDensity(candidate);
    const localPopulation = populationDensity(local);
    if (candidatePopulation < localPopulation - SETTLEMENT_POPULATION_DENSITY_EPSILON) return true;
    if (candidatePopulation > localPopulation + SETTLEMENT_POPULATION_DENSITY_EPSILON) return false;
  }

  if (candidate.campSampleCells > 0 && local.campSampleCells > 0) {
    const candidateCamps = campDensity(candidate);
    const localCamps = campDensity(local);
    if (candidateCamps < localCamps - SETTLEMENT_CAMP_DENSITY_EPSILON) return true;
    if (candidateCamps > localCamps + SETTLEMENT_CAMP_DENSITY_EPSILON) return false;
  }

  if (candidate.structureSampleCells > 0 && local.structureSampleCells > 0) {
    const candidateStructures = structureDensity(candidate);
    const localStructures = structureDensity(local);
    if (candidateStructures < localStructures - SETTLEMENT_STRUCTURE_DENSITY_EPSILON) return true;
    if (candidateStructures > localStructures + SETTLEMENT_STRUCTURE_DENSITY_EPSILON) return false;
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
    || compareAverageErosionPressure(a, b)
    || comparePopulationDensity(a, b)
    || compareCampDensity(a, b)
    || compareStructureDensity(a, b)
    || compareResourceAmountDensity(a, b, "food")
    || compareResourceAmountDensity(a, b, "wood")
    || compareResourceAmountDensity(a, b, "stone")
    || compareAverageDrainage(a, b)
    || compareSurfaceWaterFraction(a, b)
  );
}

function settlementRouteCost(candidate: SettlementSeamCandidate): number {
  return candidate.distance + candidate.pathCrowding;
}

function settlementStorageHeadroomPreference(headroom: number | undefined): number {
  if (headroom === undefined) return 1;
  return headroom > 0 ? 2 : 0;
}

function compareSettlementStorageHeadroom(
  a: number | undefined,
  b: number | undefined,
): number {
  const preferenceDelta = settlementStorageHeadroomPreference(b)
    - settlementStorageHeadroomPreference(a);
  if (preferenceDelta !== 0) return preferenceDelta;
  if (a === undefined || b === undefined) return 0;
  return b - a;
}

function compareFactionOccupancy(
  a: SettlementFactionOccupancy | undefined,
  b: SettlementFactionOccupancy | undefined,
): number {
  if (a === undefined || b === undefined) return 0;
  return a.foreign - b.foreign
    || Number(b.own > 0) - Number(a.own > 0);
}

function haloRegionFactionOccupancy(
  halo: readonly HexHaloTile[],
  neighborRegionId: string,
  factionId: string,
): SettlementFactionOccupancy | undefined {
  let observation: { occupants: number; counts: Record<string, number> } | undefined;
  for (const entry of halo) {
    if (entry.neighborRegionId !== neighborRegionId) continue;
    const summary = entry.neighborRegionSummary;
    const counts = summary?.occupantsByFaction;
    if (summary === undefined || counts === undefined) continue;
    if (!Number.isInteger(summary.occupants) || summary.occupants < 0) continue;
    const entries = Object.entries(counts);
    if (entries.some(([, count]) => !Number.isInteger(count) || count < 0)) continue;
    const summarized = entries.reduce((sum, [, count]) => sum + count, 0);
    if (summarized > summary.occupants) continue;
    if (observation !== undefined) {
      const previousEntries = Object.entries(observation.counts);
      if (
        observation.occupants !== summary.occupants
        || previousEntries.length !== entries.length
        || previousEntries.some(([id, count]) => counts[id] !== count)
      ) {
        return undefined;
      }
      continue;
    }
    observation = { occupants: summary.occupants, counts };
  }
  if (observation === undefined) return undefined;
  const own = observation.counts[factionId];
  const summarized = Object.values(observation.counts).reduce((sum, count) => sum + count, 0);
  if (own === undefined && summarized !== observation.occupants) return undefined;
  const ownCount = own ?? 0;
  return { own: ownCount, foreign: Math.max(0, observation.occupants - ownCount) };
}

function haloRegionFactionStorageHeadroom(
  halo: readonly HexHaloTile[],
  neighborRegionId: string,
  factionId: string,
): number | undefined {
  let minimumHeadroom: number | undefined;
  for (const entry of halo) {
    if (entry.neighborRegionId !== neighborRegionId) continue;
    const byFaction = entry.neighborRegionSummary?.storageHeadroomByFaction;
    if (byFaction === undefined || !Object.prototype.hasOwnProperty.call(byFaction, factionId)) continue;
    const headroom = byFaction[factionId];
    if (typeof headroom !== "number" || !Number.isFinite(headroom) || headroom < 0) continue;
    minimumHeadroom = minimumHeadroom === undefined
      ? headroom
      : Math.min(minimumHeadroom, headroom);
  }
  return minimumHeadroom;
}

function compareSettlementSeamCandidate(
  a: SettlementSeamCandidate,
  b: SettlementSeamCandidate,
): number {
  return (
    compareSettlementSupport(a.support, b.support)
    || compareFactionOccupancy(a.factionOccupancy, b.factionOccupancy)
    || compareSettlementStorageHeadroom(a.factionStorageHeadroom, b.factionStorageHeadroom)
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
    || compareFactionOccupancy(a.factionOccupancy, b.factionOccupancy)
    || compareSettlementStorageHeadroom(a.factionStorageHeadroom, b.factionStorageHeadroom)
    || settlementRouteCost(a) - settlementRouteCost(b)
    || a.distance - b.distance
    || a.pathCrowding - b.pathCrowding
    || a.crowding - b.crowding
    || a.familySeparationCost - b.familySeparationCost
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
  const population = state.agents.filter((agent) =>
    agent.factionId === factionId && agent.hp > 0
  ).length;
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

  // The ledger is an aggregate view; the transferable material itself
  // must exist in active structure storage before it can become carried
  // inventory. Requiring both prevents a pioneer kit from duplicating
  // wood/stone in rolling or legacy states where ledger > stored stock.
  const storages = activeFactionStructures(state, agent.factionId);
  return RESOURCE_KINDS.every((kind) =>
    faction.resources[kind] >= deficit[kind]
    && storages.reduce((sum, structure) => sum + structure.storage[kind], 0) >= deficit[kind]
  );
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
  if (hasLocalCamp || agent.settlementMigrationOriginRegionId === undefined) {
    agent.settlementMigrationOriginRegionId = state.regionId;
  }
  const deficit = campKitDeficit(agent);
  const storages = activeFactionStructures(state, agent.factionId)
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const kind of RESOURCE_KINDS) {
    let remaining = deficit[kind];
    for (const structure of storages) {
      const taken = Math.min(remaining, structure.storage[kind]);
      structure.storage[kind] -= taken;
      remaining -= taken;
      if (remaining === 0) break;
    }
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

function familySeparationCost(state: WorldState, agent: Agent): number {
  const livingSameFaction = new Set(
    state.agents
      .filter((relative) => relative.factionId === agent.factionId && relative.hp > 0)
      .map((relative) => relative.id),
  );
  let cost = 0;
  if (
    agent.pregnancy !== undefined
    && agent.pregnancy.dueAtTick > state.tick
    && livingSameFaction.has(agent.pregnancy.partnerId)
  ) {
    cost += 4;
  }
  for (const relative of state.agents) {
    if (
      relative.id === agent.id
      || relative.factionId !== agent.factionId
      || relative.hp <= 0
    ) {
      continue;
    }
    if (
      (relative.lifeStage === "infant" || relative.lifeStage === "juvenile")
      && relative.parents?.includes(agent.id)
    ) {
      const alternateLivingParent = relative.parents.some((parentId) =>
        parentId !== agent.id && livingSameFaction.has(parentId)
      );
      const activeCaregiver = dependentCaregiverId(state, relative) === agent.id;
      cost += relative.lifeStage === "infant"
        ? (alternateLivingParent ? (activeCaregiver ? 4 : 2) : 5)
        : (alternateLivingParent ? (activeCaregiver ? 2 : 1) : 3);
    }
    if (
      relative.pregnancy?.partnerId === agent.id
      && relative.pregnancy.dueAtTick > state.tick
    ) {
      cost += 4;
    }
  }
  return cost;
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
    if (occupant.hp <= 0) continue;
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
        factionStorageHeadroom: haloRegionFactionStorageHeadroom(
          halo,
          entry.neighborRegionId,
          agent.factionId,
        ),
        factionOccupancy: haloRegionFactionOccupancy(
          halo,
          entry.neighborRegionId,
          agent.factionId,
        ),
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
      familySeparationCost: familySeparationCost(state, agent),
      support: candidate.support,
      factionStorageHeadroom: candidate.factionStorageHeadroom,
      factionOccupancy: candidate.factionOccupancy,
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
