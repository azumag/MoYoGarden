import assert from "node:assert/strict";
import test from "node:test";
import {
  attachAgentOwnership,
  detachAgentOwnership,
  globalHandoffAgentId,
} from "../dist-ts/src/agent-ownership.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

function worlds() {
  return {
    source: createInitialWorld({ seed: 9201, width: 40, height: 24, regionId: "garden-1" }),
    target: createInitialWorld({ seed: 9202, width: 40, height: 24, regionId: "garden-2" }),
  };
}

test("detach promotes lineage and pregnancy references without mutating the source", () => {
  const { source } = worlds();
  const mover = source.agents[0];
  const parent = source.agents[1];
  const child = source.agents[2];
  const gestational = source.agents[3];
  assert.ok(mover);
  assert.ok(parent);
  assert.ok(child);
  assert.ok(gestational);

  const moverLocalId = mover.id;
  const parentLocalId = parent.id;
  const alreadyGlobalParent = globalHandoffAgentId("agent-remote-parent", "garden-3");
  child.parents = [moverLocalId, parentLocalId];
  gestational.pregnancy = {
    partnerId: moverLocalId,
    conceivedAtTick: 1,
    dueAtTick: 10,
  };
  mover.parents = [parentLocalId, alreadyGlobalParent];
  mover.pregnancy = {
    partnerId: parentLocalId,
    conceivedAtTick: 2,
    dueAtTick: 12,
  };

  const detached = detachAgentOwnership(source, [], moverLocalId);
  assert.equal(detached.ok, true);
  assert.ok(detached.value);

  const promotedMoverId = globalHandoffAgentId(moverLocalId, source.regionId);
  const promotedParentId = globalHandoffAgentId(parentLocalId, source.regionId);
  const residentChild = detached.value.snapshot.state.agents.find((agent) => agent.id === child.id);
  const residentGestational = detached.value.snapshot.state.agents.find((agent) => agent.id === gestational.id);
  assert.ok(residentChild);
  assert.ok(residentGestational);

  assert.deepEqual(child.parents, [moverLocalId, parentLocalId], "input state remains immutable");
  assert.equal(gestational.pregnancy?.partnerId, moverLocalId, "input pregnancy remains immutable");
  assert.deepEqual(residentChild.parents, [promotedMoverId, parentLocalId]);
  assert.equal(residentGestational.pregnancy?.partnerId, promotedMoverId);
  assert.deepEqual(detached.value.agent.parents, [promotedParentId, alreadyGlobalParent]);
  assert.equal(detached.value.agent.pregnancy?.partnerId, promotedParentId);
});

test("attach idempotently normalizes family identities for a legacy handoff snapshot", () => {
  const { source, target } = worlds();
  const mover = structuredClone(source.agents[0]);
  const parent = source.agents[1];
  assert.ok(mover);
  assert.ok(parent);
  const targetPosition = target.agents[0]?.position;
  assert.ok(targetPosition);

  const alreadyGlobalParent = globalHandoffAgentId("agent-remote-parent", "garden-3");
  mover.parents = [parent.id, alreadyGlobalParent];
  mover.pregnancy = {
    partnerId: parent.id,
    conceivedAtTick: 3,
    dueAtTick: 15,
  };

  const attached = attachAgentOwnership(
    target,
    [],
    mover,
    targetPosition,
    source.regionId,
  );
  assert.equal(attached.ok, true);
  assert.ok(attached.value);

  const arrivedId = globalHandoffAgentId(mover.id, source.regionId);
  const arrived = attached.value.state.agents.find((agent) => agent.id === arrivedId);
  assert.ok(arrived);
  assert.deepEqual(arrived.parents, [
    globalHandoffAgentId(parent.id, source.regionId),
    alreadyGlobalParent,
  ]);
  assert.equal(
    arrived.pregnancy?.partnerId,
    globalHandoffAgentId(parent.id, source.regionId),
  );
});
