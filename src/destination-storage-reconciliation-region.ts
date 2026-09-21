import baseWorker, {
  RegionDurableObject as StorageReleaseRetryRegionDurableObject,
} from "./storage-release-retry-region.js";
import {
  normalizeDestinationStorageGenerationFences,
  type DestinationStorageGenerationFence,
} from "./storage-reservation-region.js";

interface DestinationStorageReconciliationEnv {
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

export interface DestinationStorageReservationReconciliation {
  records: unknown;
  changed: boolean;
  pruned: number;
}

const DESTINATION_STORAGE_RESERVATIONS_KEY = "handoff:autonomy:destination-storage:v1";
const DESTINATION_STORAGE_GENERATION_FENCES_KEY =
  "handoff:autonomy:destination-storage-generation:v1";
const INTERNAL_STORAGE_RESERVE_PATH = "/api/internal/autonomy/storage/reserve";
const INTERNAL_CLAIM_REGISTER_PATH = "/api/internal/autonomy/claim/register";
const INTERNAL_HALO_EDGE_PATH = "/api/internal/halo/edge";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reservationKey(sourceRegionId: string, claimId: string): string {
  return `${sourceRegionId}\u0000${claimId}`;
}

export function destinationStorageReleaseDominates(
  fence: DestinationStorageGenerationFence,
): boolean {
  return fence.releaseIssuedAtMs !== undefined
    && fence.releaseIssuedAtMs > (fence.latestReserveIssuedAtMs ?? 0);
}

export function reconcileReleasedDestinationStorageReservations(
  value: unknown,
  fenceValue: unknown,
  now = Date.now(),
): DestinationStorageReservationReconciliation {
  if (!Array.isArray(value)) {
    return { records: value, changed: false, pruned: 0 };
  }

  const released = new Set(
    normalizeDestinationStorageGenerationFences(fenceValue, now)
      .filter(destinationStorageReleaseDominates)
      .map((fence) => reservationKey(fence.sourceRegionId, fence.claimId)),
  );
  if (released.size === 0) {
    return { records: value, changed: false, pruned: 0 };
  }

  const records = value.filter((candidate) => {
    if (!isRecord(candidate)) return true;
    const sourceRegionId = typeof candidate.sourceRegionId === "string"
      ? candidate.sourceRegionId
      : undefined;
    const claimId = typeof candidate.claimId === "string" ? candidate.claimId : undefined;
    if (sourceRegionId === undefined || claimId === undefined) return true;
    return !released.has(reservationKey(sourceRegionId, claimId));
  });
  const pruned = value.length - records.length;
  return {
    records,
    changed: pruned > 0,
    pruned,
  };
}

function requestConsumesDestinationStorageCapacity(request: Request): boolean {
  const path = new URL(request.url).pathname;
  return (
    request.method === "GET" && path === INTERNAL_HALO_EDGE_PATH
  ) || (
    request.method === "POST"
    && (path === INTERNAL_STORAGE_RESERVE_PATH || path === INTERNAL_CLAIM_REGISTER_PATH)
  );
}

export class RegionDurableObject extends StorageReleaseRetryRegionDurableObject {
  constructor(
    private readonly destinationStorageReconciliationState: DurableObjectState,
    env: DestinationStorageReconciliationEnv,
  ) {
    super(destinationStorageReconciliationState, env);
  }

  private async reconcileReleasedDestinationStorageReservations(): Promise<void> {
    await this.destinationStorageReconciliationState.blockConcurrencyWhile(async () => {
      const [reservations, fences] = await Promise.all([
        this.destinationStorageReconciliationState.storage.get<unknown>(
          DESTINATION_STORAGE_RESERVATIONS_KEY,
        ),
        this.destinationStorageReconciliationState.storage.get<unknown>(
          DESTINATION_STORAGE_GENERATION_FENCES_KEY,
        ),
      ]);
      const reconciliation = reconcileReleasedDestinationStorageReservations(
        reservations,
        fences,
      );
      if (reconciliation.changed) {
        await this.destinationStorageReconciliationState.storage.put(
          DESTINATION_STORAGE_RESERVATIONS_KEY,
          reconciliation.records,
        );
      }
    });
  }

  override async fetch(request: Request): Promise<Response> {
    // The generation fence is the durable ordering authority. If a release
    // watermark survived but the shorter-lived capacity-row delete did not,
    // remove that shadow row before any path can advertise or consume sink
    // headroom. A later accepted reserve generation dominates the release and
    // is therefore preserved by the pure reconciliation helper above.
    if (requestConsumesDestinationStorageCapacity(request)) {
      await this.reconcileReleasedDestinationStorageReservations();
    }
    return super.fetch(request);
  }

  override async alarm(): Promise<void> {
    // Recovery must not depend on another source DO surviving long enough to
    // resend its release. Alarm maintenance self-heals the target from its own
    // persisted generation watermark first, then runs the existing bounded
    // release/arrival retry and simulation chain.
    await this.reconcileReleasedDestinationStorageReservations();
    await super.alarm();
  }
}

export default baseWorker;
