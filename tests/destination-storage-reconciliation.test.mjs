import test from "node:test";
import assert from "node:assert/strict";

import {
  reconcileReleasedDestinationStorageReservations,
} from "../dist-ts/src/destination-storage-reconciliation-region.js";

const NOW = 1_000_000;
const BASE_RESERVATION = {
  claimId: "claim-1",
  sourceRegionId: "garden-1",
  factionId: "faction-a",
  amount: 3,
  expiresAtMs: NOW + 15 * 60 * 1_000,
};

test("release watermark prunes a capacity row left behind by a crash", () => {
  const result = reconcileReleasedDestinationStorageReservations(
    [BASE_RESERVATION],
    [{
      claimId: "claim-1",
      sourceRegionId: "garden-1",
      latestReserveIssuedAtMs: 200,
      releaseIssuedAtMs: 300,
      expiresAtMs: NOW + 60_000,
    }],
    NOW,
  );

  assert.equal(result.changed, true);
  assert.equal(result.pruned, 1);
  assert.deepEqual(result.records, []);
});

test("a newer accepted reserve generation keeps reacquired capacity", () => {
  const result = reconcileReleasedDestinationStorageReservations(
    [BASE_RESERVATION],
    [{
      claimId: "claim-1",
      sourceRegionId: "garden-1",
      latestReserveIssuedAtMs: 400,
      releaseIssuedAtMs: 300,
      expiresAtMs: NOW + 60_000,
    }],
    NOW,
  );

  assert.equal(result.changed, false);
  assert.equal(result.pruned, 0);
  assert.deepEqual(result.records, [BASE_RESERVATION]);
});

test("release ownership remains isolated by source region and claim", () => {
  const otherSource = { ...BASE_RESERVATION, sourceRegionId: "garden-2" };
  const otherClaim = { ...BASE_RESERVATION, claimId: "claim-2" };
  const result = reconcileReleasedDestinationStorageReservations(
    [BASE_RESERVATION, otherSource, otherClaim],
    [{
      claimId: "claim-1",
      sourceRegionId: "garden-1",
      releaseIssuedAtMs: 300,
      expiresAtMs: NOW + 60_000,
    }],
    NOW,
  );

  assert.equal(result.pruned, 1);
  assert.deepEqual(result.records, [otherSource, otherClaim]);
});

test("expired release tombstones cannot delete a later-visible reservation", () => {
  const result = reconcileReleasedDestinationStorageReservations(
    [BASE_RESERVATION],
    [{
      claimId: "claim-1",
      sourceRegionId: "garden-1",
      releaseIssuedAtMs: 300,
      expiresAtMs: NOW - 1,
    }],
    NOW,
  );

  assert.equal(result.changed, false);
  assert.equal(result.pruned, 0);
  assert.deepEqual(result.records, [BASE_RESERVATION]);
});

test("malformed legacy rows are left to the existing reservation normalizer", () => {
  const malformed = { claimId: "claim-1" };
  const result = reconcileReleasedDestinationStorageReservations(
    [malformed, BASE_RESERVATION],
    [{
      claimId: "claim-1",
      sourceRegionId: "garden-1",
      releaseIssuedAtMs: 300,
      expiresAtMs: NOW + 60_000,
    }],
    NOW,
  );

  assert.equal(result.pruned, 1);
  assert.deepEqual(result.records, [malformed]);
});
