import test from "node:test";
import assert from "node:assert/strict";

import {
  DESTINATION_STORAGE_GENERATION_FENCE_TTL_MS,
  applyDestinationStorageReleaseFence,
  applyDestinationStorageReserveFence,
  nextDestinationStorageIssuedAtMs,
  normalizeDestinationStorageGenerationFences,
} from "../dist-ts/src/storage-reservation-region.js";

const SOURCE = "garden-1";
const CLAIM = "claim-1";
const NOW = 1_000_000;

test("source-issued generations stay monotonic across restart and clock rollback", () => {
  const first = nextDestinationStorageIssuedAtMs(undefined, 1_000);
  assert.equal(first, 1_000);

  const sameClockAfterRestart = nextDestinationStorageIssuedAtMs(first, 1_000);
  assert.equal(sameClockAfterRestart, 1_001);

  const rollbackAfterRestart = nextDestinationStorageIssuedAtMs(sameClockAfterRestart, 900);
  assert.equal(rollbackAfterRestart, 1_002);

  const normalAdvance = nextDestinationStorageIssuedAtMs(rollbackAfterRestart, 2_000);
  assert.equal(normalAdvance, 2_000);
});

test("release tombstone rejects an older delayed reserve but permits a newer retry", () => {
  const reserved = applyDestinationStorageReserveFence([], SOURCE, CLAIM, 200, NOW);
  assert.equal(reserved.accepted, true);
  const released = applyDestinationStorageReleaseFence(
    reserved.records,
    SOURCE,
    CLAIM,
    300,
    NOW + 1,
  );
  assert.equal(released.accepted, true);

  const stale = applyDestinationStorageReserveFence(
    released.records,
    SOURCE,
    CLAIM,
    250,
    NOW + 2,
  );
  assert.equal(stale.accepted, false);
  assert.equal(stale.stale, true);

  const reacquired = applyDestinationStorageReserveFence(
    released.records,
    SOURCE,
    CLAIM,
    400,
    NOW + 3,
  );
  assert.equal(reacquired.accepted, true);
  assert.equal(reacquired.records[0].latestReserveIssuedAtMs, 400);
  assert.equal(reacquired.records[0].releaseIssuedAtMs, 300);
});

test("a reserve generation is single-use and cannot replay after its capacity lease disappears", () => {
  const reserved = applyDestinationStorageReserveFence([], SOURCE, CLAIM, 200, NOW);
  assert.equal(reserved.accepted, true);

  const replayed = applyDestinationStorageReserveFence(
    reserved.records,
    SOURCE,
    CLAIM,
    200,
    NOW + 15 * 60 * 1_000 + 1,
  );
  assert.equal(replayed.accepted, false);
  assert.equal(replayed.stale, true);

  const freshRetry = applyDestinationStorageReserveFence(
    reserved.records,
    SOURCE,
    CLAIM,
    201,
    NOW + 15 * 60 * 1_000 + 2,
  );
  assert.equal(freshRetry.accepted, true);
  assert.equal(freshRetry.records[0].latestReserveIssuedAtMs, 201);
});

test("an older release cannot delete a newer reservation generation", () => {
  const reserved = applyDestinationStorageReserveFence([], SOURCE, CLAIM, 400, NOW);
  const staleRelease = applyDestinationStorageReleaseFence(
    reserved.records,
    SOURCE,
    CLAIM,
    300,
    NOW + 1,
  );
  assert.equal(staleRelease.accepted, false);
  assert.equal(staleRelease.stale, true);

  const sameGeneration = applyDestinationStorageReleaseFence(
    reserved.records,
    SOURCE,
    CLAIM,
    400,
    NOW + 2,
  );
  assert.equal(sameGeneration.accepted, false);
  assert.equal(sameGeneration.stale, true);

  const newerRelease = applyDestinationStorageReleaseFence(
    reserved.records,
    SOURCE,
    CLAIM,
    401,
    NOW + 3,
  );
  assert.equal(newerRelease.accepted, true);
  assert.equal(newerRelease.records[0].releaseIssuedAtMs, 401);
});

test("an already-recorded release generation can retry its idempotent capacity delete", () => {
  const reserved = applyDestinationStorageReserveFence([], SOURCE, CLAIM, 400, NOW);
  const released = applyDestinationStorageReleaseFence(
    reserved.records,
    SOURCE,
    CLAIM,
    401,
    NOW + 1,
  );
  assert.equal(released.accepted, true);

  // The production path persists this release watermark before deleting the
  // capacity row. A retry with the exact same generation must therefore be
  // admitted so it can finish the delete after a crash between those writes.
  const retry = applyDestinationStorageReleaseFence(
    released.records,
    SOURCE,
    CLAIM,
    401,
    NOW + 2,
  );
  assert.equal(retry.accepted, true);
  assert.equal(retry.stale, false);
  assert.deepEqual(retry.records, released.records);

  const older = applyDestinationStorageReleaseFence(
    released.records,
    SOURCE,
    CLAIM,
    400,
    NOW + 3,
  );
  assert.equal(older.accepted, false);
  assert.equal(older.stale, true);
});

test("rolling legacy requests remain compatible only before generated ordering exists", () => {
  const legacyReserve = applyDestinationStorageReserveFence([], SOURCE, CLAIM, undefined, NOW);
  assert.equal(legacyReserve.accepted, true);
  assert.deepEqual(legacyReserve.records, []);

  const legacyRelease = applyDestinationStorageReleaseFence([], SOURCE, CLAIM, undefined, NOW + 1);
  assert.equal(legacyRelease.accepted, true);
  assert.equal(legacyRelease.records[0].releaseIssuedAtMs, NOW + 1);

  const delayedLegacyReserve = applyDestinationStorageReserveFence(
    legacyRelease.records,
    SOURCE,
    CLAIM,
    undefined,
    NOW + 2,
  );
  assert.equal(delayedLegacyReserve.accepted, false);

  const generatedReserve = applyDestinationStorageReserveFence([], SOURCE, CLAIM, 500, NOW + 3);
  const legacyReleaseAfterGeneratedReserve = applyDestinationStorageReleaseFence(
    generatedReserve.records,
    SOURCE,
    CLAIM,
    undefined,
    NOW + 4,
  );
  assert.equal(legacyReleaseAfterGeneratedReserve.accepted, false);
});

test("expired tombstones are removed and claim keys remain isolated", () => {
  const records = [
    {
      claimId: CLAIM,
      sourceRegionId: SOURCE,
      releaseIssuedAtMs: 300,
      expiresAtMs: NOW + DESTINATION_STORAGE_GENERATION_FENCE_TTL_MS,
    },
    {
      claimId: "claim-2",
      sourceRegionId: SOURCE,
      latestReserveIssuedAtMs: 500,
      expiresAtMs: NOW + DESTINATION_STORAGE_GENERATION_FENCE_TTL_MS + 10,
    },
  ];
  const normalized = normalizeDestinationStorageGenerationFences(
    records,
    NOW + DESTINATION_STORAGE_GENERATION_FENCE_TTL_MS + 1,
  );
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].claimId, "claim-2");

  const independent = applyDestinationStorageReserveFence(
    records,
    "garden-2",
    CLAIM,
    100,
    NOW + 2,
  );
  assert.equal(independent.accepted, true);
});