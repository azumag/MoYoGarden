import {
  HEX_GRID_DIRECTIONS,
  HEX_GRID_DIRECTION_STEPS,
  hexGridBoundaryCells,
  hexGridHandoffTarget,
  oppositeHexGridDirection,
  type HexGridDirection,
  type HexGridExtent,
  type HexGridPosition,
} from "./hex-grid.js";
import type { Tile } from "./protocol.js";
import {
  configuredRegionCellTransition,
  regionAxialCoordinate,
  regionCellTransition,
  regionHexWindow,
} from "./region-topology.js";

export interface HexHaloLink {
  sourceRegionId: string;
  sourcePosition: HexGridPosition;
  direction: HexGridDirection;
  neighborRegionId: string;
  neighborPosition: HexGridPosition;
  neighborDirection: HexGridDirection;
}

export interface HexHaloTile extends HexHaloLink {
  tile: Tile;
}

export interface HexHaloEdgeSnapshot {
  regionId: string;
  direction: HexGridDirection;
  revision: number;
  tick: number;
  tiles: Array<{ position: HexGridPosition; tile: Tile }>;
}

export function hexHaloKey(position: HexGridPosition, direction: HexGridDirection): string {
  return `${position.x},${position.y}:${direction}`;
}

/**
 * Legacy/configuration-oriented halo mapping. Unknown historical region IDs
 * still rely on the older side-to-side pairing until their axial identity is
 * migrated. Axial production IDs should prefer buildConfiguredHexHaloLinks.
 */
export function buildHexHaloLinks(
  extent: HexGridExtent,
  regionIds: readonly string[],
  sourceRegionId: string,
): HexHaloLink[] {
  const topology = regionHexWindow(regionIds, sourceRegionId, 1, extent.width, extent.height);
  const source = topology.find((entry) => entry.id === sourceRegionId);
  if (source === undefined) return [];

  const links: HexHaloLink[] = [];
  for (const direction of HEX_GRID_DIRECTIONS) {
    const neighborRegionId = source.neighbors[direction];
    if (neighborRegionId === null) continue;
    for (const sourcePosition of hexGridBoundaryCells(extent, direction)) {
      const neighborPosition = hexGridHandoffTarget(extent, sourcePosition, direction);
      if (neighborPosition === undefined) continue;
      links.push({
        sourceRegionId,
        sourcePosition,
        direction,
        neighborRegionId,
        neighborPosition,
        neighborDirection: oppositeHexGridDirection(direction),
      });
    }
  }
  return links;
}

/**
 * Build a configured-only halo using the shared global cell ownership frame.
 * Known axial neighbors stay on exact global ownership even when REGION_IDS
 * still contains an unresolved historical entry. Historical neighbors retain
 * the old side-pair mapping only for source-direction slots that exact axial
 * ownership did not already claim, so one compatibility ID cannot downgrade
 * water/vegetation/wind propagation between otherwise-migrated regions.
 */
export function buildConfiguredHexHaloLinks(
  extent: HexGridExtent,
  regionIds: readonly string[],
  sourceRegionId: string,
): HexHaloLink[] {
  if (regionAxialCoordinate(sourceRegionId) === undefined) {
    return buildHexHaloLinks(extent, regionIds, sourceRegionId);
  }
  const links: HexHaloLink[] = [];
  for (const direction of HEX_GRID_DIRECTIONS) {
    const step = HEX_GRID_DIRECTION_STEPS[direction];
    for (const sourcePosition of hexGridBoundaryCells(extent, direction)) {
      const desiredPosition = {
        x: sourcePosition.x + step.x,
        y: sourcePosition.y + step.y,
      };
      const transition = configuredRegionCellTransition(
        regionIds,
        sourceRegionId,
        desiredPosition,
        extent.width,
        extent.height,
      );
      if (transition === undefined) continue;
      links.push({
        sourceRegionId,
        sourcePosition,
        direction,
        neighborRegionId: transition.targetRegionId,
        neighborPosition: transition.targetPosition,
        neighborDirection: oppositeHexGridDirection(transition.direction),
      });
    }
  }

  if (!regionIds.some((regionId) => regionAxialCoordinate(regionId) === undefined)) {
    return links;
  }

  const exactKeys = new Set(
    links.map((link) => hexHaloKey(link.sourcePosition, link.direction)),
  );
  const historicalFallback = buildHexHaloLinks(extent, regionIds, sourceRegionId).filter(
    (link) =>
      regionAxialCoordinate(link.neighborRegionId) === undefined &&
      !exactKeys.has(hexHaloKey(link.sourcePosition, link.direction)),
  );
  return [...links, ...historicalFallback];
}

/**
 * Build a depth-1 halo for an axial region without requiring its neighbors to
 * be prelisted in REGION_IDS. Exact global cell ownership remains the source of
 * truth, while legacy garden aliases retain ownership of their persisted axial
 * coordinates. Unknown historical IDs deliberately produce no dynamic halo.
 */
export function buildDynamicHexHaloLinks(
  extent: HexGridExtent,
  sourceRegionId: string,
): HexHaloLink[] {
  if (regionAxialCoordinate(sourceRegionId) === undefined) return [];
  const links: HexHaloLink[] = [];
  for (const direction of HEX_GRID_DIRECTIONS) {
    const step = HEX_GRID_DIRECTION_STEPS[direction];
    for (const sourcePosition of hexGridBoundaryCells(extent, direction)) {
      const desiredPosition = {
        x: sourcePosition.x + step.x,
        y: sourcePosition.y + step.y,
      };
      const transition = regionCellTransition(
        sourceRegionId,
        desiredPosition,
        extent.width,
        extent.height,
      );
      if (transition === undefined) continue;
      links.push({
        sourceRegionId,
        sourcePosition,
        direction,
        neighborRegionId: transition.targetRegionId,
        neighborPosition: transition.targetPosition,
        neighborDirection: oppositeHexGridDirection(transition.direction),
      });
    }
  }
  return links;
}

export function boundaryDirectionForNeighbor(
  regionIds: readonly string[],
  sourceRegionId: string,
  neighborRegionId: string,
  width: number,
  height: number,
): { sourceDirection: HexGridDirection; neighborDirection: HexGridDirection } | undefined {
  const topology = regionHexWindow(regionIds, sourceRegionId, 1, width, height);
  const source = topology.find((entry) => entry.id === sourceRegionId);
  if (source === undefined) return undefined;
  const sourceDirection = HEX_GRID_DIRECTIONS.find(
    (direction) => source.neighbors[direction] === neighborRegionId,
  );
  if (sourceDirection === undefined) return undefined;
  return {
    sourceDirection,
    neighborDirection: oppositeHexGridDirection(sourceDirection),
  };
}

export function materializeHexHalo(
  links: readonly HexHaloLink[],
  edgeSnapshots: readonly HexHaloEdgeSnapshot[],
): HexHaloTile[] {
  // Retry/cache merges can surface more than one snapshot for the same edge.
  // Select one coherent freshest edge before indexing tiles so array order can
  // never let stale environmental state overwrite a newer revision.
  const latestEdges = new Map<string, HexHaloEdgeSnapshot>();
  for (const edge of edgeSnapshots) {
    const key = `${edge.regionId}:${edge.direction}`;
    const current = latestEdges.get(key);
    if (
      current === undefined ||
      edge.revision > current.revision ||
      (edge.revision === current.revision && edge.tick > current.tick)
    ) {
      latestEdges.set(key, edge);
    }
  }

  const edgeIndex = new Map<string, Tile>();
  for (const edge of latestEdges.values()) {
    for (const entry of edge.tiles) {
      // Edge snapshots are request-local, read-only inputs. Keep their tile
      // references while indexing and clone only when materializing a ghost
      // cell, avoiding two structured clones per halo tile on the hot path.
      edgeIndex.set(
        `${edge.regionId}:${edge.direction}:${entry.position.x},${entry.position.y}`,
        entry.tile,
      );
    }
  }
  return links.flatMap((link) => {
    const tile = edgeIndex.get(
      `${link.neighborRegionId}:${link.neighborDirection}:${link.neighborPosition.x},${link.neighborPosition.y}`,
    );
    if (tile === undefined) return [];
    return [{ ...structuredClone(link), tile: structuredClone(tile) }];
  });
}

export function hexHaloLookup(halo: readonly HexHaloTile[]): Map<string, HexHaloTile> {
  // Materialized ghost tiles are already detached from their edge snapshots.
  // Halo consumers treat the lookup as read-only, so indexing those ghosts by
  // reference avoids cloning the complete depth-1 halo again for every
  // environmental query while preserving source-snapshot isolation.
  return new Map(
    halo.map((entry) => [hexHaloKey(entry.sourcePosition, entry.direction), entry]),
  );
}
