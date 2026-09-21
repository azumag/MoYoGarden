import test from "node:test";
import assert from "node:assert/strict";

import {
  arrivalOwnerLookupStep,
  retargetPendingArrivalRegistrations,
} from "../dist-ts/src/arrival-registration-region.js";
import {
  ARRIVAL_REGISTRATION_RETRY_TTL_MS,
  pendingArrivalRegistrationBlocksClaimRelease,
  upsertPendingArrivalRegistration,
} from "../dist-ts/src/storage-reservation-region.js";

const NOW = 2_000_000;
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

test("arrival owner lookup follows committed handoff forwarding but waits on in-flight handoff", () => {
  assert.deepEqual(
    arrivalOwnerLookupStep("garden-2", { present: false, forwardedRegionId: "hex-q2-r0" }),
    { kind: "forwarded", regionId: "hex-q2-r0" },
  );
  assert.deepEqual(
    arrivalOwnerLookupStep("garden-2", { present: false, handoffPending: true }),
    { kind: "pending" },
  );
  assert.deepEqual(
    arrivalOwnerLookupStep("garden-2", { present: true }),
    { kind: "owned", regionId: "garden-2" },
  );
  assert.deepEqual(
    arrivalOwnerLookupStep("garden-2", { present: false }),
    { kind: "absent" },
  );
});

test("retargeting an arrival retry preserves the bounded lease and release fence", () => {
  const pending = upsertPendingArrivalRegistration([], failedRegistration(), NOW);
  const originalExpiry = pending[0]?.expiresAtMs;
  assert.equal(originalExpiry, NOW + ARRIVAL_REGISTRATION_RETRY_TTL_MS);

  const retargeted = retargetPendingArrivalRegistrations(
    pending,
    CLAIM,
    "garden-2",
    "hex-q2-r0",
    NOW + 1,
  );

  assert.equal(retargeted.length, 1);
  assert.equal(retargeted[0]?.targetRegionId, "hex-q2-r0");
  assert.equal(retargeted[0]?.expiresAtMs, originalExpiry);
  assert.deepEqual(retargeted[0]?.payload, pending[0]?.payload);
  assert.equal(
    pendingArrivalRegistrationBlocksClaimRelease(retargeted, CLAIM, NOW + 2),
    true,
  );
  assert.equal(
    pendingArrivalRegistrationBlocksClaimRelease(
      retargeted,
      CLAIM,
      NOW + ARRIVAL_REGISTRATION_RETRY_TTL_MS + 1,
    ),
    false,
  );
});
