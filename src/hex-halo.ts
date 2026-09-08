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
 * This deliberately does not synthesize unconfigured neighbors: it fixes which
 * cells existing halo reads observe without increasing cross-DO fan-out.
 */
export function buildConfiguredHexHaloLinks(
  extent: HexGridExtent,
  regionIds: readonly string[],
  sourceRegionId: string,
): HexHaloLink[] {
  if (
    regionAxialCoordinate(sourceRegionId) === undefined ||
    regionIds.some((regionId) => regionAxialCoordinate(regionId) === undefined)
  ) {
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
  return links;
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
  const edgeIndex = new Map<string, Tile>();
  for (const edge of edgeSnapshots) {
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
