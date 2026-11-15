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

test("detach promotes the mover's lineage record and pregnancy partnerParents", () => {
  const { source } = worlds();
  const mover = source.agents[0];
  const parent = source.agents[1];
  assert.ok(mover);
  assert.ok(parent);

  const moverLocalId = mover.id;
  const remoteGrandparent = globalHandoffAgentId("gp-remote", "garden-9");
  // A legacy/hand-written entry that never got canonicalized still promotes
  // against the region it was stored in, while global forms pass through.
  mover.lineage = {
    generation: 2,
    grandparents: [remoteGrandparent, "gp-mover-local"],
  };
  mover.pregnancy = {
    partnerId: parent.id,
    conceivedAtTick: 2,
    dueAtTick: 12,
    partnerGeneration: 1,
    partnerParents: [parent.id, "gp-elsewhere"],
  };

  const detached = detachAgentOwnership(source, [], moverLocalId);
  assert.equal(detached.ok, true);
  assert.ok(detached.value);

  assert.deepEqual(detached.value.agent.lineage, {
    generation: 2,
    grandparents: [
      globalHandoffAgentId("gp-mover-local", source.regionId),
      remoteGrandparent,
    ],
  });
  assert.deepEqual(detached.value.agent.pregnancy?.partnerParents, [
    globalHandoffAgentId(parent.id, source.regionId),
    globalHandoffAgentId("gp-elsewhere", source.regionId),
  ]);
  assert.equal(detached.value.agent.pregnancy?.partnerGeneration, 1);
  // The input state is not mutated by the detach snapshot.
  assert.deepEqual(mover.lineage.grandparents, [remoteGrandparent, "gp-mover-local"]);
  assert.deepEqual(mover.pregnancy.partnerParents, [parent.id, "gp-elsewhere"]);
});

test("detach rewrites resident lineage grandparents and partnerParents for the departed", () => {
  const { source } = worlds();
  const mover = source.agents[0];
  const child = source.agents[1];
  const gestational = source.agents[2];
  const bystander = source.agents[3];
  assert.ok(mover);
  assert.ok(child);
  assert.ok(gestational);
  assert.ok(bystander);

  const moverLocalId = mover.id;
  const promotedMoverId = globalHandoffAgentId(moverLocalId, source.regionId);
  const remoteGrandparent = globalHandoffAgentId("gp-remote", "garden-9");

  // The resident child names the departing grandparent by its still-local form
  // and already names another grandparent in world-global form.
  child.lineage = {
    generation: 3,
    grandparents: [moverLocalId, remoteGrandparent, bystander.id],
  };
  gestational.pregnancy = {
    partnerId: "someone-else",
    conceivedAtTick: 1,
    dueAtTick: 10,
    partnerGeneration: 2,
    partnerParents: [moverLocalId, "gp-still-local"],
  };

  const detached = detachAgentOwnership(source, [], moverLocalId);
  assert.equal(detached.ok, true);
  assert.ok(detached.value);

  const residentChild = detached.value.snapshot.state.agents.find((agent) => agent.id === child.id);
  const residentGestational = detached.value.snapshot.state.agents.find((agent) => agent.id === gestational.id);
  assert.ok(residentChild);
  assert.ok(residentGestational);

  assert.deepEqual(residentChild.lineage?.grandparents, [
    globalHandoffAgentId(bystander.id, source.regionId),
    promotedMoverId,
    remoteGrandparent,
  ].sort((a, b) => a.localeCompare(b)));
  assert.equal(
    residentGestational.pregnancy?.partnerId,
    "someone-else",
    "unrelated partner references stay untouched",
  );
  assert.deepEqual(residentGestational.pregnancy?.partnerParents, [
    promotedMoverId,
    "gp-still-local",
  ]);

  // Input state is never mutated.
  assert.deepEqual(child.lineage?.grandparents, [moverLocalId, remoteGrandparent, bystander.id]);
  assert.deepEqual(gestational.pregnancy?.partnerParents, [moverLocalId, "gp-still-local"]);
});

test("lineage references survive repeated handoffs and dead ancestors unchanged", () => {
  const { source, target } = worlds();
  const third = createInitialWorld({ seed: 9203, width: 40, height: 24, regionId: "garden-3" });
  const mover = structuredClone(source.agents[0]);
  const targetPosition = target.agents[0]?.position;
  const thirdPosition = third.agents[0]?.position;
  assert.ok(mover);
  assert.ok(targetPosition);
  assert.ok(thirdPosition);

  const deadGrandparent = "agent-global:garden-7:gp-dead";
  const moverLocalId = mover.id;
  mover.lineage = {
    generation: 4,
    grandparents: [deadGrandparent, "agent-global:garden-1:gp-live"],
  };
  mover.pregnancy = {
    partnerId: "agent-global:garden-1:partner",
    conceivedAtTick: 4,
    dueAtTick: 20,
    partnerGeneration: 3,
    partnerParents: [deadGrandparent, "agent-global:garden-1:gp-live"],
  };

  const first = attachAgentOwnership(target, [], mover, targetPosition, source.regionId);
  assert.equal(first.ok, true);
  assert.ok(first.value);

  const arrivedId = globalHandoffAgentId(moverLocalId, source.regionId);
  const arrived = first.value.state.agents.find((agent) => agent.id === arrivedId);
  assert.ok(arrived);
  assert.deepEqual(arrived.lineage, {
    generation: 4,
    grandparents: ["agent-global:garden-1:gp-live", deadGrandparent],
  });
  // partnerParents keeps conception-snapshot order; only identity promotion applies.
  assert.deepEqual(arrived.pregnancy?.partnerParents, [
    deadGrandparent,
    "agent-global:garden-1:gp-live",
  ]);

  // Second handoff: world-global lineage identities must not be rewritten to
  // the intermediate region — ancestor identity is fixed, not hop-relative.
  const secondDetach = detachAgentOwnership(first.value.state, [], arrivedId);
  assert.equal(secondDetach.ok, true);
  assert.ok(secondDetach.value);
  const second = attachAgentOwnership(
    third,
    [],
    secondDetach.value.agent,
    thirdPosition,
    first.value.state.regionId,
  );
  assert.equal(second.ok, true);
  assert.ok(second.value);
  const rearrived = second.value.state.agents.find((agent) => agent.id === arrivedId);
  assert.ok(rearrived);
  assert.deepEqual(rearrived.lineage, arrived.lineage);
  assert.deepEqual(rearrived.pregnancy?.partnerParents, arrived.pregnancy?.partnerParents);
});
