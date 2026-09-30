import type {
  HexSeamComponentRef,
  HexSeamConnectivityEdge,
} from "./hex-seam-connectivity.js";
import { regionAxialCoordinate } from "./region-topology.js";

export interface MaterialReturnRouteBudget {
  maxHops: number;
  maxExpandedEdges: number;
}

export type MaterialReturnRoutePlan =
  | {
      status: "planned";
      route: HexSeamComponentRef[];
      hops: number;
      equalDistanceHops: number;
      expandedEdges: number;
    }
  | {
      status: "noKnownRoute";
      expandedEdges: number;
    }
  | {
      status: "budgetExhausted";
      expandedEdges: number;
    };

interface RouteCandidate {
  node: HexSeamComponentRef;
  route: HexSeamComponentRef[];
  hops: number;
  equalDistanceHops: number;
  pathKey: string;
}

interface RouteCost {
  hops: number;
  equalDistanceHops: number;
  pathKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validComponentRef(value: unknown): value is HexSeamComponentRef {
  if (!isRecord(value)) return false;
  return typeof value.regionId === "string"
    && value.regionId.length > 0
    && Number.isSafeInteger(value.revision)
    && (value.revision as number) >= 0
    && Number.isSafeInteger(value.tick)
    && (value.tick as number) >= 0
    && Number.isSafeInteger(value.componentId)
    && (value.componentId as number) >= 0;
}

function cloneRef(ref: HexSeamComponentRef): HexSeamComponentRef {
  return {
    regionId: ref.regionId,
    revision: ref.revision,
    tick: ref.tick,
    componentId: ref.componentId,
  };
}

function componentKey(ref: HexSeamComponentRef): string {
  return JSON.stringify([ref.regionId, ref.revision, ref.tick, ref.componentId]);
}

function regionDistance(aRegionId: string, bRegionId: string): number | undefined {
  const a = regionAxialCoordinate(aRegionId);
  const b = regionAxialCoordinate(bRegionId);
  if (a === undefined || b === undefined) return undefined;
  const dq = a.q - b.q;
  const dr = a.r - b.r;
  return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
}

function compareDeterministicString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareCost(a: RouteCost, b: RouteCost): number {
  return a.equalDistanceHops - b.equalDistanceHops
    || a.hops - b.hops
    || compareDeterministicString(a.pathKey, b.pathKey);
}

function stepEqualDistance(
  currentRegionId: string,
  nextRegionId: string,
  targetRegionId: string,
): boolean | undefined {
  if (nextRegionId === targetRegionId) {
    const adjacency = regionDistance(currentRegionId, nextRegionId);
    // Keep the historical direct-to-source compatibility path for legacy IDs
    // that do not have an axial coordinate. Canonical observations must still
    // describe a real neighboring macro hex.
    return adjacency === undefined || adjacency === 1 ? false : undefined;
  }

  const adjacency = regionDistance(currentRegionId, nextRegionId);
  const currentDistance = regionDistance(currentRegionId, targetRegionId);
  const nextDistance = regionDistance(nextRegionId, targetRegionId);
  if (
    adjacency !== 1
    || currentDistance === undefined
    || nextDistance === undefined
    || nextDistance > currentDistance
  ) {
    return undefined;
  }
  return nextDistance === currentDistance;
}

function validBudget(budget: MaterialReturnRouteBudget): boolean {
  return Number.isSafeInteger(budget.maxHops)
    && budget.maxHops >= 0
    && Number.isSafeInteger(budget.maxExpandedEdges)
    && budget.maxExpandedEdges >= 0;
}

/**
 * Plan a bounded return route over already-observed reciprocal passable seam
 * connectivity.
 *
 * The planner is intentionally pure and does not query remote Durable Objects.
 * Exact component identity includes region/revision/tick/component, so separate
 * observations are never silently joined inside a region. Macro steps may make
 * strict progress or stay at the same target distance, but they may never move
 * farther away. Lexicographic cost makes a strict-progress route win whenever
 * one is known, while equal-distance detours remain available when needed.
 */
export function planMaterialReturnDetour(
  start: HexSeamComponentRef,
  targetRegionId: string,
  edges: readonly HexSeamConnectivityEdge[],
  budget: MaterialReturnRouteBudget,
): MaterialReturnRoutePlan {
  if (
    !validComponentRef(start)
    || typeof targetRegionId !== "string"
    || targetRegionId.length === 0
    || !validBudget(budget)
  ) {
    return { status: "noKnownRoute", expandedEdges: 0 };
  }

  const startRef = cloneRef(start);
  if (startRef.regionId === targetRegionId) {
    return {
      status: "planned",
      route: [startRef],
      hops: 0,
      equalDistanceHops: 0,
      expandedEdges: 0,
    };
  }

  const adjacency = new Map<string, Map<string, HexSeamComponentRef>>();
  const nodeRefs = new Map<string, HexSeamComponentRef>([
    [componentKey(startRef), startRef],
  ]);

  const addNeighbor = (from: HexSeamComponentRef, to: HexSeamComponentRef): void => {
    const fromKey = componentKey(from);
    const toKey = componentKey(to);
    nodeRefs.set(fromKey, cloneRef(from));
    nodeRefs.set(toKey, cloneRef(to));
    const neighbors = adjacency.get(fromKey) ?? new Map<string, HexSeamComponentRef>();
    neighbors.set(toKey, cloneRef(to));
    adjacency.set(fromKey, neighbors);
  };

  for (const candidate of edges as readonly unknown[]) {
    if (!isRecord(candidate) || !validComponentRef(candidate.a) || !validComponentRef(candidate.b)) {
      continue;
    }
    if (candidate.a.regionId === candidate.b.regionId) continue;
    addNeighbor(candidate.a, candidate.b);
    addNeighbor(candidate.b, candidate.a);
  }

  const startKey = componentKey(startRef);
  const frontier: RouteCandidate[] = [{
    node: startRef,
    route: [startRef],
    hops: 0,
    equalDistanceHops: 0,
    pathKey: startKey,
  }];
  const best = new Map<string, RouteCost>([
    [startKey, { hops: 0, equalDistanceHops: 0, pathKey: startKey }],
  ]);

  let expandedEdges = 0;
  let hopBudgetHit = false;

  while (frontier.length > 0) {
    frontier.sort(compareCost);
    const current = frontier.shift();
    if (current === undefined) break;

    if (current.node.regionId === targetRegionId) {
      return {
        status: "planned",
        route: current.route.map(cloneRef),
        hops: current.hops,
        equalDistanceHops: current.equalDistanceHops,
        expandedEdges,
      };
    }

    const currentKey = componentKey(current.node);
    const neighbors = [...(adjacency.get(currentKey)?.values() ?? [])]
      .sort((a, b) => compareDeterministicString(componentKey(a), componentKey(b)));

    if (current.hops >= budget.maxHops) {
      for (const neighbor of neighbors) {
        const equalDistance = stepEqualDistance(
          current.node.regionId,
          neighbor.regionId,
          targetRegionId,
        );
        if (equalDistance === undefined) continue;

        const neighborKey = componentKey(neighbor);
        const candidate: RouteCost = {
          hops: current.hops + 1,
          equalDistanceHops: current.equalDistanceHops + (equalDistance ? 1 : 0),
          pathKey: `${current.pathKey}\u0000${neighborKey}`,
        };
        const previous = best.get(neighborKey);
        if (previous === undefined || compareCost(candidate, previous) < 0) {
          hopBudgetHit = true;
          break;
        }
      }
      continue;
    }

    for (const neighbor of neighbors) {
      if (expandedEdges >= budget.maxExpandedEdges) {
        return { status: "budgetExhausted", expandedEdges };
      }
      expandedEdges += 1;

      const equalDistance = stepEqualDistance(
        current.node.regionId,
        neighbor.regionId,
        targetRegionId,
      );
      if (equalDistance === undefined) continue;

      const neighborKey = componentKey(neighbor);
      const next: RouteCandidate = {
        node: cloneRef(neighbor),
        route: [...current.route.map(cloneRef), cloneRef(neighbor)],
        hops: current.hops + 1,
        equalDistanceHops: current.equalDistanceHops + (equalDistance ? 1 : 0),
        pathKey: `${current.pathKey}\u0000${neighborKey}`,
      };
      const previous = best.get(neighborKey);
      if (previous !== undefined && compareCost(next, previous) >= 0) continue;
      best.set(neighborKey, {
        hops: next.hops,
        equalDistanceHops: next.equalDistanceHops,
        pathKey: next.pathKey,
      });
      frontier.push(next);
    }
  }

  return {
    status: hopBudgetHit ? "budgetExhausted" : "noKnownRoute",
    expandedEdges,
  };
}
