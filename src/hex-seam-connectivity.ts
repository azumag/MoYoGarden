import {
  HEX_GRID_DIRECTIONS,
  HEX_GRID_DIRECTION_STEPS,
  type HexGridDirection,
  type HexGridExtent,
  type HexGridPosition,
} from "./hex-grid.js";
import type { HexHaloEdgeSnapshot, HexHaloLink } from "./hex-halo.js";
import { regionCellTransition } from "./region-topology.js";

export interface HexSeamComponentRef {
  regionId: string;
  revision: number;
  tick: number;
  componentId: number;
}

export interface HexSeamComponentPort {
  regionId: string;
  position: HexGridPosition;
  stepDirection: HexGridDirection;
  snapshotDirection: HexGridDirection;
}

export interface HexSeamConnectivityEdge {
  a: HexSeamComponentRef;
  b: HexSeamComponentRef;
  aPort: HexSeamComponentPort;
  bPort: HexSeamComponentPort;
}

interface SnapshotBucket {
  revision: number;
  tick: number;
  snapshots: HexHaloEdgeSnapshot[];
}

function positionEquals(a: HexGridPosition, b: HexGridPosition): boolean {
  return a.x === b.x && a.y === b.y;
}

function snapshotKey(regionId: string, direction: HexGridDirection): string {
  return `${regionId}:${direction}`;
}

function versionIsNewer(
  revision: number,
  tick: number,
  current: SnapshotBucket,
): boolean {
  return revision > current.revision
    || (revision === current.revision && tick > current.tick);
}

function freshestSnapshotBuckets(
  snapshots: readonly HexHaloEdgeSnapshot[],
): Map<string, SnapshotBucket> {
  const buckets = new Map<string, SnapshotBucket>();
  for (const snapshot of snapshots) {
    if (
      !Number.isSafeInteger(snapshot.revision)
      || snapshot.revision < 0
      || !Number.isSafeInteger(snapshot.tick)
      || snapshot.tick < 0
    ) continue;
    const key = snapshotKey(snapshot.regionId, snapshot.direction);
    const current = buckets.get(key);
    if (current === undefined || versionIsNewer(snapshot.revision, snapshot.tick, current)) {
      buckets.set(key, {
        revision: snapshot.revision,
        tick: snapshot.tick,
        snapshots: [snapshot],
      });
      continue;
    }
    if (snapshot.revision === current.revision && snapshot.tick === current.tick) {
      current.snapshots.push(snapshot);
    }
  }
  return buckets;
}

function componentObservation(
  buckets: ReadonlyMap<string, SnapshotBucket>,
  regionId: string,
  direction: HexGridDirection,
  position: HexGridPosition,
): HexSeamComponentRef | undefined {
  const bucket = buckets.get(snapshotKey(regionId, direction));
  if (bucket === undefined) return undefined;

  let componentId: number | undefined;
  for (const snapshot of bucket.snapshots) {
    const matches = snapshot.tiles.filter((entry) => positionEquals(entry.position, position));
    if (matches.length !== 1) return undefined;
    const entry = matches[0];
    if (
      entry === undefined
      || entry.passableComponent === undefined
      || !Number.isSafeInteger(entry.passableComponent)
      || entry.passableComponent < 0
    ) {
      return undefined;
    }
    if (componentId === undefined) {
      componentId = entry.passableComponent;
    } else if (componentId !== entry.passableComponent) {
      return undefined;
    }
  }

  if (componentId === undefined) return undefined;
  return {
    regionId,
    revision: bucket.revision,
    tick: bucket.tick,
    componentId,
  };
}

function exactReverseStepDirection(
  extent: HexGridExtent,
  link: HexHaloLink,
): HexGridDirection | undefined {
  const forwardStep = HEX_GRID_DIRECTION_STEPS[link.direction];
  const forward = regionCellTransition(
    link.sourceRegionId,
    {
      x: link.sourcePosition.x + forwardStep.x,
      y: link.sourcePosition.y + forwardStep.y,
    },
    extent.width,
    extent.height,
  );
  if (
    forward === undefined
    || forward.targetRegionId !== link.neighborRegionId
    || !positionEquals(forward.targetPosition, link.neighborPosition)
  ) {
    return undefined;
  }

  const reverseMatches: Array<{
    stepDirection: HexGridDirection;
    macroDirection: HexGridDirection;
  }> = [];
  for (const stepDirection of HEX_GRID_DIRECTIONS) {
    const step = HEX_GRID_DIRECTION_STEPS[stepDirection];
    const reverse = regionCellTransition(
      link.neighborRegionId,
      {
        x: link.neighborPosition.x + step.x,
        y: link.neighborPosition.y + step.y,
      },
      extent.width,
      extent.height,
    );
    if (
      reverse !== undefined
      && reverse.targetRegionId === link.sourceRegionId
      && positionEquals(reverse.targetPosition, link.sourcePosition)
    ) {
      reverseMatches.push({
        stepDirection,
        macroDirection: reverse.direction,
      });
    }
  }

  if (reverseMatches.length !== 1) return undefined;
  const reverse = reverseMatches[0];
  if (reverse === undefined || reverse.macroDirection !== link.neighborDirection) return undefined;
  return reverse.stepDirection;
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

function canonicalEdge(
  source: HexSeamComponentRef,
  neighbor: HexSeamComponentRef,
  sourcePort: HexSeamComponentPort,
  neighborPort: HexSeamComponentPort,
): { key: string; seamKey: string; edge: HexSeamConnectivityEdge } {
  const sourceKey = componentRefKey(source);
  const neighborKey = componentRefKey(neighbor);
  if (sourceKey <= neighborKey) {
    const key = JSON.stringify([sourceKey, neighborKey]);
    return {
      key,
      seamKey: JSON.stringify([portKey(sourcePort), portKey(neighborPort)]),
      edge: { a: source, b: neighbor, aPort: sourcePort, bPort: neighborPort },
    };
  }
  const key = JSON.stringify([neighborKey, sourceKey]);
  return {
    key,
    seamKey: JSON.stringify([portKey(neighborPort), portKey(sourcePort)]),
    edge: { a: neighbor, b: source, aPort: neighborPort, bPort: sourcePort },
  };
}

/**
 * Build a pure, fail-closed graph between passable connected components on
 * exact reciprocal region seams.
 *
 * The graph deliberately consumes raw edge snapshots rather than materialized
 * halo tiles so component labels remain available without widening the hot
 * environment halo. Nodes include snapshot revision + tick, which prevents
 * component identity from being reused across incoherent edge observations.
 */
export function buildReciprocalHexSeamConnectivity(
  extent: HexGridExtent,
  links: readonly HexHaloLink[],
  snapshots: readonly HexHaloEdgeSnapshot[],
): HexSeamConnectivityEdge[] {
  const buckets = freshestSnapshotBuckets(snapshots);
  const edges = new Map<string, { seamKey: string; edge: HexSeamConnectivityEdge }>();

  for (const link of links) {
    const reverseStepDirection = exactReverseStepDirection(extent, link);
    if (reverseStepDirection === undefined) continue;

    const source = componentObservation(
      buckets,
      link.sourceRegionId,
      link.direction,
      link.sourcePosition,
    );
    if (source === undefined) continue;

    const neighbor = componentObservation(
      buckets,
      link.neighborRegionId,
      link.neighborDirection,
      link.neighborPosition,
    );
    if (neighbor === undefined) continue;

    const sourcePort: HexSeamComponentPort = {
      regionId: link.sourceRegionId,
      position: { ...link.sourcePosition },
      stepDirection: link.direction,
      snapshotDirection: link.direction,
    };
    const neighborPort: HexSeamComponentPort = {
      regionId: link.neighborRegionId,
      position: { ...link.neighborPosition },
      stepDirection: reverseStepDirection,
      snapshotDirection: link.neighborDirection,
    };

    const candidate = canonicalEdge(source, neighbor, sourcePort, neighborPort);
    const current = edges.get(candidate.key);
    if (current === undefined || candidate.seamKey < current.seamKey) {
      edges.set(candidate.key, {
        seamKey: candidate.seamKey,
        edge: candidate.edge,
      });
    }
  }

  return [...edges.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, entry]) => entry.edge);
}
