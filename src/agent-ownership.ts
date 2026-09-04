import type { Agent, GridPosition, WorldCommand, WorldState } from "./protocol.js";
import { getFaction, getTile, isPassable } from "./world.js";

export interface RegionOwnershipSnapshot {
  state: WorldState;
  pendingCommands: WorldCommand[];
}

export interface DetachedAgentOwnership {
  agent: Agent;
  snapshot: RegionOwnershipSnapshot;
}

export interface OwnershipMutationResult<T> {
  ok: boolean;
  value?: T;
  reason?: string;
}

const GLOBAL_AGENT_PREFIX = "agent-global:";

function cloneSnapshot(
  state: WorldState,
  pendingCommands: readonly WorldCommand[],
): RegionOwnershipSnapshot {
  return {
    state: structuredClone(state),
    pendingCommands: pendingCommands.map((command) => structuredClone(command)),
  };
}

export function globalHandoffAgentId(agentId: string, originRegionId: string): string {
  if (agentId.startsWith(GLOBAL_AGENT_PREFIX)) return agentId;
  return `${GLOBAL_AGENT_PREFIX}${originRegionId}:${agentId}`;
}

export function detachAgentOwnership(
  state: WorldState,
  pendingCommands: readonly WorldCommand[],
  agentId: string,
): OwnershipMutationResult<DetachedAgentOwnership> {
  const agent = state.agents.find((entry) => entry.id === agentId);
  if (agent === undefined) return { ok: false, reason: "unknown agent" };
  if (pendingCommands.some((command) => command.agentId === agentId)) {
    return { ok: false, reason: "agent has pending commands" };
  }

  const snapshot = cloneSnapshot(state, pendingCommands);
  snapshot.state.agents = snapshot.state.agents.filter((entry) => entry.id !== agentId);
  return {
    ok: true,
    value: {
      agent: structuredClone(agent),
      snapshot,
    },
  };
}

export function attachAgentOwnership(
  state: WorldState,
  pendingCommands: readonly WorldCommand[],
  agent: Agent,
  targetPosition: GridPosition,
  originRegionId: string,
): OwnershipMutationResult<RegionOwnershipSnapshot> {
  const arrivedId = globalHandoffAgentId(agent.id, originRegionId);
  if (state.agents.some((entry) => entry.id === arrivedId)) {
    return { ok: false, reason: "agent already active in target region" };
  }
  if (getFaction(state, agent.factionId) === undefined) {
    return { ok: false, reason: "target region does not contain the agent faction" };
  }
  const targetTile = getTile(state, targetPosition);
  if (targetTile === undefined || !isPassable(state, targetPosition)) {
    return { ok: false, reason: "handoff target is outside the active hex or impassable" };
  }

  const snapshot = cloneSnapshot(state, pendingCommands);
  const arrived = structuredClone(agent);
  // Legacy persisted worlds used region-local IDs such as `agent-ember-builder`,
  // so different regions can already contain unrelated agents with that same
  // local ID. Promote an agent once, at its first cross-region handoff, to a
  // stable world-global identity derived from its origin region. Already-global
  // IDs remain unchanged on all later handoffs.
  arrived.id = arrivedId;
  arrived.position = { ...targetPosition };
  // Tasks reference the source region's local coordinate frame. Cross-region
  // task/transaction continuation is a later protocol layer, so agent ownership
  // handoff intentionally preserves goals/inventory but forces local replanning.
  delete arrived.task;
  arrived.status = "arrived from neighboring region";
  snapshot.state.agents.push(arrived);
  snapshot.state.agents.sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, value: snapshot };
}

export function activeAgentOwnershipCount(
  states: readonly WorldState[],
  agentId: string,
): number {
  return states.reduce(
    (count, state) => count + state.agents.filter((agent) => agent.id === agentId).length,
    0,
  );
}
