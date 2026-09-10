import { createRandom } from "./prng.js";
import {
  HEX_GRID_DIRECTIONS,
  HEX_GRID_DIRECTION_STEPS,
  hexGridDistance,
  oppositeHexGridDirection,
  type HexGridDirection,
} from "./hex-grid.js";
import { hexHaloKey, hexHaloLookup, type HexHaloTile } from "./hex-halo.js";
import {
  manhattanDistance,
  positionKey,
  type GridPosition,
  type ResourceKind,
  type Tile,
  type WorldState,
} from "./protocol.js";
import { drainageAt, resourceRegrowthChance } from "./simulation.js";
import { regionCellTransition, regionGlobalCellOrigin } from "./region-topology.js";
import { sampleWorldWind } from "./world-scale.js";
import { getTile } from "./world.js";

const WATER_MOISTURE_RADIUS = 4;
const HALO_ORGANIC_PROPAGULE_BONUS: Readonly<Record<Exclude<ResourceKind, "stone">, number>> = {
  wood: 0.05,
  food: 0.04,
};
const HALO_UPWIND_PROPAGULE_GAIN = 0.35;
const HALO_UPWIND_WATER_VAPOR_GAIN = 0.08;
const HALO_HYDROLOGY_EPSILON = 1e-6;
const HALO_RUNOFF_SLOPE_SCALE = 0.18;

type HaloLookup = ReturnType<typeof hexHaloLookup>;

export interface HaloEnvironmentFrame {
  worldSeed: number;
  originX: number;
  originY: number;
}

export interface HaloFlowOutlet {
  direction: HexGridDirection;
  neighborRegionId: string;
  neighborPosition: GridPosition;
  elevation: number;
  drop: number;
  slope: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function tileElevation(tile: Tile | undefined): number | undefined {
  const elevation = tile?.elevation;
  return Number.isFinite(elevation ?? Number.NaN) ? elevation : undefined;
}

interface HaloFlowReceiverCandidate {
  drop: number;
  elevation: number;
  position: GridPosition;
}

function preferHaloFlowReceiver(
  candidate: HaloFlowReceiverCandidate,
  current: HaloFlowReceiverCandidate | undefined,
): boolean {
  if (current === undefined) return true;
  if (candidate.drop > current.drop + HALO_HYDROLOGY_EPSILON) return true;
  if (candidate.drop < current.drop - HALO_HYDROLOGY_EPSILON) return false;
  if (candidate.elevation < current.elevation - HALO_HYDROLOGY_EPSILON) return true;
  if (candidate.elevation > current.elevation + HALO_HYDROLOGY_EPSILON) return false;
  return candidate.position.y < current.position.y ||
    (candidate.position.y === current.position.y && candidate.position.x < current.position.x);
}

interface HaloCornerRunoffOwner {
  regionId: string;
  targetPosition: GridPosition;
}

/**
 * Give a boundary catchment that touches multiple macro regions one stable
 * transient owner before any passive cross-DO runoff is accepted.
 *
 * A corner source cell can have downhill neighbors in two different Durable
 * Objects. Without a shared arbitration rule, each receiver independently sees
 * the same ghost drainage and both can accept it, creating water. Persisted
 * cross-DO flow ownership is not available yet, so use the exact global-cell
 * frame to choose one geometry-stable receiving region, reusing the existing
 * local seam position tie-break so equal-slope behavior stays compatible. Within
 * that owner, the slope/elevation comparator still chooses the receiving cell.
 *
 * The rule is deliberately conservative: if the elected owner has no downhill
 * candidate, runoff stays with the source instead of being duplicated elsewhere.
 */
function haloCornerRunoffOwner(
  sourceRegionId: string,
  sourcePosition: GridPosition,
  width: number,
  height: number,
): HaloCornerRunoffOwner | undefined {
  if (regionGlobalCellOrigin(sourceRegionId, width, height) === undefined) return undefined;

  let owner: HaloCornerRunoffOwner | undefined;
  const regions = new Set<string>();
  for (const direction of HEX_GRID_DIRECTIONS) {
    const step = HEX_GRID_DIRECTION_STEPS[direction];
    const desiredPosition = {
      x: sourcePosition.x + step.x,
      y: sourcePosition.y + step.y,
    };
    const transition = regionCellTransition(
      sourceRegionId,
      desiredPosition,
      width,
      height,
    );
    if (transition === undefined) continue;
    regions.add(transition.targetRegionId);
    const targetPosition = transition.targetPosition;
    if (
      owner === undefined ||
      targetPosition.y < owner.targetPosition.y ||
      (targetPosition.y === owner.targetPosition.y && targetPosition.x < owner.targetPosition.x) ||
      (
        targetPosition.y === owner.targetPosition.y &&
        targetPosition.x === owner.targetPosition.x &&
        transition.targetRegionId < owner.regionId
      )
    ) {
      owner = { regionId: transition.targetRegionId, targetPosition: { ...targetPosition } };
    }
  }

  return regions.size > 1 ? owner : undefined;
}

function usesExactGlobalHaloAdjacency(
  receiverRegionId: string,
  receiverPosition: GridPosition,
  sourceRegionId: string,
  sourcePosition: GridPosition,
  width: number,
  height: number,
): boolean {
  const receiverOrigin = regionGlobalCellOrigin(receiverRegionId, width, height);
  const sourceOrigin = regionGlobalCellOrigin(sourceRegionId, width, height);
  if (receiverOrigin === undefined || sourceOrigin === undefined) return false;
  const dx = sourceOrigin.x + sourcePosition.x - (receiverOrigin.x + receiverPosition.x);
  const dy = sourceOrigin.y + sourcePosition.y - (receiverOrigin.y + receiverPosition.y);
  return HEX_GRID_DIRECTIONS.some((direction) => {
    const step = HEX_GRID_DIRECTION_STEPS[direction];
    return step.x === dx && step.y === dy;
  });
}

function haloWaterInfluence(
  state: Pick<WorldState, "regionId" | "width" | "height">,
  position: GridPosition,
  lookup: HaloLookup,
): number {
  const sourceOrigin = regionGlobalCellOrigin(state.regionId, state.width, state.height);
  const sourceGlobal = sourceOrigin === undefined
    ? undefined
    : {
      x: sourceOrigin.x + position.x,
      y: sourceOrigin.y + position.y,
    };
  let influence = 0;
  for (const ghost of lookup.values()) {
    if (ghost.tile.terrain !== "water") continue;
    // Axial-aware dynamic halo links share an exact global cell frame. Measure
    // the target directly against the ghost only when the link itself is an
    // exact cross-region adjacency; legacy side-pair links retain the existing
    // depth-1 compatibility distance until their topology is fully migrated.
    const neighborOrigin = regionGlobalCellOrigin(
      ghost.neighborRegionId,
      state.width,
      state.height,
    );
    const exactAdjacency = sourceGlobal !== undefined &&
      neighborOrigin !== undefined &&
      usesExactGlobalHaloAdjacency(
        state.regionId,
        ghost.sourcePosition,
        ghost.neighborRegionId,
        ghost.neighborPosition,
        state.width,
        state.height,
      );
    const distance = exactAdjacency
      ? hexGridDistance(sourceGlobal, {
        x: neighborOrigin.x + ghost.neighborPosition.x,
        y: neighborOrigin.y + ghost.neighborPosition.y,
      })
      : manhattanDistance(position, ghost.sourcePosition) + 1;
    if (distance > WATER_MOISTURE_RADIUS) continue;
    influence = Math.max(
      influence,
      (WATER_MOISTURE_RADIUS + 1 - distance) / WATER_MOISTURE_RADIUS,
    );
  }
  return influence;
}

function upwindWaterVaporMoisture(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  position: GridPosition,
  lookup: HaloLookup,
  environment?: HaloEnvironmentFrame,
): number {
  if (environment === undefined) return 0;
  const wind = sampleWorldWind(
    environment.worldSeed,
    environment.originX + position.x,
    environment.originY + position.y,
  );
  const upwindDirection = oppositeHexGridDirection(wind.direction);
  const ghost = lookup.get(hexHaloKey(position, upwindDirection));
  const step = HEX_GRID_DIRECTION_STEPS[upwindDirection];
  const local = ghost === undefined
    ? getTile(state, { x: position.x + step.x, y: position.y + step.y })
    : undefined;
  if ((ghost?.tile ?? local)?.terrain !== "water") return 0;

  // Preserve the isotropic distance-one water influence, then add the same
  // directional vapor term whether the upwind source is a local hex or the
  // exact ghost owner across a macro-region seam. A real halo link remains
  // authoritative over the rectangular storage-envelope compatibility cell.
  return wind.strength * HALO_UPWIND_WATER_VAPOR_GAIN;
}

function neighboringPropaguleInfluence(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  position: GridPosition,
  resourceKind: Exclude<ResourceKind, "stone">,
  lookup: HaloLookup,
  environment?: HaloEnvironmentFrame,
): number {
  let influence = 0;
  const wind = environment === undefined
    ? undefined
    : sampleWorldWind(
      environment.worldSeed,
      environment.originX + position.x,
      environment.originY + position.y,
    );
  const upwindDirection = wind === undefined
    ? undefined
    : oppositeHexGridDirection(wind.direction);

  for (const direction of HEX_GRID_DIRECTIONS) {
    // A halo link means this direction crosses the active macro-hex boundary.
    // Prefer that exact ghost owner over the rectangular storage-envelope cell;
    // otherwise use the ordinary local six-neighbor tile. This makes seed and
    // propagule pressure continuous across a region seam instead of giving the
    // same biomass different behavior merely because it lives in another DO.
    const ghost = lookup.get(hexHaloKey(position, direction));
    const step = HEX_GRID_DIRECTION_STEPS[direction];
    const local = ghost === undefined
      ? getTile(state, { x: position.x + step.x, y: position.y + step.y })
      : undefined;
    const resource = (ghost?.tile ?? local)?.resource;
    if (resource?.kind !== resourceKind || resource.maxAmount <= 0) continue;
    let cover = clamp01(resource.amount / resource.maxAmount);
    if (direction === upwindDirection && wind !== undefined) {
      // Preserve the isotropic seed pressure as the baseline, then let the
      // shared world wind add a small directional advantage to biomass that is
      // actually upwind. Local and cross-region sources use the same rule.
      cover = clamp01(cover * (1 + wind.strength * HALO_UPWIND_PROPAGULE_GAIN));
    }
    // Independent neighboring stands provide additional seed/propagule sources.
    // Combine them as a bounded union so extra directions matter without ever
    // exceeding the existing normalized influence scale.
    influence = 1 - (1 - influence) * (1 - cover);
  }
  return clamp01(influence);
}

/**
 * Resolve a read-only cross-region outlet for a local boundary sink.
 *
 * Local flowTo remains authoritative. Only a land tile that has no local target
 * may consider a lower ghost tile, so this cannot steal or rewrite an existing
 * in-region path. The strongest downhill ghost becomes a transient candidate;
 * no neighbor Durable Object state is mutated and no cross-DO ownership is
 * persisted yet.
 */
function haloFlowOutletFromLookup(
  state: Pick<WorldState, "regionId" | "width" | "height" | "tiles">,
  position: GridPosition,
  lookup: HaloLookup,
): HaloFlowOutlet | undefined {
  const tile = getTile(state, position);
  const elevation = tileElevation(tile);
  if (
    tile === undefined ||
    tile.terrain === "water" ||
    tile.flowTo !== undefined ||
    elevation === undefined
  ) {
    return undefined;
  }

  const cornerOwner = haloCornerRunoffOwner(
    state.regionId,
    position,
    state.width,
    state.height,
  );
  let best: HaloFlowOutlet | undefined;
  for (const direction of HEX_GRID_DIRECTIONS) {
    const ghost = lookup.get(hexHaloKey(position, direction));
    if (ghost === undefined) continue;
    if (
      cornerOwner !== undefined &&
      usesExactGlobalHaloAdjacency(
        state.regionId,
        position,
        ghost.neighborRegionId,
        ghost.neighborPosition,
        state.width,
        state.height,
      ) &&
      ghost.neighborRegionId !== cornerOwner.regionId
    ) {
      continue;
    }
    const ghostElevation = tileElevation(ghost.tile);
    if (ghostElevation === undefined) continue;
    const drop = elevation - ghostElevation;
    if (drop <= HALO_HYDROLOGY_EPSILON) continue;
    if (!preferHaloFlowReceiver(
      { drop, elevation: ghostElevation, position: ghost.neighborPosition },
      best === undefined
        ? undefined
        : { drop: best.drop, elevation: best.elevation, position: best.neighborPosition },
    )) {
      continue;
    }
    best = {
      direction,
      neighborRegionId: ghost.neighborRegionId,
      neighborPosition: { ...ghost.neighborPosition },
      elevation: ghostElevation,
      drop,
      slope: clamp01(drop / HALO_RUNOFF_SLOPE_SCALE),
    };
  }
  return best;
}

export function haloFlowOutletAt(
  state: Pick<WorldState, "regionId" | "width" | "height" | "tiles">,
  position: GridPosition,
  halo: readonly HexHaloTile[] = [],
): HaloFlowOutlet | undefined {
  return haloFlowOutletFromLookup(state, position, hexHaloLookup(halo));
}

/**
 * Recover the first conservative piece of cross-region catchment continuity.
 * A ghost boundary tile with no local flowTo is a sink only because its region
 * could not see across the Durable Object boundary. If the paired local cell is
 * lower, treat the ghost tile's already-computed drainage as passive runoff
 * entering this cell. Ghost tiles that already drain locally are left alone so
 * we do not redirect or double-count an established local flow path.
 *
 * One unresolved ghost sink can be adjacent to multiple local boundary cells at
 * a slanted seam. Give that catchment to exactly one steepest downhill receiver,
 * matching local flowTargetAt semantics and preventing duplicated runoff. Truly
 * distinct ghost sinks may still accumulate at one local cell. Drainage remains
 * normalized to [0,1], preserving the existing moisture scale.
 */
function haloDrainageInflowMapFromLookup(
  state: Pick<WorldState, "regionId" | "width" | "height" | "tiles">,
  lookup: HaloLookup,
): Map<string, number> {
  const bestByGhost = new Map<string, {
    sourcePosition: GridPosition;
    localElevation: number;
    drop: number;
    drainage: number;
  }>();

  for (const ghost of lookup.values()) {
    if (ghost.tile.terrain === "water" || ghost.tile.flowTo !== undefined) continue;
    const cornerOwner = usesExactGlobalHaloAdjacency(
      state.regionId,
      ghost.sourcePosition,
      ghost.neighborRegionId,
      ghost.neighborPosition,
      state.width,
      state.height,
    )
      ? haloCornerRunoffOwner(
        ghost.neighborRegionId,
        ghost.neighborPosition,
        state.width,
        state.height,
      )
      : undefined;
    if (cornerOwner !== undefined && cornerOwner.regionId !== state.regionId) continue;
    const tile = getTile(state, ghost.sourcePosition);
    const localElevation = tileElevation(tile);
    const ghostElevation = tileElevation(ghost.tile);
    const ghostDrainage = Number.isFinite(ghost.tile.drainage ?? Number.NaN)
      ? clamp01(ghost.tile.drainage ?? 0)
      : 0;
    if (
      tile === undefined ||
      tile.terrain === "water" ||
      localElevation === undefined ||
      ghostElevation === undefined ||
      ghostDrainage <= 0
    ) {
      continue;
    }
    const drop = ghostElevation - localElevation;
    if (drop <= HALO_HYDROLOGY_EPSILON) continue;

    const ghostKey = `${ghost.neighborRegionId}:${positionKey(ghost.neighborPosition)}`;
    const current = bestByGhost.get(ghostKey);
    if (!preferHaloFlowReceiver(
      { drop, elevation: localElevation, position: ghost.sourcePosition },
      current === undefined
        ? undefined
        : {
          drop: current.drop,
          elevation: current.localElevation,
          position: current.sourcePosition,
        },
    )) {
      continue;
    }
    bestByGhost.set(ghostKey, {
      sourcePosition: { ...ghost.sourcePosition },
      localElevation,
      drop,
      drainage: ghostDrainage,
    });
  }

  const inflow = new Map<string, number>();
  for (const candidate of bestByGhost.values()) {
    const key = positionKey(candidate.sourcePosition);
    const slope = clamp01(candidate.drop / HALO_RUNOFF_SLOPE_SCALE);
    inflow.set(key, clamp01((inflow.get(key) ?? 0) + candidate.drainage * slope));
  }
  return inflow;
}

function haloDrainageInflowFromLookup(
  state: Pick<WorldState, "regionId" | "width" | "height" | "tiles">,
  position: GridPosition,
  lookup: HaloLookup,
): number {
  return haloDrainageInflowMapFromLookup(state, lookup).get(positionKey(position)) ?? 0;
}

export function haloDrainageInflowAt(
  state: Pick<WorldState, "regionId" | "width" | "height" | "tiles">,
  position: GridPosition,
  halo: readonly HexHaloTile[] = [],
): number {
  return haloDrainageInflowFromLookup(state, position, hexHaloLookup(halo));
}

/**
 * Propagate passive cross-region catchment input through the existing local
 * flow graph without persisting any cross-DO flow target. Direct halo inflow is
 * injected at boundary cells, then carried downhill only along already-owned
 * local flowTo edges. This lets upstream catchment mass influence downstream
 * moisture inside the receiving region while keeping ownership unchanged.
 */
function haloCatchmentContributionMapFromLookup(
  state: Pick<WorldState, "regionId" | "width" | "height" | "tiles">,
  lookup: HaloLookup,
): Map<string, number> {
  const contribution = new Map<string, number>();
  if (lookup.size === 0) return contribution;

  const directInflow = haloDrainageInflowMapFromLookup(state, lookup);
  for (const [key, inflow] of directInflow) {
    if (inflow > 0) contribution.set(key, inflow);
  }

  const ordered = [...state.tiles].sort((a, b) =>
    (tileElevation(b) ?? 0) - (tileElevation(a) ?? 0) ||
    a.y - b.y ||
    a.x - b.x
  );
  for (const tile of ordered) {
    if (tile.terrain === "water" || tile.flowTo === undefined) continue;
    const sourceContribution = contribution.get(positionKey(tile)) ?? 0;
    if (sourceContribution <= 0) continue;

    const sourceElevation = tileElevation(tile);
    const target = getTile(state, tile.flowTo);
    const targetElevation = tileElevation(target);
    if (
      sourceElevation === undefined ||
      target === undefined ||
      target.terrain === "water" ||
      targetElevation === undefined ||
      sourceElevation - targetElevation <= HALO_HYDROLOGY_EPSILON
    ) {
      continue;
    }

    const targetKey = positionKey(target);
    contribution.set(
      targetKey,
      clamp01((contribution.get(targetKey) ?? 0) + sourceContribution),
    );
  }

  return contribution;
}

export function haloCatchmentContributionAt(
  state: Pick<WorldState, "regionId" | "width" | "height" | "tiles">,
  position: GridPosition,
  halo: readonly HexHaloTile[] = [],
): number {
  const lookup = hexHaloLookup(halo);
  return haloCatchmentContributionMapFromLookup(state, lookup).get(positionKey(position)) ?? 0;
}

function surfaceMoistureWithHaloLookup(
  state: Pick<WorldState, "regionId" | "width" | "height" | "tiles">,
  position: GridPosition,
  lookup: HaloLookup,
  catchmentContribution?: ReadonlyMap<string, number>,
  environment?: HaloEnvironmentFrame,
): number {
  const tile = getTile(state, position);
  if (tile === undefined) return 0;
  if (tile.terrain === "water") return 1;

  let waterInfluence = 0;
  for (let dy = -WATER_MOISTURE_RADIUS; dy <= WATER_MOISTURE_RADIUS; dy += 1) {
    for (let dx = -WATER_MOISTURE_RADIUS; dx <= WATER_MOISTURE_RADIUS; dx += 1) {
      const distance = manhattanDistance({ x: 0, y: 0 }, { x: dx, y: dy });
      if (distance === 0 || distance > WATER_MOISTURE_RADIUS) continue;
      const neighbor = getTile(state, { x: position.x + dx, y: position.y + dy });
      if (neighbor?.terrain !== "water") continue;
      waterInfluence = Math.max(
        waterInfluence,
        (WATER_MOISTURE_RADIUS + 1 - distance) / WATER_MOISTURE_RADIUS,
      );
    }
  }

  waterInfluence = Math.max(waterInfluence, haloWaterInfluence(state, position, lookup));
  const windborneMoisture = upwindWaterVaporMoisture(state, position, lookup, environment);
  const vegetationCover =
    tile.resource?.kind === "wood" && tile.resource.maxAmount > 0
      ? tile.resource.amount / tile.resource.maxAmount
      : 0;
  const elevation = Number.isFinite(tile.elevation ?? Number.NaN) ? tile.elevation ?? 0.5 : 0.5;
  const lowlandRetention = (1 - elevation) * 0.09;
  // Local catchment and cross-region tributaries are distinct upstream
  // contributions. Halo input is propagated through the receiving region's
  // existing local flow graph, while a read-only halo outlet lets a boundary
  // sink release a slope-weighted share instead of retaining it all locally.
  const outlet = haloFlowOutletFromLookup(state, position, lookup);
  const haloCatchment = (
    catchmentContribution ?? haloCatchmentContributionMapFromLookup(state, lookup)
  ).get(positionKey(position)) ?? 0;
  const runoff = clamp01(
    (drainageAt(state, position) + haloCatchment) *
      (1 - (outlet?.slope ?? 0)),
  );
  const runoffRetention = runoff * 0.14;
  return Math.min(
    1,
    0.04 + lowlandRetention + runoffRetention + waterInfluence * 0.64 +
      vegetationCover * 0.16 + windborneMoisture,
  );
}

export function surfaceMoistureWithHaloAt(
  state: Pick<WorldState, "regionId" | "width" | "height" | "tiles">,
  position: GridPosition,
  halo: readonly HexHaloTile[] = [],
  environment?: HaloEnvironmentFrame,
): number {
  const lookup = hexHaloLookup(halo);
  const catchmentContribution = haloCatchmentContributionMapFromLookup(state, lookup);
  return surfaceMoistureWithHaloLookup(
    state,
    position,
    lookup,
    catchmentContribution,
    environment,
  );
}

function resourceRegrowthChanceWithHaloLookup(
  state: WorldState,
  tile: Tile,
  lookup: HaloLookup,
  catchmentContribution?: ReadonlyMap<string, number>,
  environment?: HaloEnvironmentFrame,
): number {
  if (tile.resource === undefined || tile.resource.kind === "stone") return 0.18;
  const moisture = surfaceMoistureWithHaloLookup(
    state,
    tile,
    lookup,
    catchmentContribution,
    environment,
  );
  const propaguleInfluence = neighboringPropaguleInfluence(
    state,
    tile,
    tile.resource.kind,
    lookup,
    environment,
  );
  const propaguleBonus = propaguleInfluence * HALO_ORGANIC_PROPAGULE_BONUS[tile.resource.kind];
  return tile.resource.kind === "wood"
    ? Math.min(0.32, 0.08 + moisture * 0.22 + propaguleBonus)
    : Math.min(0.34, 0.06 + moisture * 0.26 + propaguleBonus);
}

export function resourceRegrowthChanceWithHalo(
  state: WorldState,
  tile: Tile,
  halo: readonly HexHaloTile[] = [],
  environment?: HaloEnvironmentFrame,
): number {
  const lookup = hexHaloLookup(halo);
  const catchmentContribution = haloCatchmentContributionMapFromLookup(state, lookup);
  return resourceRegrowthChanceWithHaloLookup(
    state,
    tile,
    lookup,
    catchmentContribution,
    environment,
  );
}

/**
 * The core simulation has already performed its ordinary local regrowth draw.
 * If neighboring local/ghost biomass or halo water raises p0 to p1, a second
 * draw with probability `(p1-p0)/(1-p0)` conditioned on the first draw having
 * failed produces the exact combined probability p1 without allowing two growth
 * increments in the same tick. The before/after snapshots tell us whether the
 * base draw already succeeded.
 */
export function applyHaloRegrowthCompensation(
  before: WorldState,
  after: WorldState,
  halo: readonly HexHaloTile[],
  interval = 30,
  environment?: HaloEnvironmentFrame,
): number {
  if (interval <= 0 || after.tick === 0 || after.tick % interval !== 0) {
    return 0;
  }

  const beforeTiles = new Map(before.tiles.map((tile) => [`${tile.x},${tile.y}`, tile]));
  const lookup = hexHaloLookup(halo);
  const catchmentContribution = haloCatchmentContributionMapFromLookup(after, lookup);
  const random = createRandom(after.rngState);
  let grown = 0;

  for (const tile of after.tiles) {
    if (
      tile.resource === undefined ||
      tile.resource.kind === "stone" ||
      tile.resource.amount >= tile.resource.maxAmount
    ) {
      continue;
    }
    const previous = beforeTiles.get(`${tile.x},${tile.y}`);
    if (
      previous?.resource?.kind !== tile.resource.kind ||
      previous.resource.amount !== tile.resource.amount
    ) {
      // The core simulation already grew or otherwise changed this resource.
      continue;
    }

    const localChance = resourceRegrowthChance(after, tile);
    const haloChance = resourceRegrowthChanceWithHaloLookup(
      after,
      tile,
      lookup,
      catchmentContribution,
      environment,
    );
    if (haloChance <= localChance) continue;
    const conditional = clamp01((haloChance - localChance) / Math.max(1e-9, 1 - localChance));
    if (random.next() < conditional) {
      tile.resource.amount += 1;
      grown += 1;
    }
  }

  after.rngState = random.state();
  return grown;
}

export function haloWaterDirectionsAt(
  position: GridPosition,
  halo: readonly HexHaloTile[],
): HexGridDirection[] {
  const lookup = hexHaloLookup(halo);
  return HEX_GRID_DIRECTIONS.filter(
    (direction) => lookup.get(hexHaloKey(position, direction))?.tile.terrain === "water",
  );
}
