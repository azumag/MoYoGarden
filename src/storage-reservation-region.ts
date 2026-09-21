import { RegionDurableObject as PathogenRegionDurableObject } from "./pathogen-region.js";

interface StorageReservationEnv {
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

export interface DestinationStorageGenerationFence {
  claimId: string;
  sourceRegionId: string;
  latestReserveIssuedAtMs?: number;
  releaseIssuedAtMs?: number;
  expiresAtMs: number;
}

export interface DestinationStorageFenceDecision {
  records: DestinationStorageGenerationFence[];
  accepted: boolean;
  stale: boolean;
}

const INTERNAL_STORAGE_RESERVE_PATH = "/api/internal/autonomy/storage/reserve";
const INTERNAL_STORAGE_RELEASE_PATH = "/api/internal/autonomy/storage/release";
const DESTINATION_STORAGE_GENERATION_FENCES_KEY =
  "handoff:autonomy:destination-storage-generation:v1";
export const DESTINATION_STORAGE_GENERATION_FENCE_TTL_MS = 24 * 60 * 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function fenceKey(sourceRegionId: string, claimId: string): string {
  return `${sourceRegionId}\u0000${claimId}`;
}

function isDestinationStorageGenerationFence(
  value: unknown,
): value is DestinationStorageGenerationFence {
  if (
    !isRecord(value)
    || typeof value.claimId !== "string"
    || value.claimId.length === 0
    || typeof value.sourceRegionId !== "string"
    || value.sourceRegionId.length === 0
    || positiveFinite(value.expiresAtMs) === undefined
  ) {
    return false;
  }
  if (
    value.latestReserveIssuedAtMs !== undefined
    && positiveFinite(value.latestReserveIssuedAtMs) === undefined
  ) {
    return false;
  }
  if (
    value.releaseIssuedAtMs !== undefined
    && positiveFinite(value.releaseIssuedAtMs) === undefined
  ) {
    return false;
  }
  return value.latestReserveIssuedAtMs !== undefined || value.releaseIssuedAtMs !== undefined;
}

function maxOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

export function normalizeDestinationStorageGenerationFences(
  value: unknown,
  now = Date.now(),
): DestinationStorageGenerationFence[] {
  if (!Array.isArray(value)) return [];
  const merged = new Map<string, DestinationStorageGenerationFence>();
  for (const candidate of value) {
    if (!isDestinationStorageGenerationFence(candidate) || candidate.expiresAtMs <= now) continue;
    const key = fenceKey(candidate.sourceRegionId, candidate.claimId);
    const current = merged.get(key);
    const latestReserveIssuedAtMs = maxOptional(
      current?.latestReserveIssuedAtMs,
      candidate.latestReserveIssuedAtMs,
    );
    const releaseIssuedAtMs = maxOptional(
      current?.releaseIssuedAtMs,
      candidate.releaseIssuedAtMs,
    );
    const next: DestinationStorageGenerationFence = {
      claimId: candidate.claimId,
      sourceRegionId: candidate.sourceRegionId,
      expiresAtMs: Math.max(current?.expiresAtMs ?? 0, candidate.expiresAtMs),
    };
    if (latestReserveIssuedAtMs !== undefined) {
      next.latestReserveIssuedAtMs = latestReserveIssuedAtMs;
    }
    if (releaseIssuedAtMs !== undefined) next.releaseIssuedAtMs = releaseIssuedAtMs;
    merged.set(key, next);
  }
  return [...merged.values()].sort((a, b) =>
    a.sourceRegionId.localeCompare(b.sourceRegionId) || a.claimId.localeCompare(b.claimId)
  );
}

function upsertFence(
  records: readonly DestinationStorageGenerationFence[],
  record: DestinationStorageGenerationFence,
): DestinationStorageGenerationFence[] {
  const key = fenceKey(record.sourceRegionId, record.claimId);
  return [
    ...records.filter((entry) => fenceKey(entry.sourceRegionId, entry.claimId) !== key),
    record,
  ].sort((a, b) =>
    a.sourceRegionId.localeCompare(b.sourceRegionId) || a.claimId.localeCompare(b.claimId)
  );
}

export function applyDestinationStorageReserveFence(
  value: unknown,
  sourceRegionId: string,
  claimId: string,
  issuedAtMs: number | undefined,
  now = Date.now(),
): DestinationStorageFenceDecision {
  const records = normalizeDestinationStorageGenerationFences(value, now);
  const existing = records.find((entry) =>
    entry.sourceRegionId === sourceRegionId && entry.claimId === claimId
  );

  // Rolling-deploy compatibility: a completely legacy claim can still use the
  // old idempotent lease behavior. Once any generated ordering information is
  // present, an unversioned retry can no longer prove it is newer and must fail
  // closed rather than extend or resurrect capacity.
  if (issuedAtMs === undefined) {
    const fenced = existing?.latestReserveIssuedAtMs !== undefined
      || existing?.releaseIssuedAtMs !== undefined;
    return { records, accepted: !fenced, stale: fenced };
  }

  // A generated reserve attempt is single-use. Accepting the same generation
  // again would let a delayed duplicate recreate a reservation after its
  // shorter capacity lease expired, effectively extending stale ownership.
  if (
    (existing?.releaseIssuedAtMs !== undefined && existing.releaseIssuedAtMs >= issuedAtMs)
    || (existing?.latestReserveIssuedAtMs !== undefined
      && existing.latestReserveIssuedAtMs >= issuedAtMs)
  ) {
    return { records, accepted: false, stale: true };
  }

  const next: DestinationStorageGenerationFence = {
    claimId,
    sourceRegionId,
    latestReserveIssuedAtMs: Math.max(existing?.latestReserveIssuedAtMs ?? 0, issuedAtMs),
    expiresAtMs: Math.max(
      existing?.expiresAtMs ?? 0,
      now + DESTINATION_STORAGE_GENERATION_FENCE_TTL_MS,
    ),
  };
  if (existing?.releaseIssuedAtMs !== undefined) {
    next.releaseIssuedAtMs = existing.releaseIssuedAtMs;
  }
  return {
    records: upsertFence(records, next),
    accepted: true,
    stale: false,
  };
}

export function applyDestinationStorageReleaseFence(
  value: unknown,
  sourceRegionId: string,
  claimId: string,
  releaseIssuedAtMs: number | undefined,
  now = Date.now(),
): DestinationStorageFenceDecision {
  const records = normalizeDestinationStorageGenerationFences(value, now);
  const existing = records.find((entry) =>
    entry.sourceRegionId === sourceRegionId && entry.claimId === claimId
  );

  if (releaseIssuedAtMs === undefined && existing?.latestReserveIssuedAtMs !== undefined) {
    return { records, accepted: false, stale: true };
  }
  const effectiveReleaseIssuedAtMs = releaseIssuedAtMs ?? now;

  // Release fences are written before the capacity mutation. If a Worker dies
  // after recording the watermark but before deleting the reservation, the
  // exact same release generation must be allowed to retry the idempotent
  // delete. Older releases still fail closed, and a release equal to the latest
  // reserve generation is never allowed to delete that reservation.
  if (
    existing?.releaseIssuedAtMs === effectiveReleaseIssuedAtMs
    && (existing.latestReserveIssuedAtMs === undefined
      || existing.latestReserveIssuedAtMs < effectiveReleaseIssuedAtMs)
  ) {
    return { records, accepted: true, stale: false };
  }

  if (
    (existing?.latestReserveIssuedAtMs !== undefined
      && existing.latestReserveIssuedAtMs >= effectiveReleaseIssuedAtMs)
    || (existing?.releaseIssuedAtMs !== undefined
      && existing.releaseIssuedAtMs > effectiveReleaseIssuedAtMs)
  ) {
    return { records, accepted: false, stale: true };
  }

  const next: DestinationStorageGenerationFence = {
    claimId,
    sourceRegionId,
    releaseIssuedAtMs: effectiveReleaseIssuedAtMs,
    expiresAtMs: Math.max(
      existing?.expiresAtMs ?? 0,
      now + DESTINATION_STORAGE_GENERATION_FENCE_TTL_MS,
    ),
  };
  if (existing?.latestReserveIssuedAtMs !== undefined) {
    next.latestReserveIssuedAtMs = existing.latestReserveIssuedAtMs;
  }
  return {
    records: upsertFence(records, next),
    accepted: true,
    stale: false,
  };
}

function generationStampedEnv(env: StorageReservationEnv): StorageReservationEnv {
  let lastIssuedAtMs = 0;
  const nextIssuedAtMs = (): number => {
    lastIssuedAtMs = Math.max(Date.now(), lastIssuedAtMs + 1);
    return lastIssuedAtMs;
  };

  const regions = new Proxy(env.REGIONS, {
    get(target, property, receiver) {
      if (property !== "get") return Reflect.get(target, property, receiver);
      return (...getArgs: Parameters<StorageReservationEnv["REGIONS"]["get"]>) => {
        const stub = target.get(...getArgs);
        return new Proxy(stub, {
          get(stubTarget, stubProperty, stubReceiver) {
            if (stubProperty !== "fetch") {
              return Reflect.get(stubTarget, stubProperty, stubReceiver);
            }
            return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
              const request = new Request(input, init);
              const url = new URL(request.url);
              if (
                request.method !== "POST"
                || (url.pathname !== INTERNAL_STORAGE_RESERVE_PATH
                  && url.pathname !== INTERNAL_STORAGE_RELEASE_PATH)
              ) {
                return stub.fetch(request);
              }

              let body: unknown;
              try {
                body = await request.clone().json() as unknown;
              } catch {
                return stub.fetch(request);
              }
              if (!isRecord(body)) return stub.fetch(request);
              const field = url.pathname === INTERNAL_STORAGE_RESERVE_PATH
                ? "issuedAtMs"
                : "releaseIssuedAtMs";
              if (positiveFinite(body[field]) !== undefined) return stub.fetch(request);
              const headers = new Headers(request.headers);
              headers.delete("content-length");
              headers.set("content-type", "application/json");
              return stub.fetch(new Request(request, {
                headers,
                body: JSON.stringify({ ...body, [field]: nextIssuedAtMs() }),
              }));
            };
          },
        });
      };
    },
  });
  return { ...env, REGIONS: regions };
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

export class RegionDurableObject extends PathogenRegionDurableObject {
  private storageFenceQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly storageFenceState: DurableObjectState,
    env: StorageReservationEnv,
  ) {
    super(storageFenceState, generationStampedEnv(env));
  }

  private withStorageFence<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.storageFenceQueue.then(operation, operation);
    this.storageFenceQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async handleDestinationStorageFence(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.clone().json() as unknown;
    } catch {
      return super.fetch(request);
    }
    if (
      !isRecord(body)
      || typeof body.claimId !== "string"
      || body.claimId.trim() === ""
      || typeof body.sourceRegionId !== "string"
      || body.sourceRegionId.trim() === ""
    ) {
      return super.fetch(request);
    }

    const url = new URL(request.url);
    const stored = await this.storageFenceState.storage.get<unknown>(
      DESTINATION_STORAGE_GENERATION_FENCES_KEY,
    );
    if (url.pathname === INTERNAL_STORAGE_RESERVE_PATH) {
      const issuedAtMs = positiveFinite(body.issuedAtMs);
      const decision = applyDestinationStorageReserveFence(
        stored,
        body.sourceRegionId,
        body.claimId,
        issuedAtMs,
      );
      if (!decision.accepted) {
        return json({
          error: "stale destination storage reservation generation",
          claimId: body.claimId,
          stale: true,
        }, 409);
      }

      // Persist the generation before mutating the shorter-lived capacity row.
      // A crash can now at worst consume one generated attempt without granting
      // capacity; it can no longer grant capacity and lose the fence, which used
      // to let that old attempt resurrect after the 15-minute lease expired.
      if (issuedAtMs !== undefined) {
        await this.storageFenceState.storage.put(
          DESTINATION_STORAGE_GENERATION_FENCES_KEY,
          decision.records,
        );
      }
      return super.fetch(request);
    }

    const decision = applyDestinationStorageReleaseFence(
      stored,
      body.sourceRegionId,
      body.claimId,
      positiveFinite(body.releaseIssuedAtMs),
    );
    if (!decision.accepted) {
      return json({
        ok: true,
        claimId: body.claimId,
        released: false,
        stale: true,
      });
    }

    // Record the release watermark first. If the Worker dies before the
    // reservation row is deleted, an exact same-generation retry is explicitly
    // allowed above to finish the idempotent delete; older reserves stay fenced.
    await this.storageFenceState.storage.put(
      DESTINATION_STORAGE_GENERATION_FENCES_KEY,
      decision.records,
    );
    return super.fetch(request);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === "POST"
      && (url.pathname === INTERNAL_STORAGE_RESERVE_PATH
        || url.pathname === INTERNAL_STORAGE_RELEASE_PATH)
    ) {
      return this.withStorageFence(() => this.handleDestinationStorageFence(request));
    }
    return super.fetch(request);
  }
}