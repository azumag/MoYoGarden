import {
  HEX_GRID_DIRECTIONS,
  hexGridBoundaryCells,
  hexGridHandoffTarget,
  oppositeHexGridDirection,
  type HexGridDirection,
  type HexGridExtent,
  type HexGridPosition,
} from "./hex-grid.js";
import type { Tile } from "./protocol.js";
import { regionHexWindow } from "./region-topology.js";

export interface HexHaloLink {
  sourceRegionId: string;
  sourcePosition: HexGridPosition;
  direction: HexGridDirection;
  neighborRegionId: string;
  neighborPosition: HexGridPosition;
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
      edgeIndex.set(
        `${edge.regionId}:${edge.direction}:${entry.position.x},${entry.position.y}`,
        structuredClone(entry.tile),
      );
    }
  }

  return links.flatMap((link) => {
    const neighborDirection = oppositeHexGridDirection(link.direction);
    const tile = edgeIndex.get(
      `${link.neighborRegionId}:${neighborDirection}:${link.neighborPosition.x},${link.neighborPosition.y}`,
    );
    if (tile === undefined) return [];
    return [{ ...structuredClone(link), tile: structuredClone(tile) }];
  });
}

export function hexHaloLookup(halo: readonly HexHaloTile[]): Map<string, HexHaloTile> {
  return new Map(
    halo.map((entry) => [hexHaloKey(entry.sourcePosition, entry.direction), structuredClone(entry)]),
  );
}
