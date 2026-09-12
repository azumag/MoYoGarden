import {
  BUILD_RECIPES,
  type Agent,
  type GridPosition,
  type WorldCommand,
  type WorldState,
} from "./protocol.js";
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

function carriesCampKit(agent: Agent): boolean {
  const cost = BUILD_RECIPES.camp.cost;
  return agent.inventory.wood >= cost.wood
    && agent.inventory.stone >= cost.stone
    && agent.inventory.food >= cost.food;
}

function targetHasActiveFactionCamp(agent: Agent, targetState: WorldState): boolean {
  return targetState.structures.some((structure) =>
    structure.factionId === agent.factionId
    && structure.type === "camp"
    && structure.status === "active"
  );
}

function arrivalTaskAfterHandoff(agent: Agent, targetState: WorldState): Agent["task"] | undefined {
  const targetTick = targetState.tick;
  const task = agent.task;
  if (task?.source !== "autonomy") return undefined;

  // Some autonomous tasks express region-independent intent while their
  // resolved targets belong to one Region Durable Object. Preserve only the
  // intent and deliberately discard source-local coordinates/IDs so the target
  // region can resolve its own valid resource or storage target.
  if (task.type === "gather") {
    return {
      source: "autonomy",
      issuedAtTick: targetTick,
      type: "gather",
      resource: task.resource,
    };
  }
  if (task.type === "deposit") {
    return {
      source: "autonomy",
      issuedAtTick: targetTick,
      type: "deposit",
    };
  }
  if (task.type === "build") {
    return {
      source: "autonomy",
      issuedAtTick: targetTick,
      type: "build",
      structureType: task.structureType,
    };
  }
  if (
    task.type === "trade"
    && task.targetAgentId.startsWith(GLOBAL_AGENT_PREFIX)
    && targetState.agents.some((entry) => entry.id === task.targetAgentId)
  ) {
    return {
      source: "autonomy",
      issuedAtTick: targetTick,
      type: "trade",
      targetAgentId: task.targetAgentId,
      offer: { ...task.offer },
      request: { ...task.request },
    };
  }
  if (
    task.type === "move"
    && agent.role === "builder"
    && carriesCampKit(agent)
    && !targetHasActiveFactionCamp(agent, targetState)
  ) {
    // Settlement migration reaches the seam as an autonomous move because the
    // source-local boundary coordinate must not survive ownership handoff. A
    // builder that physically carries a complete camp kit can safely recover
    // the high-level founding intent from low-level conserved state on arrival.
    // If this faction already has an active camp here, dropping the move means
    // the pioneer joins that settlement instead of creating a duplicate camp;
    // normal target-side autonomy can then deposit or reuse the carried kit.
    return {
      source: "autonomy",
      issuedAtTick: targetTick,
      type: "build",
      structureType: "camp",
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
  // cleared. Region-independent autonomous intent can survive only after its
  // source-local target has been stripped and will be re-resolved on arrival.
  const arrivalTask = arrivalTaskAfterHandoff(arrived, snapshot.state);
  if (arrivalTask === undefined) delete arrived.task;
  else arrived.task = arrivalTask;
  arrived.status = arrivalTask?.type === "gather"
    ? `arrived from neighboring region; replanning ${arrivalTask.resource} search`
    : arrivalTask?.type === "deposit"
      ? "arrived from neighboring region; replanning storage return"
      : arrivalTask?.type === "build"
        ? `arrived from neighboring region; replanning ${arrivalTask.structureType} build`
        : arrivalTask?.type === "trade"
          ? `arrived from neighboring region; resuming trade with ${arrivalTask.targetAgentId}`
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
