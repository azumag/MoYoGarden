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

export interface PendingArrivalRegistration {
  claimId: string;
  targetRegionId: string;
  payload: Record<string, unknown>;
  expiresAtMs: number;
}

const INTERNAL_STORAGE_RESERVE_PATH = "/api/internal/autonomy/storage/reserve";
const INTERNAL_STORAGE_RELEASE_PATH = "/api/internal/autonomy/storage/release";
const INTERNAL_CLAIM_REGISTER_PATH = "/api/internal/autonomy/claim/register";
const INTERNAL_CLAIM_RELEASE_PATH = "/api/internal/autonomy/claim/release";
const DESTINATION_STORAGE_GENERATION_FENCES_KEY =
  "handoff:autonomy:destination-storage-generation:v1";
const DESTINATION_STORAGE_SOURCE_GENERATION_KEY =
  "handoff:autonomy:destination-storage-source-generation:v1";
const PENDING_ARRIVAL_REGISTRATIONS_KEY =
  "handoff:autonomy:arrival-registration-retry:v1";
export const DESTINATION_STORAGE_GENERATION_FENCE_TTL_MS = 24 * 60 * 60 * 1_000;
export const ARRIVAL_REGISTRATION_RETRY_TTL_MS = 6 * 60 * 60 * 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function nextDestinationStorageIssuedAtMs(
  stored: unknown,
  now = Date.now(),
): number {
  const previous = positiveFinite(stored) ?? 0;
  return Math.max(now, previous + 1);
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

function isPendingArrivalRegistration(value: unknown): value is PendingArrivalRegistration {
  if (
    !isRecord(value)
    || typeof value.claimId !== "string"
    || value.claimId.length === 0
    || typeof value.targetRegionId !== "string"
    || value.targetRegionId.length === 0
    || !isRecord(value.payload)
    || value.payload.claimId !== value.claimId
    || positiveFinite(value.expiresAtMs) === undefined
  ) {
    return false;
  }
  return true;
}

function pendingArrivalKey(entry: Pick<PendingArrivalRegistration, "claimId" | "targetRegionId">): string {
  return `${entry.targetRegionId}\u0000${entry.claimId}`;
}

export function normalizePendingArrivalRegistrations(
  value: unknown,
  now = Date.now(),
): PendingArrivalRegistration[] {
  if (!Array.isArray(value)) return [];
  const pending = new Map<string, PendingArrivalRegistration>();
  for (const candidate of value) {
    if (!isPendingArrivalRegistration(candidate) || candidate.expiresAtMs <= now) continue;
    const key = pendingArrivalKey(candidate);
    const current = pending.get(key);
    if (current === undefined || current.expiresAtMs < candidate.expiresAtMs) {
      pending.set(key, {
        claimId: candidate.claimId,
        targetRegionId: candidate.targetRegionId,
        payload: { ...candidate.payload },
        expiresAtMs: candidate.expiresAtMs,
      });
    }
  }
  return [...pending.values()].sort((a, b) =>
    a.targetRegionId.localeCompare(b.targetRegionId) || a.claimId.localeCompare(b.claimId)
  );
}

export function upsertPendingArrivalRegistration(
  value: unknown,
  registration: Omit<PendingArrivalRegistration, "expiresAtMs">,
  now = Date.now(),
): PendingArrivalRegistration[] {
  const records = normalizePendingArrivalRegistrations(value, now);
  const next: PendingArrivalRegistration = {
    ...registration,
    payload: { ...registration.payload },
    expiresAtMs: now + ARRIVAL_REGISTRATION_RETRY_TTL_MS,
  };
  const key = pendingArrivalKey(next);
  return [
    ...records.filter((entry) => pendingArrivalKey(entry) !== key),
    next,
  ].sort((a, b) =>
    a.targetRegionId.localeCompare(b.targetRegionId) || a.claimId.localeCompare(b.claimId)
  );
}

export function clearPendingArrivalRegistration(
  value: unknown,
  targetRegionId: string,
  claimId: string,
  now = Date.now(),
): PendingArrivalRegistration[] {
  return normalizePendingArrivalRegistrations(value, now).filter((entry) =>
    entry.targetRegionId !== targetRegionId || entry.claimId !== claimId
  );
}

export function pendingArrivalRegistrationBlocksClaimRelease(
  value: unknown,
  claimId: string,
  now = Date.now(),
): boolean {
  return normalizePendingArrivalRegistrations(value, now).some((entry) => entry.claimId === claimId);
}

function pendingArrivalRegistrationFromRequest(
  request: Request,
  body: Record<string, unknown>,
  now = Date.now(),
): Omit<PendingArrivalRegistration, "expiresAtMs"> | undefined {
  const targetRegionId = request.headers.get("x-moyo-region-internal")?.trim();
  const claimId = typeof body.claimId === "string" ? body.claimId.trim() : "";
  if (targetRegionId === undefined || targetRegionId === "" || claimId === "") return undefined;
  return {
    claimId,
    targetRegionId,
    payload: { ...body },
  };
}

function generationStampedEnv(
  env: StorageReservationEnv,
  state: DurableObjectState,
): StorageReservationEnv {
  let lastIssuedAtMs: number | undefined;
  let generationQueue: Promise<void> = Promise.resolve();
  const nextIssuedAtMs = (): Promise<number> => {
    const operation = generationQueue.then(async () => {
      if (lastIssuedAtMs === undefined) {
        const stored = await state.storage.get<unknown>(DESTINATION_STORAGE_SOURCE_GENERATION_KEY);
        lastIssuedAtMs = positiveFinite(stored) ?? 0;
      }
      const next = nextDestinationStorageIssuedAtMs(lastIssuedAtMs);
      lastIssuedAtMs = next;
      await state.storage.put(DESTINATION_STORAGE_SOURCE_GENERATION_KEY, next);
      return next;
    });
    generationQueue = operation.then(() => undefined, () => undefined);
    return operation;
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
              const issuedAtMs = await nextIssuedAtMs();
              return stub.fetch(new Request(request, {
                headers,
                body: JSON.stringify({ ...body, [field]: issuedAtMs }),
              }));
            };
          },
        });
      };
    },
  });
  return { ...env, REGIONS: regions };
}

function reliableArrivalRegistrationEnv(
  env: StorageReservationEnv,
  state: DurableObjectState,
): StorageReservationEnv {
  let registrationQueue: Promise<void> = Promise.resolve();
  const updatePending = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = registrationQueue.then(operation, operation);
    registrationQueue = run.then(() => undefined, () => undefined);
    return run;
  };

  const rememberFailure = async (
    request: Request,
    body: Record<string, unknown>,
  ): Promise<void> => {
    const registration = pendingArrivalRegistrationFromRequest(request, body);
    if (registration === undefined) return;
    await updatePending(async () => {
      const stored = await state.storage.get<unknown>(PENDING_ARRIVAL_REGISTRATIONS_KEY);
      await state.storage.put(
        PENDING_ARRIVAL_REGISTRATIONS_KEY,
        upsertPendingArrivalRegistration(stored, registration),
      );
    });
  };

  const acknowledge = async (
    request: Request,
    body: Record<string, unknown>,
  ): Promise<void> => {
    const registration = pendingArrivalRegistrationFromRequest(request, body);
    if (registration === undefined) return;
    await updatePending(async () => {
      const stored = await state.storage.get<unknown>(PENDING_ARRIVAL_REGISTRATIONS_KEY);
      const next = clearPendingArrivalRegistration(
        stored,
        registration.targetRegionId,
        registration.claimId,
      );
      if (!Array.isArray(stored) || next.length !== stored.length) {
        await state.storage.put(PENDING_ARRIVAL_REGISTRATIONS_KEY, next);
      }
    });
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
                || (url.pathname !== INTERNAL_CLAIM_REGISTER_PATH
                  && url.pathname !== INTERNAL_CLAIM_RELEASE_PATH)
              ) {
                return stub.fetch(request);
              }

              let body: unknown;
              try {
                body = await request.clone().json() as unknown;
              } catch {
                return stub.fetch(request);
              }
              if (!isRecord(body) || typeof body.claimId !== "string") return stub.fetch(request);

              if (url.pathname === INTERNAL_CLAIM_RELEASE_PATH) {
                const stored = await state.storage.get<unknown>(PENDING_ARRIVAL_REGISTRATIONS_KEY);
                if (pendingArrivalRegistrationBlocksClaimRelease(stored, body.claimId)) {
                  return json({
                    error: "arrival claim registration is still pending",
                    claimId: body.claimId,
                    retryable: true,
                  }, 503);
                }
                return stub.fetch(request);
              }

              try {
                const response = await stub.fetch(request);
                if (response.ok) await acknowledge(request, body);
                else await rememberFailure(request, body);
                return response;
              } catch (error) {
                await rememberFailure(request, body);
                throw error;
              }
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
  private readonly directEnv: StorageReservationEnv;

  constructor(
    private readonly storageFenceState: DurableObjectState,
    env: StorageReservationEnv,
  ) {
    super(
      storageFenceState,
      generationStampedEnv(reliableArrivalRegistrationEnv(env, storageFenceState), storageFenceState),
    );
    this.directEnv = env;
  }

  private withStorageFence<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.storageFenceQueue.then(operation, operation);
    this.storageFenceQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async retryPendingArrivalRegistrations(): Promise<void> {
    const now = Date.now();
    const stored = await this.storageFenceState.storage.get<unknown>(
      PENDING_ARRIVAL_REGISTRATIONS_KEY,
    );
    const pending = normalizePendingArrivalRegistrations(stored, now);
    if (pending.length === 0) {
      if (Array.isArray(stored) && stored.length > 0) {
        await this.storageFenceState.storage.put(PENDING_ARRIVAL_REGISTRATIONS_KEY, []);
      }
      return;
    }

    const keep: PendingArrivalRegistration[] = [];
    for (const registration of pending) {
      try {
        const stub = this.directEnv.REGIONS.get(
          this.directEnv.REGIONS.idFromName(registration.targetRegionId),
        );
        const response = await stub.fetch(new Request(
          `https://moyo.internal${INTERNAL_CLAIM_REGISTER_PATH}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-moyo-region-internal": registration.targetRegionId,
            },
            body: JSON.stringify(registration.payload),
          },
        ));
        if (!response.ok) keep.push(registration);
      } catch {
        keep.push(registration);
      }
    }

    if (
      !Array.isArray(stored)
      || keep.length !== stored.length
      || pending.length !== stored.length
    ) {
      await this.storageFenceState.storage.put(PENDING_ARRIVAL_REGISTRATIONS_KEY, keep);
    }
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

  override async alarm(): Promise<void> {
    // Ownership handoff can commit before the destination installs its arrival
    // claim. Retry that metadata ACK first, and keep upstream claim release
    // fenced until the destination confirms it. This lets multi-hop couriers
    // survive a transient/non-2xx registration failure without resurrecting or
    // prematurely dropping the ultimate source reservation.
    await this.retryPendingArrivalRegistrations();
    await super.alarm();
  }
}
