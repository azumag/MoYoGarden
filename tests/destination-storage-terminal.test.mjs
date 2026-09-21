import test from "node:test";
import assert from "node:assert/strict";
import {
  DESTINATION_STORAGE_TERMINAL_FENCE_TTL_MS,
  deriveLocallyCompletedDestinationStorageFences,
  destinationStorageTerminalBlocksReserve,
  normalizeDestinationStorageTerminalFences,
  upsertDestinationStorageTerminalFences,
} from "../dist-ts/src/destination-storage-terminal-region.js";

const NOW = 2_000_000;

function reservation(overrides = {}) {
  return {
    claimId: "claim-1",
    sourceRegionId: "garden-1",
    factionId: "faction-a",
    amount: 3,
    expiresAtMs: NOW + 60_000,
    ...overrides,
  };
}

function arrival(overrides = {}) {
  return {
    claimId: "claim-1",
    sourceRegionId: "garden-1",
    agentId: "agent-global:scout-1",
    resource: "wood",
    destinationStorageReserved: true,
    ...overrides,
  };
}

function agent(wood = 0) {
  return {
    id: "agent-global:scout-1",
    inventory: { wood, stone: 0, food: 0 },
  };
}

test("local cargo completion creates a terminal sink fence", () => {
  const fences = deriveLocallyCompletedDestinationStorageFences(
    [reservation()],
    [],
    [arrival()],
    [agent(0)],
    NOW,
  );

  assert.deepEqual(fences, [{
    claimId: "claim-1",
    sourceRegionId: "garden-1",
    completedAtMs: NOW,
    expiresAtMs: NOW + DESTINATION_STORAGE_TERMINAL_FENCE_TTL_MS,
  }]);
  assert.equal(
    destinationStorageTerminalBlocksReserve(fences, "garden-1", "claim-1", NOW),
    true,
  );
});

test("forwarded courier does not terminally fence the old sink", () => {
  const fences = deriveLocallyCompletedDestinationStorageFences(
    [reservation()],
    [],
    [arrival()],
    [],
    NOW,
  );

  assert.deepEqual(fences, []);
});

test("cargo still carried locally does not terminally fence the claim", () => {
  const fences = deriveLocallyCompletedDestinationStorageFences(
    [reservation()],
    [],
    [arrival()],
    [agent(2)],
    NOW,
  );

  assert.deepEqual(fences, []);
});

test("terminal fences are scoped by source and claim and expire boundedly", () => {
  const first = upsertDestinationStorageTerminalFences([], [{
    claimId: "claim-1",
    sourceRegionId: "garden-1",
    completedAtMs: NOW,
    expiresAtMs: NOW + DESTINATION_STORAGE_TERMINAL_FENCE_TTL_MS,
  }], NOW);
  const merged = upsertDestinationStorageTerminalFences(first, [{
    claimId: "claim-1",
    sourceRegionId: "garden-2",
    completedAtMs: NOW + 1,
    expiresAtMs: NOW + DESTINATION_STORAGE_TERMINAL_FENCE_TTL_MS,
  }], NOW);

  assert.equal(destinationStorageTerminalBlocksReserve(merged, "garden-1", "claim-1", NOW), true);
  assert.equal(destinationStorageTerminalBlocksReserve(merged, "garden-2", "claim-1", NOW), true);
  assert.equal(destinationStorageTerminalBlocksReserve(merged, "garden-1", "claim-2", NOW), false);
  assert.deepEqual(
    normalizeDestinationStorageTerminalFences(
      merged,
      NOW + DESTINATION_STORAGE_TERMINAL_FENCE_TTL_MS + 1,
    ),
    [],
  );
});

test("expired reservation does not get mistaken for local completion", () => {
  const fences = deriveLocallyCompletedDestinationStorageFences(
    [reservation({ expiresAtMs: NOW - 1 })],
    [],
    [arrival()],
    [agent(0)],
    NOW,
  );

  assert.deepEqual(fences, []);
});
