import assert from "node:assert/strict";
import test from "node:test";
import {
  detachAgentOwnership,
  globalHandoffAgentId,
} from "../dist-ts/src/agent-ownership.js";
import { createInitialWorld } from "../dist-ts/src/world.js";

test("handoff promotes recent social-history references with the moving agent identity", () => {
  const source = createInitialWorld({
    seed: 9203,
    width: 40,
    height: 24,
    regionId: "garden-1",
  });
  const mover = source.agents[0];
  const peer = source.agents[1];
  assert.ok(mover);
  assert.ok(peer);

  const moverLocalId = mover.id;
  mover.socialMemory = [{ agentId: peer.id, familiarity: 3, lastInteractionTick: source.tick }];
  peer.socialMemory = [{ agentId: moverLocalId, familiarity: 3, lastInteractionTick: source.tick }];
  source.events = [
    {
      id: "conversation-outbound",
      tick: source.tick,
      kind: "agent_conversation",
      message: "outbound familiarity",
      agentId: moverLocalId,
      factionId: mover.factionId,
      position: { ...mover.position },
      data: { targetAgentId: peer.id, topic: "resource_report" },
    },
    {
      id: "conversation-inbound",
      tick: source.tick,
      kind: "agent_conversation",
      message: "inbound familiarity",
      agentId: peer.id,
      factionId: peer.factionId,
      position: { ...peer.position },
      data: { targetAgentId: moverLocalId, topic: "resource_report" },
    },
    {
      id: "unrelated",
      tick: source.tick,
      kind: "agent_conversation",
      message: "unrelated identity",
      agentId: peer.id,
      factionId: peer.factionId,
      position: { ...peer.position },
      data: { targetAgentId: "someone-else" },
    },
  ];
  const originalEvents = structuredClone(source.events);

  const detached = detachAgentOwnership(source, [], moverLocalId);
  assert.equal(detached.ok, true);
  assert.ok(detached.value);
  assert.deepEqual(source.events, originalEvents, "input event history remains immutable");

  const promotedMoverId = globalHandoffAgentId(moverLocalId, source.regionId);
  const [outbound, inbound, unrelated] = detached.value.snapshot.state.events;
  assert.ok(outbound);
  assert.ok(inbound);
  assert.ok(unrelated);
  assert.equal(outbound.agentId, promotedMoverId);
  assert.equal(outbound.data?.targetAgentId, peer.id);
  assert.equal(inbound.agentId, peer.id);
  assert.equal(inbound.data?.targetAgentId, promotedMoverId);
  assert.equal(unrelated.agentId, peer.id);
  assert.equal(unrelated.data?.targetAgentId, "someone-else");

  const residentPeer = detached.value.snapshot.state.agents.find((entry) => entry.id === peer.id);
  assert.ok(residentPeer);
  assert.equal(residentPeer.socialMemory?.[0]?.agentId, promotedMoverId);
  assert.equal(residentPeer.socialMemory?.[0]?.familiarity, 3);
  assert.equal(
    detached.value.agent.socialMemory?.[0]?.agentId,
    peer.id,
    "the moving BOT keeps the still-local peer identity; reciprocal memory will promote when that peer moves",
  );
});
