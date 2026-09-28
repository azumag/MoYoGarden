import type {
  HexSeamComponentPort,
  HexSeamComponentRef,
  HexSeamConnectivityEdge,
} from "./hex-seam-connectivity.js";
import { hexDistance, regionAxialCoordinate } from "./region-topology.js";

export interface BoundedHexSeamRouteOptions {
  maxHops?: number;
  maxEdgeExpansions?: number;
}

export interface BoundedHexSeamRoutePlan {
  components: HexSeamComponentRef[];
  edges: HexSeamConnectivityEdge[];
  usedPlateauDetour: boolean;
  edgeExpansions: number;
}

interface AdjacencyEntry {
  next: HexSeamComponentRef;
  edge: HexSeamConnectivityEdge;
  sortKey: string;
}

interface SearchState {
  component: HexSeamComponentRef;
  components: HexSeamComponentRef[];
  edges: HexSeamConnectivityEdge[];
  usedPlateauDetour: boolean;
}

interface SearchResult {
  plan?: BoundedHexSeamRoutePlan;
  edgeExpansions: number;
}

const DEFAULT_MAX_HOPS = 6;
const DEFAULT_MAX_EDGE_EXPANSIONS = 128;

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validComponentRef(ref: HexSeamComponentRef): boolean {
  return typeof ref.regionId === "string"
    && ref.regionId.length > 0
    && isNonNegativeSafeInteger(ref.revision)
    && isNonNegativeSafeInteger(ref.tick)
    && isNonNegativeSafeInteger(ref.componentId);
}

function componentRefKey(ref: HexSeamComponentRef): string {
  return JSON.stringify([ref.regionId, ref.revision, ref.tick, ref.componentId]);
}

function portKey(port: HexSeamComponentPort): string {
  return JSON.stringify([
    port.regionId,
    port.position.x,
    port.position.y,
    port.stepDirection,
    port.snapshotDirection,
  ]);
}

function edgeSortKey(edge: HexSeamConnectivityEdge): string {
  const aKey = componentRefKey(edge.a);
  const bKey = componentRefKey(edge.b);
  if (aKey <= bKey) {
    return JSON.stringify([aKey, bKey, portKey(edge.aPort), portKey(edge.bPort)]);
  }
  return JSON.stringify([bKey, aKey, portKey(edge.bPort), portKey(edge.aPort)]);
}

function validEdge(edge: HexSeamConnectivityEdge): boolean {
  return validComponentRef(edge.a)
    && validComponentRef(edge.b)
    && edge.aPort.regionId === edge.a.regionId
    && edge.bPort.regionId === edge.b.regionId
    && Number.isSafeInteger(edge.aPort.position.x)
    && Number.isSafeInteger(edge.aPort.position.y)
    && Number.isSafeInteger(edge.bPort.position.x)
    && Number.isSafeInteger(edge.bPort.position.y);
}

function buildAdjacency(
  edges: readonly HexSeamConnectivityEdge[],
): Map<string, AdjacencyEntry[]> {
  const adjacency = new Map<string, AdjacencyEntry[]>();
  const append = (
    from: HexSeamComponentRef,
    next: HexSeamComponentRef,
    edge: HexSeamConnectivityEdge,
  ): void => {
    const key = componentRefKey(from);
    const entries = adjacency.get(key) ?? [];
    entries.push({
      next,
      edge,
      sortKey: JSON.stringify([componentRefKey(next), edgeSortKey(edge)]),
    });
    adjacency.set(key, entries);
  };

  for (const edge of edges) {
    if (!validEdge(edge)) continue;
    const aKey = componentRefKey(edge.a);
    const bKey = componentRefKey(edge.b);
    if (aKey === bKey) continue;
    append(edge.a, edge.b, edge);
    append(edge.b, edge.a, edge);
  }

  for (const entries of adjacency.values()) {
    entries.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  }
  return adjacency;
}

function distanceToTarget(
  regionId: string,
  targetRegionId: string,
): number | undefined {
  const region = regionAxialCoordinate(regionId);
  const target = regionAxialCoordinate(targetRegionId);
  if (region === undefined || target === undefined) return undefined;
  return hexDistance(region, target);
}

function boundedSearch(
  adjacency: ReadonlyMap<string, readonly AdjacencyEntry[]>,
  start: HexSeamComponentRef,
  targetRegionId: string,
  maxHops: number,
  edgeExpansionBudget: number,
  allowPlateau: boolean,
): SearchResult {
  const queue: SearchState[] = [{
    component: start,
    components: [start],
    edges: [],
    usedPlateauDetour: false,
  }];
  const visited = new Set<string>([componentRefKey(start)]);
  let edgeExpansions = 0;

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (current === undefined || current.edges.length >= maxHops) continue;

    const currentDistance = distanceToTarget(current.component.regionId, targetRegionId);
    for (const entry of adjacency.get(componentRefKey(current.component)) ?? []) {
      if (edgeExpansions >= edgeExpansionBudget) {
        return { edgeExpansions };
      }
      edgeExpansions += 1;

      const nextKey = componentRefKey(entry.next);
      if (visited.has(nextKey)) continue;

      let plateauStep = false;
      if (entry.next.regionId !== targetRegionId) {
        const nextDistance = distanceToTarget(entry.next.regionId, targetRegionId);
        if (currentDistance === undefined || nextDistance === undefined) continue;
        if (allowPlateau) {
          if (nextDistance > currentDistance) continue;
          plateauStep = nextDistance === currentDistance;
        } else if (nextDistance >= currentDistance) {
          continue;
        }
      }

      const components = [...current.components, entry.next];
      const routeEdges = [...current.edges, entry.edge];
      const usedPlateauDetour = current.usedPlateauDetour || plateauStep;
      if (entry.next.regionId === targetRegionId) {
        return {
          edgeExpansions,
          plan: {
            components,
            edges: routeEdges,
            usedPlateauDetour,
            edgeExpansions,
          },
        };
      }

      visited.add(nextKey);
      queue.push({
        component: entry.next,
        components,
        edges: routeEdges,
        usedPlateauDetour,
      });
    }
  }

  return { edgeExpansions };
}

/**
 * Plan a bounded route over reciprocal passable seam components.
 *
 * The first pass accepts only macro-region hops that strictly reduce hex
 * distance to the target. Only when that cannot produce a route does the
 * second pass permit equal-distance plateau hops. Distance-increasing hops are
 * never allowed. Exact component identity includes revision and tick, so
 * observations from different snapshots cannot be stitched into a route.
 *
 * This is deliberately a pure planning layer. It does not mutate WorldState,
 * perform Durable Object fan-out, or execute a handoff.
 */
export function planBoundedHexSeamComponentRoute(
  edges: readonly HexSeamConnectivityEdge[],
  start: HexSeamComponentRef,
  targetRegionId: string,
  options: BoundedHexSeamRouteOptions = {},
): BoundedHexSeamRoutePlan | undefined {
  if (!validComponentRef(start) || typeof targetRegionId !== "string" || targetRegionId.length === 0) {
    return undefined;
  }

  const maxHops = options.maxHops ?? DEFAULT_MAX_HOPS;
  const maxEdgeExpansions = options.maxEdgeExpansions ?? DEFAULT_MAX_EDGE_EXPANSIONS;
  if (
    !isNonNegativeSafeInteger(maxHops)
    || !isNonNegativeSafeInteger(maxEdgeExpansions)
  ) {
    return undefined;
  }

  if (start.regionId === targetRegionId) {
    return {
      components: [start],
      edges: [],
      usedPlateauDetour: false,
      edgeExpansions: 0,
    };
  }
  if (maxHops === 0 || maxEdgeExpansions === 0) return undefined;

  const adjacency = buildAdjacency(edges);
  const strict = boundedSearch(
    adjacency,
    start,
    targetRegionId,
    maxHops,
    maxEdgeExpansions,
    false,
  );
  if (strict.plan !== undefined) return strict.plan;

  const remainingBudget = maxEdgeExpansions - strict.edgeExpansions;
  if (remainingBudget <= 0) return undefined;

  const plateau = boundedSearch(
    adjacency,
    start,
    targetRegionId,
    maxHops,
    remainingBudget,
    true,
  );
  if (plateau.plan === undefined) return undefined;
  return {
    ...plateau.plan,
    edgeExpansions: strict.edgeExpansions + plateau.plan.edgeExpansions,
  };
}
