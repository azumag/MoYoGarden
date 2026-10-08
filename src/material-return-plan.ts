import {
  HEX_GRID_DIRECTIONS,
  type HexGridDirection,
  type HexGridExtent,
  type HexGridPosition,
} from "./hex-grid.js";
import type { HexHaloEdgeSnapshot, HexHaloLink } from "./hex-halo.js";
import {
  buildReciprocalHexSeamConnectivity,
  type HexSeamComponentRef,
  type HexSeamConnectivityEdge,
} from "./hex-seam-connectivity.js";
import {
  planMaterialReturnDetour,
  type MaterialReturnRouteBudget,
  type MaterialReturnRoutePlan,
} from "./material-return-route.js";

/**
 * Bounded, fail-closed decision for returning carried material to its original
 * region storage across hex region boundaries.
 *
 * The planner (`planMaterialReturnDetour`) only knows about already-observed
 * reciprocal passable-seam connectivity. What the runtime additionally needs
 * before promoting a multi-region return route is a positive physical
 * reachability proof at the far end: the component the courier would enter at
 * the target region must be one that region itself reported as able to receive
 * stored material for that faction.
 *
 * Everything here is pure and request-local. No Durable Object is queried, no
 * runtime state is mutated, and no topology is invented: a missing observation
 * yields a fail-closed status instead of a guessed seam. The route is not
 * persisted; callers are expected to re-observe after each single hop, so only
 * the first crossing (`nextHop`) is resolved here.
 */
export interface MaterialReturnRouteRequest {
  extent: HexGridExtent;
  links: readonly HexHaloLink[];
  snapshots: readonly HexHaloEdgeSnapshot[];
  start: HexSeamComponentRef;
  targetRegionId: string;
  factionId: string;
  budget: MaterialReturnRouteBudget;
}

/**
 * The single next crossing the courier must perform. `position` is the local
 * boundary cell of the start region and `direction` is the local hex step that
 * crosses the seam there; `toRegionId` is the exact global-ownership owner the
 * crossing lands in.
 */
export interface MaterialReturnNextHop {
  fromRegionId: string;
  toRegionId: string;
  position: HexGridPosition;
  direction: HexGridDirection;
}

export type MaterialReturnRouteDecision =
  | {
      status: "planned";
      route: HexSeamComponentRef[];
      hops: number;
      equalDistanceHops: number;
      expandedEdges: number;
      /**
       * Component at the target region that the courier enters, positively
       * proven reachable for `factionId` by the target region's own observation.
       */
      storageComponentId: number;
      /** Absent only when the courier already starts inside the target region. */
      nextHop?: MaterialReturnNextHop;
    }
  | { status: "noKnownRoute"; expandedEdges: number }
  | { status: "budgetExhausted"; expandedEdges: number }
  | { status: "noStorageProof"; expandedEdges: number };

type UnplannedMaterialReturnRoute = Exclude<MaterialReturnRoutePlan, { status: "planned" }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validComponentRef(value: unknown): value is HexSeamComponentRef {
  if (!isRecord(value)) return false;
  return typeof value.regionId === "string"
    && value.regionId.length > 0
    && isSafeNonNegativeInteger(value.revision)
    && isSafeNonNegativeInteger(value.tick)
    && isSafeNonNegativeInteger(value.componentId);
}

function validExtent(value: unknown): value is HexGridExtent {
  if (!isRecord(value)) return false;
  return isSafeNonNegativeInteger(value.width)
    && (value.width as number) > 0
    && isSafeNonNegativeInteger(value.height)
    && (value.height as number) > 0;
}

function validFactionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function componentKey(ref: HexSeamComponentRef): string {
  return JSON.stringify([ref.regionId, ref.revision, ref.tick, ref.componentId]);
}

/**
 * Positive membership only. A missing faction, a truncated top-N map, or a
 * malformed entry all mean "unknown", never "unreachable"; they simply cannot
 * prove reachability, so the caller must fail closed. The observation must be
 * the target region's own snapshot at the exact generation of the arrival
 * component, otherwise component labels could belong to a different tick.
 */
function storageReachabilityProof(
  snapshots: readonly HexHaloEdgeSnapshot[],
  arrival: HexSeamComponentRef,
  factionId: string,
): number | undefined {
  for (const candidate of snapshots as readonly unknown[]) {
    if (!isRecord(candidate)) continue;
    if (candidate.regionId !== arrival.regionId) continue;
    if (candidate.revision !== arrival.revision || candidate.tick !== arrival.tick) continue;

    const summary = candidate.regionSummary;
    if (!isRecord(summary)) continue;
    const byFaction = summary.storageComponentsByFaction;
    if (!isRecord(byFaction)) continue;
    if (!Object.prototype.hasOwnProperty.call(byFaction, factionId)) continue;

    const componentIds = byFaction[factionId];
    if (!Array.isArray(componentIds)) continue;
    if (!componentIds.every(isSafeNonNegativeInteger)) continue;
    if (!componentIds.includes(arrival.componentId)) continue;

    return arrival.componentId;
  }
  return undefined;
}

function nextHopForRoute(
  edges: readonly HexSeamConnectivityEdge[],
  from: HexSeamComponentRef,
  to: HexSeamComponentRef,
): MaterialReturnNextHop | undefined {
  const fromKey = componentKey(from);
  const toKey = componentKey(to);
  for (const edge of edges) {
    const aKey = componentKey(edge.a);
    const bKey = componentKey(edge.b);
    const port = aKey === fromKey && bKey === toKey
      ? edge.aPort
      : bKey === fromKey && aKey === toKey
        ? edge.bPort
        : undefined;
    if (port === undefined) continue;
    // The canonical edge keeps each port on its own component's region, so a
    // mismatch here means incoherent input rather than a usable crossing.
    if (port.regionId !== from.regionId) return undefined;
    const { x, y } = port.position;
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return undefined;
    if (!(HEX_GRID_DIRECTIONS as readonly string[]).includes(port.stepDirection)) return undefined;
    return {
      fromRegionId: from.regionId,
      toRegionId: to.regionId,
      position: { x, y },
      direction: port.stepDirection,
    };
  }
  return undefined;
}

function fromPlanner(plan: UnplannedMaterialReturnRoute): MaterialReturnRouteDecision {
  return { status: plan.status, expandedEdges: plan.expandedEdges };
}

/**
 * Upper bound on how many unproven target components the resolver will exclude
 * before giving up. A region exposes at most six hex neighbors, and the number
 * of distinct passable components an arrival can land in is bounded by the
 * region's own component count, so this keeps the search small while remaining
 * fail-closed: an unproven component is dropped, never guessed.
 */
const MAX_ARRIVAL_PROOF_ATTEMPTS = 6;

/**
 * Resolve one bounded material-return crossing from raw edge observations.
 *
 * Strict-progress hops are preferred by the underlying planner, so an
 * equal-distance detour is only ever selected when no strictly progressing
 * route is known from the same observations. When the cheapest arrival lands in
 * a target component that cannot be positively proven reachable, that observed
 * component is excluded and the planner is re-run, so a blocked or
 * storage-less direct seam does not hide an already-proven detour.
 */
export function planMaterialReturnRoute(
  request: MaterialReturnRouteRequest,
): MaterialReturnRouteDecision {
  const { extent, links, snapshots, start, targetRegionId, factionId, budget } = request;

  if (
    !validComponentRef(start)
    || !validExtent(extent)
    || !validFactionId(factionId)
    || typeof targetRegionId !== "string"
    || targetRegionId.length === 0
    || !Array.isArray(links)
    || !Array.isArray(snapshots)
  ) {
    return { status: "noKnownRoute", expandedEdges: 0 };
  }

  let usableEdges = buildReciprocalHexSeamConnectivity(extent, links, snapshots);
  let expandedEdges = 0;
  let plannedAny = false;

  for (let attempt = 0; attempt < MAX_ARRIVAL_PROOF_ATTEMPTS; attempt += 1) {
    const plan = planMaterialReturnDetour(start, targetRegionId, usableEdges, budget);
    if (plan.status !== "planned") {
      // No route was ever plannable: report the planner's own verdict. Once a
      // route *was* plannable, a later failure only means the remaining
      // candidates could not be probed, which is still "no storage proof".
      return plannedAny
        ? { status: "noStorageProof", expandedEdges: expandedEdges + plan.expandedEdges }
        : fromPlanner(plan);
    }
    plannedAny = true;
    expandedEdges += plan.expandedEdges;

    const route = plan.route;
    const origin = route[0];
    const arrival = route[route.length - 1];
    if (
      origin === undefined
      || arrival === undefined
      || componentKey(origin) !== componentKey(start)
      || arrival.regionId !== targetRegionId
    ) {
      return { status: "noKnownRoute", expandedEdges };
    }

    const storageComponentId = storageReachabilityProof(snapshots, arrival, factionId);
    if (storageComponentId !== undefined) {
      if (plan.hops === 0) {
        return {
          status: "planned",
          route,
          hops: plan.hops,
          equalDistanceHops: plan.equalDistanceHops,
          expandedEdges,
          storageComponentId,
        };
      }
      const second = route[1];
      if (second === undefined) {
        return { status: "noKnownRoute", expandedEdges };
      }
      const nextHop = nextHopForRoute(usableEdges, start, second);
      if (nextHop === undefined || nextHop.toRegionId !== second.regionId) {
        // The planner only expands edges it actually observed, so a missing or
        // mismatched port means the observation set is incoherent. Never invent
        // a crossing direction: report no known route instead.
        return { status: "noKnownRoute", expandedEdges };
      }
      return {
        status: "planned",
        route,
        hops: plan.hops,
        equalDistanceHops: plan.equalDistanceHops,
        expandedEdges,
        storageComponentId,
        nextHop,
      };
    }

    // The cheapest route enters a target component that cannot be proven
    // reachable. Drop just that observed component and let the planner pick the
    // next-cheapest route from the same observations.
    const rejected = componentKey(arrival);
    const filtered = usableEdges.filter(
      (edge) => componentKey(edge.a) !== rejected && componentKey(edge.b) !== rejected,
    );
    if (filtered.length === usableEdges.length) break;
    usableEdges = filtered;
  }

  return { status: "noStorageProof", expandedEdges };
}

