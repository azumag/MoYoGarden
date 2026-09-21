import baseWorker, {
  RegionDurableObject as DestinationStorageReconciliationRegionDurableObject,
} from "./destination-storage-reconciliation-region.js";
import {
  normalizeDestinationStorageGenerationFences,
} from "./storage-reservation-region.js";

interface DestinationStorageTerminalEnv {
  REGIONS: DurableObjectNamespace;
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
  runtime: {
    snapshot(): {
      agents: unknown[];
    };
  };
}

interface DestinationStorageReservationLike {
  claimId: string;
  sourceRegionId: string;
  expiresAtMs: number;
}

interface DestinationStorageArrivalClaimLike {
  claimId: string;
  sourceRegionId: string;
  agentId: string;
  resource: "wood" | "stone" | "food";
  destinationStorageReserved: true;
}

export interface DestinationStorageTerminalFence {
  claimId: string;
  sourceRegionId: string;
  completedAtMs: number;
  expiresAtMs: number;
  // The target-side reserve generation that owned capacity when local cargo
  // completed. Optional for rolling compatibility with terminal fences written
  // before generation-aware completion tracking existed.
  completedReserveIssuedAtMs?: number;
}

const DESTINATION_STORAGE_RESERVATIONS_KEY = "handoff:autonomy:destination-storage:v1";
const AUTONOMOUS_ARRIVAL_CLAIMS_KEY = "handoff:autonomy:arrival-claims:v1";
const DESTINATION_STORAGE_GENERATION_FENCES_KEY =
  "handoff:autonomy:destination-storage-generation:v1";
const DESTINATION_STORAGE_TERMINAL_FENCES_KEY =
  "handoff:autonomy:destination-storage-terminal:v1";
const INTERNAL_STORAGE_RESERVE_PATH = "/api/internal/autonomy/storage/reserve";
export const DESTINATION_STORAGE_TERMINAL_FENCE_TTL_MS = 24 * 60 * 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function terminalKey(sourceRegionId: string, claimId: string): string {
  return `${sourceRegionId}\u0000${claimId}`;
}

function reservationValue(
  value: unknown,
  now: number,
): DestinationStorageReservationLike | undefined {
  if (!isRecord(value)) return undefined;
  const claimId = nonEmptyString(value.claimId);
  const sourceRegionId = nonEmptyString(value.sourceRegionId);
  const expiresAtMs = positiveFinite(value.expiresAtMs);
  if (
    claimId === undefined
    || sourceRegionId === undefined
    || expiresAtMs === undefined
    || expiresAtMs <= now
  ) return undefined;
  return { claimId, sourceRegionId, expiresAtMs };
}

function arrivalClaimValue(value: unknown): DestinationStorageArrivalClaimLike | undefined {
  if (!isRecord(value) || value.destinationStorageReserved !== true) return undefined;
  const claimId = nonEmptyString(value.claimId);
  const sourceRegionId = nonEmptyString(value.sourceRegionId);
  const agentId = nonEmptyString(value.agentId);
  const resource = value.resource;
  if (
    claimId === undefined
    || sourceRegionId === undefined
    || agentId === undefined
    || (resource !== "wood" && resource !== "stone" && resource !== "food")
  ) return undefined;
  return {
    claimId,
    sourceRegionId,
    agentId,
    resource,
    destinationStorageReserved: true,
  };
}

function terminalFenceValue(value: unknown): DestinationStorageTerminalFence | undefined {
  if (!isRecord(value)) return undefined;
  const claimId = nonEmptyString(value.claimId);
  const sourceRegionId = nonEmptyString(value.sourceRegionId);
  const completedAtMs = positiveFinite(value.completedAtMs);
  const expiresAtMs = positiveFinite(value.expiresAtMs);
  if (
    claimId === undefined
    || sourceRegionId === undefined
    || completedAtMs === undefined
    || expiresAtMs === undefined
  ) return undefined;
  const completedReserveIssuedAtMs = positiveFinite(value.completedReserveIssuedAtMs);
  return {
    claimId,
    sourceRegionId,
    completedAtMs,
    expiresAtMs,
    ...(completedReserveIssuedAtMs === undefined ? {} : { completedReserveIssuedAtMs }),
  };
}

function inventoryAmountForResource(
  agent: unknown,
  resource: DestinationStorageArrivalClaimLike["resource"],
): number | undefined {
  if (!isRecord(agent) || !isRecord(agent.inventory)) return undefined;
  const amount = agent.inventory[resource];
  return typeof amount === "number" && Number.isFinite(amount) && amount >= 0
    ? amount
    : undefined;
}

export function normalizeDestinationStorageTerminalFences(
  value: unknown,
  now = Date.now(),
): DestinationStorageTerminalFence[] {
  if (!Array.isArray(value)) return [];
  const merged = new Map<string, DestinationStorageTerminalFence>();
  for (const candidate of value) {
    const fence = terminalFenceValue(candidate);
    if (fence === undefined || fence.expiresAtMs <= now) continue;
    const key = terminalKey(fence.sourceRegionId, fence.claimId);
    const current = merged.get(key);
    if (
      current === undefined
      || fence.completedAtMs > current.completedAtMs
      || (
        fence.completedAtMs === current.completedAtMs
        && fence.expiresAtMs > current.expiresAtMs
      )
    ) {
      merged.set(key, fence);
    }
  }
  return [...merged.values()].sort((a, b) =>
    a.sourceRegionId.localeCompare(b.sourceRegionId)
    || a.claimId.localeCompare(b.claimId)
  );
}

export function upsertDestinationStorageTerminalFences(
  value: unknown,
  additions: readonly DestinationStorageTerminalFence[],
  now = Date.now(),
): DestinationStorageTerminalFence[] {
  const merged = new Map(
    normalizeDestinationStorageTerminalFences(value, now)
      .map((entry) => [terminalKey(entry.sourceRegionId, entry.claimId), entry]),
  );
  for (const addition of additions) {
    const fence = terminalFenceValue(addition);
    if (fence === undefined || fence.expiresAtMs <= now) continue;
    const key = terminalKey(fence.sourceRegionId, fence.claimId);
    const current = merged.get(key);
    if (
      current === undefined
      || fence.completedAtMs > current.completedAtMs
      || (
        fence.completedAtMs === current.completedAtMs
        && fence.expiresAtMs > current.expiresAtMs
      )
    ) merged.set(key, fence);
  }
  return [...merged.values()].sort((a, b) =>
    a.sourceRegionId.localeCompare(b.sourceRegionId)
    || a.claimId.localeCompare(b.claimId)
  );
}

export function destinationStorageTerminalBlocksReserve(
  value: unknown,
  sourceRegionId: string,
  claimId: string,
  now = Date.now(),
  reserveIssuedAtMs?: number,
): boolean {
  const fence = normalizeDestinationStorageTerminalFences(value, now).find((entry) =>
    entry.sourceRegionId === sourceRegionId && entry.claimId === claimId
  );
  if (fence === undefined) return false;

  // Legacy/unversioned attempts cannot prove that they represent ownership
  // acquired after the completed sink. Likewise, terminal fences written by an
  // older deployment have no generation watermark, so retain their old strict
  // blocking behavior. Only an explicitly newer generated reserve can reopen
  // capacity for the same logical claim.
  if (reserveIssuedAtMs === undefined || fence.completedReserveIssuedAtMs === undefined) {
    return true;
  }
  return reserveIssuedAtMs <= fence.completedReserveIssuedAtMs;
}

/**
 * Detect a destination reservation that was consumed locally during the parent
 * Alarm. The reservation must have been live before the tick, linked to a local
 * arrival claim, and the same courier must still be owned by this region after
 * the tick with none of the claimed resource left in inventory.
 *
 * Requiring post-tick local ownership is deliberate: when a courier handed off
 * to another region during this Alarm, the agent is absent here and we must not
 * terminally fence the claim. That forwarded cargo still needs a later owner to
 * decide where its sink responsibility belongs.
 *
 * A reservation that merely expires while the parent Alarm is running is also
 * not proof of local completion. Compare its original wall-clock lease against
 * the actual post-Alarm observation time so a slow Alarm cannot turn TTL cleanup
 * into a 24-hour terminal fence for cargo that was never deposited.
 *
 * When the destination generation ledger knows which reserve generation owned
 * the completed capacity, retain that watermark in the terminal fence. This
 * keeps delayed duplicates blocked while allowing a strictly newer ownership
 * generation to reacquire the same logical claim without waiting 24 hours.
 */
export function deriveLocallyCompletedDestinationStorageFences(
  reservationsBefore: unknown,
  reservationsAfter: unknown,
  arrivalClaimsBefore: unknown,
  agentsAfter: readonly unknown[],
  observedAtMs = Date.now(),
  completedAtMs = observedAtMs,
  generationFences?: unknown,
): DestinationStorageTerminalFence[] {
  const before = Array.isArray(reservationsBefore)
    ? reservationsBefore.flatMap((entry) => {
        const reservation = reservationValue(entry, observedAtMs);
        return reservation === undefined ? [] : [reservation];
      })
    : [];
  const afterKeys = new Set(
    (Array.isArray(reservationsAfter) ? reservationsAfter : []).flatMap((entry) => {
      const reservation = reservationValue(entry, completedAtMs);
      return reservation === undefined
        ? []
        : [terminalKey(reservation.sourceRegionId, reservation.claimId)];
    }),
  );
  const claims = new Map(
    (Array.isArray(arrivalClaimsBefore) ? arrivalClaimsBefore : []).flatMap((entry) => {
      const claim = arrivalClaimValue(entry);
      return claim === undefined
        ? []
        : [[terminalKey(claim.sourceRegionId, claim.claimId), claim] as const];
    }),
  );
  const reserveGenerations = new Map(
    normalizeDestinationStorageGenerationFences(generationFences, completedAtMs)
      .flatMap((fence) => fence.latestReserveIssuedAtMs === undefined
        ? []
        : [[terminalKey(fence.sourceRegionId, fence.claimId), fence.latestReserveIssuedAtMs] as const]),
  );
  const agents = new Map<string, unknown>();
  for (const agent of agentsAfter) {
    if (!isRecord(agent)) continue;
    const id = nonEmptyString(agent.id);
    if (id !== undefined) agents.set(id, agent);
  }

  const completed = new Map<string, DestinationStorageTerminalFence>();
  for (const reservation of before) {
    const key = terminalKey(reservation.sourceRegionId, reservation.claimId);
    if (afterKeys.has(key)) continue;
    // If the lease itself became stale during the Alarm, disappearance is
    // ambiguous: active reservation normalization may have pruned it without
    // any deposit commit. Fail closed by declining to mint a terminal fence.
    if (reservation.expiresAtMs <= completedAtMs) continue;
    const claim = claims.get(key);
    if (claim === undefined) continue;
    const agent = agents.get(claim.agentId);
    if (agent === undefined) continue;
    const remaining = inventoryAmountForResource(agent, claim.resource);
    if (remaining === undefined || remaining > 0) continue;
    const completedReserveIssuedAtMs = reserveGenerations.get(key);
    completed.set(key, {
      claimId: reservation.claimId,
      sourceRegionId: reservation.sourceRegionId,
      completedAtMs,
      expiresAtMs: completedAtMs + DESTINATION_STORAGE_TERMINAL_FENCE_TTL_MS,
      ...(completedReserveIssuedAtMs === undefined ? {} : { completedReserveIssuedAtMs }),
    });
  }
  return [...completed.values()].sort((a, b) =>
    a.sourceRegionId.localeCompare(b.sourceRegionId)
    || a.claimId.localeCompare(b.claimId)
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

function runtimeAccess(instance: RegionDurableObject): RuntimeAccess {
  return instance as unknown as RuntimeAccess;
}

export class RegionDurableObject extends DestinationStorageReconciliationRegionDurableObject {
  constructor(
    private readonly destinationStorageTerminalState: DurableObjectState,
    env: DestinationStorageTerminalEnv,
  ) {
    super(destinationStorageTerminalState, env);
  }

  private async normalizedTerminalFences(now = Date.now()): Promise<DestinationStorageTerminalFence[]> {
    const stored = await this.destinationStorageTerminalState.storage.get<unknown>(
      DESTINATION_STORAGE_TERMINAL_FENCES_KEY,
    );
    const normalized = normalizeDestinationStorageTerminalFences(stored, now);
    if (
      stored !== undefined
      && (!Array.isArray(stored) || stored.length !== normalized.length)
    ) {
      await this.destinationStorageTerminalState.storage.put(
        DESTINATION_STORAGE_TERMINAL_FENCES_KEY,
        normalized,
      );
    }
    return normalized;
  }

  private async rejectTerminalReserve(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== INTERNAL_STORAGE_RESERVE_PATH) {
      return undefined;
    }
    let body: unknown;
    try {
      body = await request.clone().json() as unknown;
    } catch {
      return undefined;
    }
    if (!isRecord(body)) return undefined;
    const claimId = nonEmptyString(body.claimId);
    const sourceRegionId = nonEmptyString(body.sourceRegionId);
    if (claimId === undefined || sourceRegionId === undefined) return undefined;
    const now = Date.now();
    const fences = await this.normalizedTerminalFences(now);
    if (!destinationStorageTerminalBlocksReserve(
      fences,
      sourceRegionId,
      claimId,
      now,
      positiveFinite(body.issuedAtMs),
    )) {
      return undefined;
    }
    return json({
      error: "destination storage claim already completed locally",
      claimId,
      sourceRegionId,
      stale: true,
      terminal: true,
    }, 409);
  }

  override async fetch(request: Request): Promise<Response> {
    const terminal = await this.rejectTerminalReserve(request);
    return terminal ?? super.fetch(request);
  }

  override async alarm(): Promise<void> {
    const observedAtMs = Date.now();
    const [reservationsBefore, arrivalClaimsBefore, generationFencesBefore] = await Promise.all([
      this.destinationStorageTerminalState.storage.get<unknown>(
        DESTINATION_STORAGE_RESERVATIONS_KEY,
      ),
      this.destinationStorageTerminalState.storage.get<unknown>(
        AUTONOMOUS_ARRIVAL_CLAIMS_KEY,
      ),
      this.destinationStorageTerminalState.storage.get<unknown>(
        DESTINATION_STORAGE_GENERATION_FENCES_KEY,
      ),
    ]);

    await super.alarm();

    const completedAtMs = Date.now();
    await this.destinationStorageTerminalState.blockConcurrencyWhile(async () => {
      const reservationsAfter = await this.destinationStorageTerminalState.storage.get<unknown>(
        DESTINATION_STORAGE_RESERVATIONS_KEY,
      );
      const completions = deriveLocallyCompletedDestinationStorageFences(
        reservationsBefore,
        reservationsAfter,
        arrivalClaimsBefore,
        runtimeAccess(this).runtime.snapshot().agents,
        observedAtMs,
        completedAtMs,
        generationFencesBefore,
      );
      const stored = await this.destinationStorageTerminalState.storage.get<unknown>(
        DESTINATION_STORAGE_TERMINAL_FENCES_KEY,
      );
      const next = upsertDestinationStorageTerminalFences(stored, completions, completedAtMs);
      const current = normalizeDestinationStorageTerminalFences(stored, completedAtMs);
      if (
        !Array.isArray(stored)
        || JSON.stringify(next) !== JSON.stringify(current)
        || (Array.isArray(stored) && stored.length !== current.length)
      ) {
        await this.destinationStorageTerminalState.storage.put(
          DESTINATION_STORAGE_TERMINAL_FENCES_KEY,
          next,
        );
      }
    });
  }
}

export default baseWorker;