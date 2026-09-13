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
import { getAgent, getFaction, isPassable } from "./world.js";

const RESIDENT_CAPACITY_PER_CAMP = 6;
const CAMP_MIN_SPACING = 2;
const CAMP_LOCAL_BUILD_RADIUS = 5;
const LOW_ENERGY_THRESHOLD = 18;
const SETTLEMENT_DRAINAGE_EPSILON = 1e-6;
const SETTLEMENT_PATHOGEN_EPSILON = 1e-6;
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
  if (resource.maxAmount > 0) {
    support.resourceCapacity[resource.kind] += resource.maxAmount;
  }
  if (resource.amount > 0) {
    support.resources[resource.kind] += resource.amount;
  }
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
  // The 40x24 storage envelope retains inactive compatibility corners that are
  // intentionally water. They are not part of the 397-cell simulation hex and
  // must not make every local region look water-supported to migration logic.
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
  // Persisted legacy halo tiles may not have drainage backfilled yet. Treat
  // unknown as neutral rather than dry so migration decisions do not shift just
  // because one edge has newer environmental metadata than another.
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
  // Rolling deploys and old persisted tiles can lack pathogenReservoir entirely.
  // Do not mistake missing metadata for a clean frontier; only compare disease
  // pressure when both candidate regions actually expose reservoir samples.
  if (a.pathogenReservoirSamples === 0 || b.pathogenReservoirSamples === 0) return 0;
  const delta = averagePathogenReservoir(a) - averagePathogenReservoir(b);
  return Math.abs(delta) > SETTLEMENT_PATHOGEN_EPSILON ? delta : 0;
}

function settlementContinuationRank(support: SettlementNeighborSupport): number {
  // Founding material is already carried in the camp kit. A transit pioneer
  // should only take another hop when the low-level support signal strictly
  // improves, otherwise equal-quality neighbors could ping-pong forever.
  //
  // Food remains the strongest carrying-capacity signal, followed by wood and
  // stone. Visible surface water is the weakest bit: it can break a tie between
  // equally resourced regions, but it can never outweigh losing a renewable
  // resource class. Because the score must strictly increase, multi-hop travel
  // is still bounded without adding visited-region state to WorldState.
  return (support.resourceCapacity.food > 0 ? 8 : 0)
    + (support.resourceCapacity.wood > 0 ? 4 : 0)
    + (support.resourceCapacity.stone > 0 ? 2 : 0)
    + (support.waterCells > 0 ? 1 : 0);
}

function shouldContinueSettlementMigration(
  candidate: SettlementNeighborSupport,
  local: SettlementNeighborSupport,
): boolean {
  const candidateRank = settlementContinuationRank(candidate);
  const localRank = settlementContinuationRank(local);
  if (candidateRank !== localRank) return candidateRank > localRank;

  // Keep the old anti-ping-pong rule for equal carrying-capacity classes, but
  // allow a transit pioneer to keep moving along an observed disease gradient.
  // This is monotonic for a static snapshot: equal-rank hops are permitted only
  // when both regions expose reservoir samples and the next region is strictly
  // cleaner. Missing rollout metadata remains neutral, so an unknown region is
  // never treated as safer than the current one.
  if (candidate.pathogenReservoirSamples === 0 || local.pathogenReservoirSamples === 0) {
    return false;
  }
  return averagePathogenReservoir(candidate)
    < averagePathogenReservoir(local) - SETTLEMENT_PATHOGEN_EPSILON;
}

function compareSettlementSupport(
  a: SettlementNeighborSupport,
  b: SettlementNeighborSupport,
): number {
  // A pioneer should favor long-lived carrying capacity over a transiently full
  // deposit. maxAmount is already the low-level regeneration/storage ceiling on
  // a resource tile, so it gives settlement choice a sustainable signal without
  // inventing a biome or issuing deeper cross-DO reads. Once durable capacity is
  // equal, prefer lower observed environmental pathogen burden before transient
  // stock levels. This reuses the same persisted low-level reservoir that drives
  // infection simulation, so settlement pressure and disease ecology share one
  // causal state instead of adding a scripted hazard category. When those are
  // equal, hydrology, open surface water, and passable edge area break ties.
  return (
    resourceDiversity(b) - resourceDiversity(a)
    || b.resourceCapacity.food - a.resourceCapacity.food
    || b.resourceCapacity.wood - a.resourceCapacity.wood
    || b.resourceCapacity.stone - a.resourceCapacity.stone
    || compareAveragePathogenReservoir(a, b)
    || b.resources.food - a.resources.food
    || b.resources.wood - a.resources.wood
    || b.resources.stone - a.resources.stone
    || compareAverageDrainage(a, b)
    || b.waterCells - a.waterCells
    || b.passableCells - a.passableCells
  );
}

function compareSettlementSeamCandidate(
  a: SettlementSeamCandidate,
  b: SettlementSeamCandidate,
): number {
  return (
    compareSettlementSupport(a.support, b.support)
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
    || a.distance - b.distance
    || a.pathCrowding - b.pathCrowding
    || a.crowding - b.crowding
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
      // Equal-distance crowding improvements are re-queued so descendants also
      // inherit the least crowded among their shortest paths. Distance remains
      // the primary cost, so crowding never makes a pioneer take a longer route.
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
    // Local growth may extend from any existing camp. Restricting this radius to
    // the lexicographically first camp makes later settlement nodes invisible and
    // can falsely convert ordinary local expansion into cross-region migration.
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

function isTransitPioneer(state: WorldState, agent: Agent): boolean {
  if (!eligiblePioneer(agent)) return false;
  if (state.structures.some((structure) =>
    structure.factionId === agent.factionId
    && structure.type === "camp"
    && (structure.status === "active" || structure.status === "building")
  )) {
    // An in-progress camp is already a real settlement commitment: the carried
    // kit can be used by the existing local build resolver. Treating this region
    // as transit-only would make the pioneer leave before it can assist the camp.
    return false;
  }
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

export function shouldScoutSettlementMigration(state: WorldState): boolean {
  // A pioneer that has already crossed a region must decide settle-vs-continue
  // before the normal simulation resolves its target-less camp build locally.
  // Do this on the first target-side Alarm rather than waiting for the ordinary
  // 12-tick population-pressure cadence.
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