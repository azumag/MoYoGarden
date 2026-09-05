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

function arrivalTaskAfterHandoff(agent: Agent, targetTick: number): Agent["task"] | undefined {
  const task = agent.task;
  if (task?.source !== "autonomy") return undefined;

  // A gather task without a target is an intent (find this resource locally),
  // unlike move/build/trade targets whose coordinates or identities belong to
  // the source region. Preserve that intent while deliberately discarding the
  // source-local target so the target region can choose a valid deposit again.
  if (task.type === "gather") {
    return {
      source: "autonomy",
      issuedAtTick: targetTick,
      type: "gather",
      resource: task.resource,
    };
  }
  return undefined;
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
  // Coordinate-bound tasks still belong to the source region and must be
  // cleared. Autonomous gather is the first safe exception: its resource kind
  // is a high-level intent, so strip only the old target and let the target
  // region's ordinary gather executor select a new local deposit.
  const arrivalTask = arrivalTaskAfterHandoff(arrived, snapshot.state.tick);
  if (arrivalTask === undefined) delete arrived.task;
  else arrived.task = arrivalTask;
  arrived.status = arrivalTask?.type === "gather"
    ? `arrived from neighboring region; replanning ${arrivalTask.resource} search`
    : "arrived from neighboring region";
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
