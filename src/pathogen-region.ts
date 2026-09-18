import { RegionDurableObject as AutonomyRegionDurableObject } from "./autonomy-region.js";
import {
  buildConfiguredHexHaloLinks,
  buildDynamicHexHaloLinks,
  type HexHaloLink,
} from "./hex-halo.js";
import {
  HEX_GRID_DIRECTIONS,
  hexGridCenter,
  hexGridDistance,
  hexGridRadius,
  isHexGridCell,
  type HexGridDirection,
} from "./hex-grid.js";
import {
  agentPathogenLoad,
  applyPathogenTickRange,
  PATHOGEN_HALO_INTERVAL,
  PATHOGEN_LOCAL_INTERVAL,
  pathogenEdgeSnapshot,
  pathogenHaloMaps,
  pathogenReservoirOutboundIntents,
  pathogenStepCount,
  tilePathogenReservoir,
  type PathogenEdgeSnapshot,
  type PathogenEnvironmentFrame,
  type PathogenReservoirOutboundIntent,
} from "./pathogen.js";
import { positionKey, type GridPosition, type WorldState } from "./protocol.js";
import { regionCellTransition, regionGlobalCellOrigin } from "./region-topology.js";
import { WorldRuntime } from "./runtime.js";

interface PathogenEnv {
  REGIONS: DurableObjectNamespace<RegionDurableObject>;
  ASSETS: Fetcher;
  DEFAULT_REGION_ID?: string;
  REGION_IDS?: string;
  WORLD_SEED?: string;
  TICK_MS?: string;
  OPEN_COMMANDS?: string;
  COMMAND_TOKEN?: string;
  ADMIN_TOKEN?: string;
}

interface RuntimeAccess {
  runtime: WorldRuntime;
  persist(): Promise<void>;
  broadcastSnapshot(): void;
}

export interface PathogenHaloEdgeRequest {
  regionId: string;
  direction: HexGridDirection;
  positions: GridPosition[];
}

interface MaterializedPathogenHalo {
  pressure: Map<string, number>;
  reservoir: Map<string, number>;
  pressureExposure: Map<string, number>;
  reservoirExposure: Map<string, number>;
}

interface OutgoingPathogenReservoirTransfer {
  transferId: string;
  routeKey: string;
  fromRegionId: string;
  toRegionId: string;
  sourcePosition: GridPosition;
  desiredPosition: GridPosition;
  targetPosition: GridPosition;
  burden: number;
  createdAtTick: number;
}

interface IncomingPathogenReservoirRoute {
  routeKey: string;
  fromRegionId: string;
  sourcePosition: GridPosition;
  targetPosition: GridPosition;
  lastAcceptedTick: number;
  pendingBurden: number;
}

interface StoredPathogenRegion {
  state: WorldState;
  [key: string]: unknown;
}

const INTERNAL_PATHOGEN_EDGE_PATH = "/api/internal/pathogen/edge";
const INTERNAL_PATHOGEN_RESERVOIR_TRANSFER_PATH = "/api/internal/pathogen/reservoir/transfer";
const OUTGOING_PATHOGEN_RESERVOIR_KEY = "pathogen:reservoir:outgoing:v1";
const INCOMING_PATHOGEN_RESERVOIR_KEY = "pathogen:reservoir:incoming:v1";
const PATHOGEN_RESERVOIR_TRANSFER_EPSILON = 1e-4;
const DEFAULT_WORLD_SEED = 424_242;
export const PATHOGEN_EDGE_READ_TIMEOUT_MS = 5_000;
export const PATHOGEN_RESERVOIR_TRANSFER_ATTEMPT_BUDGET = 6;

/**
 * Keep cross-DO reservoir delivery work bounded without starving an old route.
 *
 * Retry and newly-created transfer phases use this selector independently, so
 * an outage backlog cannot consume the budget reserved for transfers created by
 * the current pathogen cadence. Sorting gives deterministic ordering and the
 * tick-derived offset rotates the retry window across a persistent backlog.
 */
export function selectPathogenReservoirAttemptIds(
  records: readonly { transferId: string }[],
  tick: number,
  limit = PATHOGEN_RESERVOIR_TRANSFER_ATTEMPT_BUDGET,
): string[] {
  const budget = Math.max(0, Math.floor(limit));
  if (budget === 0 || records.length === 0) return [];
  const pending = [...new Set(records.map((record) => record.transferId))]
    .sort((a, b) => a.localeCompare(b));
  if (pending.length <= budget) return pending;
  const normalizedTick = Number.isSafeInteger(tick) ? Math.max(0, Math.floor(tick)) : 0;
  const offset = normalizedTick % pending.length;
  return Array.from(
    { length: budget },
    (_entry, index) => pending[(offset + index) % pending.length]!,
  );
}


/**
 * Keep one unavailable neighbor from pinning a pathogen Alarm indefinitely.
 *
 * The caller supplies the operation so tests can exercise the deadline without
 * constructing a Durable Object stub. Aborting the signal also gives a real
 * stub.fetch() a chance to cancel its HTTP-style request, while Promise.race
 * guarantees the local region can fail-soft even if a test double ignores it.
 */
export async function withPathogenEdgeDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = PATHOGEN_EDGE_READ_TIMEOUT_MS,
): Promise<T> {
  const boundedTimeout = Math.max(1, Math.min(60_000, Math.floor(timeoutMs)));
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`pathogen edge read exceeded ${boundedTimeout}ms`);
      error.name = "TimeoutError";
      controller.abort(error);
      reject(error);
    }, boundedTimeout);
  });
  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Bound both the neighbor fetch and consumption of its response body.
 *
 * A Durable Object fetch can resolve after headers while the JSON body remains
 * stalled. Keeping response.json() inside the same deadline prevents that second
 * phase from pinning the local Alarm after the transport itself has completed.
 */
export async function readPathogenEdgeJsonWithDeadline(
  operation: (signal: AbortSignal) => Promise<Response>,
  timeoutMs = PATHOGEN_EDGE_READ_TIMEOUT_MS,
): Promise<unknown | undefined> {
  return withPathogenEdgeDeadline(async (signal) => {
    const response = await operation(signal);
    if (!response.ok) return undefined;
    return await response.json() as unknown;
  }, timeoutMs);
}

function runtimeAccess(instance: RegionDurableObject): RuntimeAccess {
  return instance as unknown as RuntimeAccess;
}

function configuredRegionIds(env: PathogenEnv): string[] {
  const configured = env.REGION_IDS ?? env.DEFAULT_REGION_ID ?? "garden-1";
  const regions = configured
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^[a-z0-9][a-z0-9-]{0,47}$/.test(entry));
  return regions.length > 0 ? [...new Set(regions)] : ["garden-1"];
}

function worldSeedValue(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 0x7fff_ffff
    ? parsed
    : DEFAULT_WORLD_SEED;
}

function directionValue(value: string | null): HexGridDirection | undefined {
  return value !== null && HEX_GRID_DIRECTIONS.includes(value as HexGridDirection)
    ? value as HexGridDirection
    : undefined;
}

function requestedPathogenEdgeCells(values: readonly string[]): Set<string> | undefined | null {
  if (values.length === 0) return undefined;
  const result = new Set<string>();
  for (const value of values) {
    const match = /^(-?\d+),(-?\d+)$/.exec(value);
    if (match === null) return null;
    const xText = match[1];
    const yText = match[2];
    if (xText === undefined || yText === undefined) return null;
    const x = Number.parseInt(xText, 10);
    const y = Number.parseInt(yText, 10);
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return null;
    result.add(positionKey({ x, y }));
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function gridPositionValue(value: unknown): GridPosition | undefined {
  if (!isRecord(value)) return undefined;
  const x = Number(value.x);
  const y = Number(value.y);
  return Number.isSafeInteger(x) && Number.isSafeInteger(y) ? { x, y } : undefined;
}

function samePosition(a: GridPosition, b: GridPosition): boolean {
  return a.x === b.x && a.y === b.y;
}

function pathogenReservoirRouteKey(
  fromRegionId: string,
  sourcePosition: GridPosition,
  toRegionId: string,
  targetPosition: GridPosition,
): string {
  return `${fromRegionId}:${positionKey(sourcePosition)}>${toRegionId}:${positionKey(targetPosition)}`;
}

function pathogenReservoirTransferValue(value: unknown): OutgoingPathogenReservoirTransfer | undefined {
  if (!isRecord(value)) return undefined;
  const sourcePosition = gridPositionValue(value.sourcePosition);
  const desiredPosition = gridPositionValue(value.desiredPosition);
  const targetPosition = gridPositionValue(value.targetPosition);
  if (
    typeof value.transferId !== "string" || value.transferId.length === 0 || value.transferId.length > 256 ||
    typeof value.fromRegionId !== "string" ||
    typeof value.toRegionId !== "string" ||
    sourcePosition === undefined || desiredPosition === undefined || targetPosition === undefined ||
    typeof value.burden !== "number" || !Number.isFinite(value.burden) ||
    value.burden <= PATHOGEN_RESERVOIR_TRANSFER_EPSILON || value.burden > 1 ||
    !Number.isSafeInteger(value.createdAtTick) || Number(value.createdAtTick) < 0
  ) return undefined;
  const createdAtTick = Number(value.createdAtTick);
  const routeKey = pathogenReservoirRouteKey(
    value.fromRegionId,
    sourcePosition,
    value.toRegionId,
    targetPosition,
  );
  return {
    transferId: value.transferId,
    routeKey,
    fromRegionId: value.fromRegionId,
    toRegionId: value.toRegionId,
    sourcePosition,
    desiredPosition,
    targetPosition,
    burden: value.burden,
    createdAtTick,
  };
}

function isPathogenEdgeSnapshot(value: unknown): value is PathogenEdgeSnapshot {
  if (
    !isRecord(value) ||
    typeof value.regionId !== "string" ||
    !HEX_GRID_DIRECTIONS.includes(value.direction as HexGridDirection) ||
    !Number.isInteger(value.revision) ||
    !Number.isInteger(value.tick) ||
    !Array.isArray(value.agents)
  ) {
    return false;
  }
  const validAgents = value.agents.every((entry) =>
    isRecord(entry) &&
    isRecord(entry.position) &&
    Number.isInteger(entry.position.x) &&
    Number.isInteger(entry.position.y) &&
    typeof entry.pressure === "number" &&
    Number.isFinite(entry.pressure) &&
    entry.pressure >= 0 &&
    entry.pressure <= 1
  );
  if (!validAgents) return false;
  if (value.reservoirs === undefined) return true;
  return Array.isArray(value.reservoirs) && value.reservoirs.every((entry) =>
    isRecord(entry) &&
    isRecord(entry.position) &&
    Number.isInteger(entry.position.x) &&
    Number.isInteger(entry.position.y) &&
    typeof entry.burden === "number" &&
    Number.isFinite(entry.burden) &&
    entry.burden >= 0 &&
    entry.burden <= 1
  );
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function shouldMaterializePathogenHalo(
  state: Pick<WorldState, "width" | "height" | "agents">,
  fromTick: number,
  toTick: number,
): boolean {
  if (pathogenStepCount(fromTick, toTick, PATHOGEN_HALO_INTERVAL) <= 0) return false;
  const center = hexGridCenter(state);
  const radius = hexGridRadius(state);
  return state.agents.some((agent) =>
    agent.hp > 0 &&
    isHexGridCell(state, agent.position) &&
    hexGridDistance(agent.position, center) === radius
  );
}

/**
 * Keep pathogen edge reads proportional to actual cross-seam contact.
 *
 * A full dynamic depth-1 halo can reference all six neighboring Durable Objects,
 * but pathogen pressure/reservoir exposure is consumed only by living BOTs on
 * the paired local boundary cell. Dead Agents neither transmit nor acquire new
 * active exposure, so letting a corpse keep a seam occupied would wake neighbor
 * DOs for work that cannot change epidemiological state. Filtering links before
 * any neighbor fetch preserves every possible living exposure (including corner
 * cells that legitimately map to multiple neighbors) while avoiding unrelated
 * DO wakeups for empty or corpse-only seams.
 */
export function pathogenHaloLinksForAgents(
  state: Pick<WorldState, "agents">,
  links: readonly HexHaloLink[],
): HexHaloLink[] {
  if (state.agents.length === 0 || links.length === 0) return [];
  const occupied = new Set(
    state.agents
      .filter((agent) => agent.hp > 0)
      .map((agent) => positionKey(agent.position)),
  );
  if (occupied.size === 0) return [];
  return links.filter((link) => occupied.has(positionKey(link.sourcePosition)));
}

/**
 * Group occupied halo links by remote edge while retaining only the exact ghost
 * cells that can affect a local BOT. This keeps the existing DO fan-out contract
 * but avoids returning an entire edge snapshot when one or two paired cells are
 * sufficient for the current pathogen step.
 */
export function pathogenHaloEdgeRequests(
  links: readonly HexHaloLink[],
): PathogenHaloEdgeRequest[] {
  const grouped = new Map<string, {
    regionId: string;
    direction: HexGridDirection;
    positions: Map<string, GridPosition>;
  }>();
  for (const link of links) {
    const key = `${link.neighborRegionId}:${link.neighborDirection}`;
    let request = grouped.get(key);
    if (request === undefined) {
      request = {
        regionId: link.neighborRegionId,
        direction: link.neighborDirection,
        positions: new Map(),
      };
      grouped.set(key, request);
    }
    request.positions.set(positionKey(link.neighborPosition), { ...link.neighborPosition });
  }
  return [...grouped.values()]
    .map((request) => ({
      regionId: request.regionId,
      direction: request.direction,
      positions: [...request.positions.values()].sort((a, b) => a.y - b.y || a.x - b.x),
    }))
    .sort((a, b) =>
      a.regionId.localeCompare(b.regionId) || a.direction.localeCompare(b.direction)
    );
}

export class RegionDurableObject extends AutonomyRegionDurableObject {
  constructor(
    private readonly pathogenState: DurableObjectState,
    private readonly pathogenEnv: PathogenEnv,
  ) {
    super(pathogenState, pathogenEnv);
  }

  private pathogenStub(regionId: string): DurableObjectStub {
    return this.pathogenEnv.REGIONS.get(this.pathogenEnv.REGIONS.idFromName(regionId));
  }

  private async ensurePathogenAssigned(
    request: Request,
    activate = false,
  ): Promise<Response | undefined> {
    try {
      await this.ensureRegion(request, { activate });
      return undefined;
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "region routing failed" }, 400);
    }
  }

  private pathogenEnvironmentFrame(state: WorldState): PathogenEnvironmentFrame | undefined {
    const origin = regionGlobalCellOrigin(state.regionId, state.width, state.height);
    if (origin === undefined) return undefined;
    return {
      worldSeed: worldSeedValue(this.pathogenEnv.WORLD_SEED),
      originX: origin.x,
      originY: origin.y,
    };
  }

  private pathogenHaloLinks(state: WorldState): HexHaloLink[] {
    // Regions that already participate in the shared global axial cell frame use
    // exact six-direction ownership at every activity tier. Historical IDs with
    // no global identity retain the configured compatibility halo.
    if (regionGlobalCellOrigin(state.regionId, state.width, state.height) !== undefined) {
      return buildDynamicHexHaloLinks(state, state.regionId);
    }
    return buildConfiguredHexHaloLinks(
      state,
      configuredRegionIds(this.pathogenEnv),
      state.regionId,
    );
  }

  private async outgoingPathogenReservoirTransfers(): Promise<OutgoingPathogenReservoirTransfer[]> {
    return await this.pathogenState.storage.get<OutgoingPathogenReservoirTransfer[]>(
      OUTGOING_PATHOGEN_RESERVOIR_KEY,
    ) ?? [];
  }

  private async incomingPathogenReservoirRoutes(): Promise<IncomingPathogenReservoirRoute[]> {
    return await this.pathogenState.storage.get<IncomingPathogenReservoirRoute[]>(
      INCOMING_PATHOGEN_RESERVOIR_KEY,
    ) ?? [];
  }

  private reservoirTransferForIntent(
    state: WorldState,
    intent: PathogenReservoirOutboundIntent,
  ): OutgoingPathogenReservoirTransfer | undefined {
    const transition = regionCellTransition(
      state.regionId,
      intent.desiredPosition,
      state.width,
      state.height,
    );
    if (transition === undefined) return undefined;
    const routeKey = pathogenReservoirRouteKey(
      state.regionId,
      intent.sourcePosition,
      transition.targetRegionId,
      transition.targetPosition,
    );
    return {
      transferId: `${routeKey}@${state.tick}`,
      routeKey,
      fromRegionId: state.regionId,
      toRegionId: transition.targetRegionId,
      sourcePosition: { ...intent.sourcePosition },
      desiredPosition: { ...intent.desiredPosition },
      targetPosition: { ...transition.targetPosition },
      burden: intent.burden,
      createdAtTick: state.tick,
    };
  }

  /**
   * Atomically move outbound mass from the persisted source tile into a
   * source-owned journal before any cross-DO request is attempted. The
   * journal is therefore the owner while a neighbor is unavailable; retrying
   * cannot duplicate source mass and a crash cannot make it disappear.
   */
  private async reserveOutgoingPathogenReservoir(
    state: WorldState,
    environment: PathogenEnvironmentFrame | undefined,
  ): Promise<boolean> {
    const candidates = pathogenReservoirOutboundIntents(state, environment)
      .map((intent) => this.reservoirTransferForIntent(state, intent))
      .filter((value): value is OutgoingPathogenReservoirTransfer => value !== undefined);
    if (candidates.length === 0) return false;

    const access = runtimeAccess(this);
    const result = await this.pathogenState.storage.transaction(async (txn) => {
      const stored = await txn.get<StoredPathogenRegion>("region");
      if (stored === undefined || stored.state.regionId !== state.regionId) {
        return { changed: false as const, state: undefined as WorldState | undefined };
      }
      const records = await txn.get<OutgoingPathogenReservoirTransfer[]>(
        OUTGOING_PATHOGEN_RESERVOIR_KEY,
      ) ?? [];
      const occupiedRoutes = new Set(records.map((record) => record.routeKey));
      const nextState = structuredClone(stored.state);
      let changed = false;

      for (const candidate of candidates) {
        if (occupiedRoutes.has(candidate.routeKey)) continue;
        const tile = nextState.tiles.find((entry) => samePosition(entry, candidate.sourcePosition));
        if (tile === undefined || !isHexGridCell(nextState, tile)) continue;
        const current = tilePathogenReservoir(tile);
        const amount = Math.min(current, candidate.burden);
        if (amount <= PATHOGEN_RESERVOIR_TRANSFER_EPSILON) continue;
        const target = tile as typeof tile & { pathogenReservoir?: number };
        const remaining = Math.max(0, current - amount);
        if (remaining <= PATHOGEN_RESERVOIR_TRANSFER_EPSILON) {
          delete target.pathogenReservoir;
        } else {
          target.pathogenReservoir = remaining;
        }
        records.push({ ...candidate, burden: amount });
        occupiedRoutes.add(candidate.routeKey);
        changed = true;
      }

      if (!changed) return { changed: false as const, state: undefined as WorldState | undefined };
      stored.state = nextState;
      await txn.put("region", stored);
      await txn.put(OUTGOING_PATHOGEN_RESERVOIR_KEY, records);
      return { changed: true as const, state: nextState };
    });

    if (!result.changed || result.state === undefined) return false;
    access.runtime = new WorldRuntime({
      state: result.state,
      pendingCommands: access.runtime.pendingCommands(),
    });
    // Refresh ordinary region metadata after the atomic ownership move.
    // A crash before this best-effort write is still safe because the
    // transaction already persisted both the debited state and journal.
    await access.persist();
    access.broadcastSnapshot();
    return true;
  }

  private async flushOutgoingPathogenReservoir(
    eligibleTransferIds: ReadonlySet<string>,
  ): Promise<void> {
    if (eligibleTransferIds.size === 0) return;
    const records = (await this.outgoingPathogenReservoirTransfers())
      .filter((record) => eligibleTransferIds.has(record.transferId));
    if (records.length === 0) return;

    const selectedIds = new Set(selectPathogenReservoirAttemptIds(
      records,
      runtimeAccess(this).runtime.snapshot().tick,
    ));
    const selected = records.filter((record) => selectedIds.has(record.transferId));
    const outcomes = await Promise.all(selected.map(async (record) => {
      try {
        const response = await withPathogenEdgeDeadline((signal) =>
          this.pathogenStub(record.toRegionId).fetch(new Request(
            `https://moyo.internal${INTERNAL_PATHOGEN_RESERVOIR_TRANSFER_PATH}`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-moyo-region-internal": record.toRegionId,
              },
              body: JSON.stringify(record),
              signal,
            },
          )),
        );
        return response.ok ? record.transferId : undefined;
      } catch (error) {
        console.debug(
          "MoYoGarden pathogen reservoir transfer unavailable",
          record.toRegionId,
          record.transferId,
          error,
        );
        return undefined;
      }
    }));
    const acknowledged = new Set(
      outcomes.filter((value): value is string => value !== undefined),
    );
    if (acknowledged.size === 0) return;
    const current = await this.outgoingPathogenReservoirTransfers();
    await this.pathogenState.storage.put(
      OUTGOING_PATHOGEN_RESERVOIR_KEY,
      current.filter((record) => !acknowledged.has(record.transferId)),
    );
  }

  private async acceptIncomingPathogenReservoir(request: Request): Promise<Response> {
    let value: unknown;
    try {
      value = await request.json() as unknown;
    } catch {
      return json({ error: "valid reservoir transfer JSON is required" }, 400);
    }
    const transfer = pathogenReservoirTransferValue(value);
    if (transfer === undefined) return json({ error: "valid reservoir transfer is required" }, 400);

    const state = runtimeAccess(this).runtime.snapshot();
    if (transfer.toRegionId !== state.regionId) {
      return json({ error: "reservoir transfer target region mismatch" }, 409);
    }
    if (hexGridDistance(transfer.sourcePosition, transfer.desiredPosition) !== 1) {
      return json({ error: "reservoir transfer must cross exactly one hex cell" }, 409);
    }
    const transition = regionCellTransition(
      transfer.fromRegionId,
      transfer.desiredPosition,
      state.width,
      state.height,
    );
    if (
      transition === undefined ||
      transition.targetRegionId !== state.regionId ||
      !samePosition(transition.targetPosition, transfer.targetPosition) ||
      !isHexGridCell(state, transfer.targetPosition)
    ) {
      return json({ error: "reservoir transfer ownership mapping mismatch" }, 409);
    }

    let accepted = false;
    await this.pathogenState.storage.transaction(async (txn) => {
      const routes = await txn.get<IncomingPathogenReservoirRoute[]>(
        INCOMING_PATHOGEN_RESERVOIR_KEY,
      ) ?? [];
      const existing = routes.find((route) => route.routeKey === transfer.routeKey);
      if (existing !== undefined) {
        if (transfer.createdAtTick <= existing.lastAcceptedTick) return;
        existing.lastAcceptedTick = transfer.createdAtTick;
        existing.pendingBurden += transfer.burden;
      } else {
        routes.push({
          routeKey: transfer.routeKey,
          fromRegionId: transfer.fromRegionId,
          sourcePosition: { ...transfer.sourcePosition },
          targetPosition: { ...transfer.targetPosition },
          lastAcceptedTick: transfer.createdAtTick,
          pendingBurden: transfer.burden,
        });
      }
      accepted = true;
      await txn.put(INCOMING_PATHOGEN_RESERVOIR_KEY, routes);
    });
    return json({
      transferId: transfer.transferId,
      phase: accepted ? "accepted" : "duplicate",
    });
  }

  /**
   * Move accepted target-owned inbox mass onto its exact local tile. Inbox
   * cursors remain after pendingBurden reaches zero, giving bounded per-route
   * duplicate suppression without an ever-growing transfer-id ledger.
   */
  private async drainIncomingPathogenReservoir(): Promise<boolean> {
    const preview = await this.incomingPathogenReservoirRoutes();
    if (!preview.some((route) => route.pendingBurden > 0)) return false;
    const access = runtimeAccess(this);
    const result = await this.pathogenState.storage.transaction(async (txn) => {
      const stored = await txn.get<StoredPathogenRegion>("region");
      const routes = await txn.get<IncomingPathogenReservoirRoute[]>(
        INCOMING_PATHOGEN_RESERVOIR_KEY,
      ) ?? [];
      if (stored === undefined) {
        return { changed: false as const, state: undefined as WorldState | undefined };
      }
      const nextState = structuredClone(stored.state);
      let changed = false;
      for (const route of [...routes].sort((a, b) => a.routeKey.localeCompare(b.routeKey))) {
        if (route.pendingBurden <= 0) continue;
        const tile = nextState.tiles.find((entry) => samePosition(entry, route.targetPosition));
        if (tile === undefined || !isHexGridCell(nextState, tile)) continue;
        const current = tilePathogenReservoir(tile);
        const accepted = Math.min(Math.max(0, 1 - current), route.pendingBurden);
        if (accepted <= 0) continue;
        (tile as typeof tile & { pathogenReservoir?: number }).pathogenReservoir = current + accepted;
        route.pendingBurden = Math.max(0, route.pendingBurden - accepted);
        changed = true;
      }
      if (!changed) {
        return { changed: false as const, state: undefined as WorldState | undefined };
      }
      stored.state = nextState;
      await txn.put("region", stored);
      await txn.put(INCOMING_PATHOGEN_RESERVOIR_KEY, routes);
      return { changed: true as const, state: nextState };
    });
    if (!result.changed || result.state === undefined) return false;
    access.runtime = new WorldRuntime({
      state: result.state,
      pendingCommands: access.runtime.pendingCommands(),
    });
    await access.persist();
    access.broadcastSnapshot();
    return true;
  }

  private async fetchNeighborPathogenEdge(
    regionId: string,
    direction: HexGridDirection,
    positions: readonly GridPosition[],
  ): Promise<PathogenEdgeSnapshot | undefined> {
    const url = new URL(`https://moyo.internal${INTERNAL_PATHOGEN_EDGE_PATH}`);
    url.searchParams.set("direction", direction);
    for (const position of positions) {
      url.searchParams.append("cell", positionKey(position));
    }
    try {
      const value = await readPathogenEdgeJsonWithDeadline((signal) =>
        this.pathogenStub(regionId).fetch(new Request(url, {
          method: "GET",
          headers: { "x-moyo-region-internal": regionId },
          signal,
        }))
      );
      return isPathogenEdgeSnapshot(value) ? value : undefined;
    } catch (error) {
      console.debug("MoYoGarden pathogen edge unavailable", regionId, direction, error);
      return undefined;
    }
  }

  private async materializePathogenHalo(state: WorldState): Promise<MaterializedPathogenHalo> {
    const links = pathogenHaloLinksForAgents(state, this.pathogenHaloLinks(state));
    if (links.length === 0) {
      return {
        pressure: new Map(),
        reservoir: new Map(),
        pressureExposure: new Map(),
        reservoirExposure: new Map(),
      };
    }
    const requests = pathogenHaloEdgeRequests(links);
    const edges = (
      await Promise.all(
        requests.map(({ regionId, direction, positions }) =>
          this.fetchNeighborPathogenEdge(regionId, direction, positions)
        ),
      )
    ).filter((value): value is PathogenEdgeSnapshot => value !== undefined);
    return pathogenHaloMaps(links, edges, this.pathogenEnvironmentFrame(state));
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === INTERNAL_PATHOGEN_RESERVOIR_TRANSFER_PATH) {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      const assignmentError = await this.ensurePathogenAssigned(request, true);
      if (assignmentError !== undefined) return assignmentError;
      return this.acceptIncomingPathogenReservoir(request);
    }
    if (url.pathname === INTERNAL_PATHOGEN_EDGE_PATH) {
      if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
      const assignmentError = await this.ensurePathogenAssigned(request);
      if (assignmentError !== undefined) return assignmentError;
      const direction = directionValue(url.searchParams.get("direction"));
      if (direction === undefined) return json({ error: "valid hex direction is required" }, 400);
      const requestedCells = requestedPathogenEdgeCells(url.searchParams.getAll("cell"));
      if (requestedCells === null) return json({ error: "valid pathogen edge cells are required" }, 400);
      const state = runtimeAccess(this).runtime.snapshot();
      const snapshotState = requestedCells === undefined
        ? state
        : {
          ...state,
          agents: state.agents.filter((agent) => requestedCells.has(positionKey(agent.position))),
          tiles: state.tiles.filter((tile) => requestedCells.has(positionKey(tile))),
        };
      return json(pathogenEdgeSnapshot(snapshotState, direction));
    }
    return super.fetch(request);
  }

  override async alarm(): Promise<void> {
    const access = runtimeAccess(this);
    const beforeTick = access.runtime.snapshot().tick;
    await super.alarm();

    // Accepted cross-DO burden is already owned by this Durable Object.
    // Materialize it before the next pathogen cadence, but never let a
    // newly received amount immediately traverse another macro-region.
    await this.drainIncomingPathogenReservoir();
    const state = access.runtime.snapshot();
    const localSteps = pathogenStepCount(beforeTick, state.tick, PATHOGEN_LOCAL_INTERVAL);
    if (localSteps <= 0) return;

    // Retry older source-owned journals first. While a route is pending,
    // reserveOutgoingPathogenReservoir refuses to create a second transfer
    // for that same route, keeping retry state bounded during outages.
    const retryTransferIds = new Set(
      (await this.outgoingPathogenReservoirTransfers()).map((record) => record.transferId),
    );
    await this.flushOutgoingPathogenReservoir(retryTransferIds);
    const workingState = access.runtime.snapshot();
    const environment = this.pathogenEnvironmentFrame(workingState);
    const halo = shouldMaterializePathogenHalo(workingState, beforeTick, workingState.tick)
      ? await this.materializePathogenHalo(workingState)
      : {
        pressure: new Map<string, number>(),
        reservoir: new Map<string, number>(),
        pressureExposure: new Map<string, number>(),
        reservoirExposure: new Map<string, number>(),
      };
    const changed = applyPathogenTickRange(
      workingState,
      beforeTick,
      workingState.tick,
      environment,
      halo.pressure,
      halo.reservoir,
      halo.pressureExposure,
      halo.reservoirExposure,
    );
    if (changed > 0) {
      access.runtime = new WorldRuntime({
        state: workingState,
        pendingCommands: access.runtime.pendingCommands(),
      });
      await access.persist();
      access.broadcastSnapshot();
    }

    // Cross-DO transport is planned from the post-local-step residual.
    // This deliberately prevents newly arrived burden from chaining across
    // more than one macro-region in one pathogen cadence. Source debit and
    // outbox insertion are atomic; delivery can then be retried safely.
    const outboundState = access.runtime.snapshot();
    await this.reserveOutgoingPathogenReservoir(
      outboundState,
      this.pathogenEnvironmentFrame(outboundState),
    );
    const freshTransferIds = new Set(
      (await this.outgoingPathogenReservoirTransfers())
        .filter((record) => !retryTransferIds.has(record.transferId))
        .map((record) => record.transferId),
    );
    await this.flushOutgoingPathogenReservoir(freshTransferIds);
  }
}

// Keep this tiny export useful to health/diagnostic tests without exposing a new
// public endpoint. A value above zero means the additive pathogen state survived
// ordinary WorldState persistence or an ownership handoff.
export function worldPathogenLoad(state: Pick<WorldState, "agents">): number {
  return state.agents.reduce((sum, agent) => sum + agentPathogenLoad(agent), 0);
}