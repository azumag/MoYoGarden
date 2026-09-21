import assert from "node:assert/strict";
import test from "node:test";

import {
  DESTINATION_STORAGE_RELEASE_RETRY_TTL_MS,
  clearPendingDestinationStorageRelease,
  isRetryableDestinationStorageReleaseStatus,
  normalizePendingDestinationStorageReleases,
  upsertPendingDestinationStorageRelease,
} from "../dist-ts/src/storage-release-retry-region.js";

const BASE_RELEASE = {
  claimId: "claim-a",
  sourceRegionId: "garden-1",
  targetRegionId: "garden-2",
};

test("destination storage release retry keeps the newest generation for one claim", () => {
  const now = 1_000_000;
  const first = upsertPendingDestinationStorageRelease(
    undefined,
    { ...BASE_RELEASE, releaseIssuedAtMs: 100 },
    now,
  );
  const newer = upsertPendingDestinationStorageRelease(
    first,
    { ...BASE_RELEASE, releaseIssuedAtMs: 101 },
    now + 1,
  );
  const staleFailure = upsertPendingDestinationStorageRelease(
    newer,
    { ...BASE_RELEASE, releaseIssuedAtMs: 99 },
    now + 2,
  );

  assert.equal(staleFailure.length, 1);
  assert.equal(staleFailure[0].releaseIssuedAtMs, 101);
  assert.equal(staleFailure[0].expiresAtMs, now + 1 + DESTINATION_STORAGE_RELEASE_RETRY_TTL_MS);
});

test("an older release acknowledgement cannot clear a newer pending generation", () => {
  const now = 2_000_000;
  const pending = upsertPendingDestinationStorageRelease(
    undefined,
    { ...BASE_RELEASE, releaseIssuedAtMs: 201 },
    now,
  );

  const afterOldAck = clearPendingDestinationStorageRelease(
    pending,
    BASE_RELEASE.targetRegionId,
    BASE_RELEASE.sourceRegionId,
    BASE_RELEASE.claimId,
    200,
    now + 1,
  );
  assert.equal(afterOldAck.length, 1);
  assert.equal(afterOldAck[0].releaseIssuedAtMs, 201);

  const afterExactAck = clearPendingDestinationStorageRelease(
    afterOldAck,
    BASE_RELEASE.targetRegionId,
    BASE_RELEASE.sourceRegionId,
    BASE_RELEASE.claimId,
    201,
    now + 2,
  );
  assert.deepEqual(afterExactAck, []);
});

test("release retry normalization is bounded and prunes expired or malformed records", () => {
  const now = 3_000_000;
  const active = {
    ...BASE_RELEASE,
    releaseIssuedAtMs: 300,
    expiresAtMs: now + 1_000,
  };
  const duplicateOlder = {
    ...BASE_RELEASE,
    releaseIssuedAtMs: 299,
    expiresAtMs: now + 2_000,
  };
  const expired = {
    claimId: "claim-expired",
    sourceRegionId: "garden-1",
    targetRegionId: "garden-3",
    releaseIssuedAtMs: 10,
    expiresAtMs: now,
  };

  assert.deepEqual(
    normalizePendingDestinationStorageReleases([
      active,
      duplicateOlder,
      expired,
      { claimId: "broken" },
    ], now),
    [active],
  );
});

test("only transient destination storage release responses remain retryable", () => {
  assert.equal(isRetryableDestinationStorageReleaseStatus(408), true);
  assert.equal(isRetryableDestinationStorageReleaseStatus(429), true);
  assert.equal(isRetryableDestinationStorageReleaseStatus(500), true);
  assert.equal(isRetryableDestinationStorageReleaseStatus(503), true);
  assert.equal(isRetryableDestinationStorageReleaseStatus(400), false);
  assert.equal(isRetryableDestinationStorageReleaseStatus(409), false);
  assert.equal(isRetryableDestinationStorageReleaseStatus(200), false);
});