import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceOutgoingHandoff,
  commitIncomingHandoff,
  prepareIncomingHandoff,
  reserveOutgoingHandoff,
} from "../dist-ts/src/agent-handoff.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function envelope() {
  const state = createInitialWorld({ seed: 8111, width: 40, height: 24 });
  const agent = structuredClone(state.agents[0]);
  agent.position = { x: 30, y: 11 };
  delete agent.task;
  return {
    transferId: "handoff-time-1",
    fromRegionId: "garden-1",
    toRegionId: "garden-2",
    direction: "east",
    sourcePosition: { x: 30, y: 11 },
    targetPosition: { x: 8, y: 11 },
    agent,
    createdAtTick: 120,
  };
}

test("handoff journals reject invalid initial update ticks before persistence", () => {
  const transfer = envelope();
  const outgoing = reserveOutgoingHandoff([], transfer, -1);
  assert.equal(outgoing.ok, false);
  assert.match(outgoing.reason, /invalid handoff update tick/);
  assert.equal(outgoing.records.length, 0);

  const incoming = prepareIncomingHandoff([], transfer, -1);
  assert.equal(incoming.ok, false);
  assert.match(incoming.reason, /invalid handoff update tick/);
  assert.equal(incoming.records.length, 0);
});

test("handoff journal timestamps never regress while independent region clocks may differ", () => {
  const transfer = envelope();
  const reserved = reserveOutgoingHandoff([], transfer, 120);
  assert.equal(reserved.ok, true);

  const staleDetach = advanceOutgoingHandoff(
    reserved.records,
    transfer.transferId,
    "detached",
    119,
  );
  assert.equal(staleDetach.ok, false);
  assert.match(staleDetach.reason, /update tick cannot move backwards/);
  assert.equal(staleDetach.records[0].phase, "reserved");
  assert.equal(staleDetach.records[0].updatedAtTick, 120);

  const detached = advanceOutgoingHandoff(
    reserved.records,
    transfer.transferId,
    "detached",
    121,
  );
  assert.equal(detached.ok, true);
  assert.equal(detached.record.updatedAtTick, 121);

  // The target Durable Object may legitimately be behind the source tick.
  const prepared = prepareIncomingHandoff([], transfer, 80);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.record.updatedAtTick, 80);

  const staleCommit = commitIncomingHandoff(prepared.records, transfer.transferId, 79);
  assert.equal(staleCommit.ok, false);
  assert.match(staleCommit.reason, /update tick cannot move backwards/);
  assert.equal(staleCommit.records[0].phase, "prepared");
  assert.equal(staleCommit.records[0].updatedAtTick, 80);

  const committed = commitIncomingHandoff(prepared.records, transfer.transferId, 81);
  assert.equal(committed.ok, true);
  assert.equal(committed.record.phase, "committed");
  assert.equal(committed.record.updatedAtTick, 81);
});
