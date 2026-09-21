import test from "node:test";
import assert from "node:assert/strict";

import {
  ARRIVAL_REGISTRATION_RETRY_TTL_MS,
  clearPendingArrivalRegistration,
  normalizePendingArrivalRegistrations,
  pendingArrivalRegistrationBlocksClaimRelease,
  upsertPendingArrivalRegistration,
} from "../dist-ts/src/storage-reservation-region.js";

const NOW = 1_000_000;
const CLAIM = "autonomy-claim:garden-1:agent-1:42:E:garden-2";

function failedRegistration(targetRegionId = "garden-2") {
  return {
    claimId: CLAIM,
    targetRegionId,
    payload: {
      claimId: CLAIM,
      sourceRegionId: "garden-1",
      agentId: "agent-global:garden-1:agent-1",
      resource: "wood",
      returnToSourceStorage: true,
    },
  };
}

test("failed arrival registration fences upstream claim release until destination ACK", () => {
  const pending = upsertPendingArrivalRegistration([], failedRegistration(), NOW);
  assert.equal(pending.length, 1);
  assert.equal(pendingArrivalRegistrationBlocksClaimRelease(pending, CLAIM, NOW + 1), true);

  const acknowledged = clearPendingArrivalRegistration(pending, "garden-2", CLAIM, NOW + 2);
  assert.deepEqual(acknowledged, []);
  assert.equal(
    pendingArrivalRegistrationBlocksClaimRelease(acknowledged, CLAIM, NOW + 2),
    false,
  );
});

test("arrival registration retry fence is bounded and cannot leak forever", () => {
  const pending = upsertPendingArrivalRegistration([], failedRegistration(), NOW);
  assert.equal(
    pendingArrivalRegistrationBlocksClaimRelease(
      pending,
      CLAIM,
      NOW + ARRIVAL_REGISTRATION_RETRY_TTL_MS - 1,
    ),
    true,
  );
  assert.equal(
    pendingArrivalRegistrationBlocksClaimRelease(
      pending,
      CLAIM,
      NOW + ARRIVAL_REGISTRATION_RETRY_TTL_MS + 1,
    ),
    false,
  );
  assert.deepEqual(
    normalizePendingArrivalRegistrations(
      pending,
      NOW + ARRIVAL_REGISTRATION_RETRY_TTL_MS + 1,
    ),
    [],
  );
});

test("retry records are isolated by target and duplicate failure refreshes one record", () => {
  const east = upsertPendingArrivalRegistration([], failedRegistration("garden-2"), NOW);
  const northEast = upsertPendingArrivalRegistration(
    east,
    {
      ...failedRegistration("garden-3"),
      claimId: `${CLAIM}:second`,
      payload: {
        ...failedRegistration("garden-3").payload,
        claimId: `${CLAIM}:second`,
      },
    },
    NOW + 10,
  );
  const refreshed = upsertPendingArrivalRegistration(northEast, failedRegistration("garden-2"), NOW + 20);

  assert.equal(refreshed.length, 2);
  const original = refreshed.find((entry) => entry.targetRegionId === "garden-2");
  assert.equal(original?.expiresAtMs, NOW + 20 + ARRIVAL_REGISTRATION_RETRY_TTL_MS);
  assert.equal(
    pendingArrivalRegistrationBlocksClaimRelease(refreshed, `${CLAIM}:second`, NOW + 21),
    true,
  );
});
