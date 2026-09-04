import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceOutgoingHandoff,
  commitIncomingHandoff,
  pendingIncomingHandoffs,
  pendingOutgoingHandoffs,
  prepareIncomingHandoff,
  reserveOutgoingHandoff,
} from "../dist-ts/src/agent-handoff.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function envelope(overrides = {}) {
  const state = createInitialWorld({ seed: 8101, width: 40, height: 24 });
  const agent = structuredClone(state.agents[0]);
  agent.position = { x: 30, y: 11 };
  delete agent.task;
  return {
    transferId: "handoff-ember-1",
    fromRegionId: "garden-1",
    toRegionId: "garden-2",
    direction: "east",
    sourcePosition: { x: 30, y: 11 },
    targetPosition: { x: 8, y: 11 },
    agent,
    createdAtTick: 120,
    ...overrides,
  };
}

test("outgoing reservation is idempotent and keeps the full agent snapshot", () => {
  const transfer = envelope();
  const first = reserveOutgoingHandoff([], transfer, 120);
  assert.equal(first.ok, true);
  assert.equal(first.records.length, 1);
  assert.deepEqual(first.records[0].envelope.agent, transfer.agent);

  const retry = reserveOutgoingHandoff(first.records, structuredClone(transfer), 121);
  assert.equal(retry.ok, true);
  assert.equal(retry.records.length, 1);
  assert.equal(retry.record.phase, "reserved");
  assert.deepEqual(retry.record.envelope.agent, transfer.agent);
});

test("same transfer id cannot be reused for a different handoff", () => {
  const first = reserveOutgoingHandoff([], envelope(), 120);
  assert.equal(first.ok, true);
  const conflict = reserveOutgoingHandoff(
    first.records,
    envelope({ toRegionId: "garden-3", targetPosition: { x: 19, y: 22 } }),
    121,
  );
  assert.equal(conflict.ok, false);
  assert.match(conflict.reason, /different handoff/);
  assert.equal(conflict.records.length, 1);
});

test("one agent cannot have two simultaneous outgoing transfers", () => {
  const first = reserveOutgoingHandoff([], envelope(), 120);
  assert.equal(first.ok, true);
  const second = reserveOutgoingHandoff(
    first.records,
    envelope({ transferId: "handoff-ember-2", toRegionId: "garden-3" }),
    121,
  );
  assert.equal(second.ok, false);
  assert.match(second.reason, /in-flight outgoing/);
});

test("outgoing phase only moves forward and retries do not duplicate state", () => {
  const reserved = reserveOutgoingHandoff([], envelope(), 120);
  const detached = advanceOutgoingHandoff(reserved.records, "handoff-ember-1", "detached", 121);
  assert.equal(detached.ok, true);
  assert.equal(detached.record.phase, "detached");
  assert.deepEqual(detached.record.envelope.agent, envelope().agent);

  const detachedRetry = advanceOutgoingHandoff(detached.records, "handoff-ember-1", "detached", 122);
  assert.equal(detachedRetry.ok, true);
  assert.equal(detachedRetry.record.updatedAtTick, 121);

  const backwards = advanceOutgoingHandoff(detached.records, "handoff-ember-1", "reserved", 122);
  assert.equal(backwards.ok, false);
  assert.match(backwards.reason, /cannot move backwards/);

  const committed = advanceOutgoingHandoff(detached.records, "handoff-ember-1", "committed", 123);
  assert.equal(committed.ok, true);
  assert.equal(committed.record.phase, "committed");
  assert.equal(pendingOutgoingHandoffs(committed.records).length, 0);
});

test("incoming prepare and commit are idempotent while prepared state stays inactive", () => {
  const transfer = envelope();
  const prepared = prepareIncomingHandoff([], transfer, 120);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.record.phase, "prepared");
  assert.equal(pendingIncomingHandoffs(prepared.records).length, 1);

  const retry = prepareIncomingHandoff(prepared.records, structuredClone(transfer), 121);
  assert.equal(retry.ok, true);
  assert.equal(retry.records.length, 1);
  assert.equal(retry.record.updatedAtTick, 120);

  const committed = commitIncomingHandoff(retry.records, transfer.transferId, 122);
  assert.equal(committed.ok, true);
  assert.equal(committed.record.phase, "committed");
  assert.equal(pendingIncomingHandoffs(committed.records).length, 0);

  const commitRetry = commitIncomingHandoff(committed.records, transfer.transferId, 123);
  assert.equal(commitRetry.ok, true);
  assert.equal(commitRetry.records.length, 1);
  assert.equal(commitRetry.record.updatedAtTick, 122);
});

test("prepared target plus detached source always retains a durable recovery copy", () => {
  const transfer = envelope();
  const sourceReserved = reserveOutgoingHandoff([], transfer, 120);
  const targetPrepared = prepareIncomingHandoff([], transfer, 120);
  const sourceDetached = advanceOutgoingHandoff(
    sourceReserved.records,
    transfer.transferId,
    "detached",
    121,
  );

  assert.equal(sourceDetached.ok, true);
  assert.equal(targetPrepared.ok, true);
  assert.deepEqual(sourceDetached.record.envelope.agent, transfer.agent);
  assert.deepEqual(targetPrepared.record.envelope.agent, transfer.agent);
  assert.equal(sourceDetached.record.phase, "detached");
  assert.equal(targetPrepared.record.phase, "prepared");
});
