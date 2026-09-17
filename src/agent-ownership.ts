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

function targetBuildingFactionCamp(agent: Agent, targetState: WorldState) {
  return targetState.structures
    .filter((structure) =>
      structure.factionId === agent.factionId
      && structure.type === "camp"
      && structure.status === "building"
    )
    .sort((a, b) => a.id.localeCompare(b.id))[0];
}

function arrivalTaskAfterHandoff(
  agent: Agent,
  targetState: WorldState,
  originRegionId: string,
): Agent["task"] | undefined {
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
  ) {
    const buildingCamp = targetBuildingFactionCamp(agent, targetState);
    if (buildingCamp !== undefined) {
      // A camp that is already being built belongs to the target Region DO, so
      // it is safe to bind the arriving pioneer to that target-local ID here.
      // This also closes a one-tick race: if another local builder completes
      // the camp before the pioneer executes, resolveBuildTaskTarget() still
      // sees the same now-active structure instead of founding a duplicate.
      return {
        source: "autonomy",
        issuedAtTick: targetTick,
        type: "build",
        structureType: "camp",
        target: { ...buildingCamp.position },
        structureId: buildingCamp.id,
      };
    }
    if (!targetHasActiveFactionCamp(agent, targetState)) {
      // Settlement migration reaches the seam as an autonomous move because the
      // source-local boundary coordinate must not survive ownership handoff. A
      // builder that physically carries a complete camp kit can safely recover
      // the high-level founding intent from low-level conserved state on arrival.
      // Remember exactly one previous region so the next scout cannot immediately
      // reverse the handoff when transient support samples change between ticks.
      return {
        source: "autonomy",
        issuedAtTick: targetTick,
        type: "build",
        structureType: "camp",
        settlementPreviousRegionId: originRegionId,
      };
    }
    // If this faction already has an active camp here, dropping the move means
    // the pioneer joins that settlement instead of creating a duplicate camp;
    // normal target-side autonomy can then deposit or reuse the carried kit.
  }
  return undefined;
}

export function globalHandoffAgentId(agentId: string, originRegionId: string): string {
  if (agentId.startsWith(GLOBAL_AGENT_PREFIX)) return agentId;
  return `${GLOBAL_AGENT_PREFIX}${originRegionId}:${agentId}`;
}

function promoteAgentFamilyReferences(agent: Agent, originRegionId: string): void {
  if (agent.parents !== undefined) {
    agent.parents = agent.parents.map((parentId) =>
      globalHandoffAgentId(parentId, originRegionId)
    ) as [string, string];
  }
  if (agent.pregnancy !== undefined) {
    agent.pregnancy = {
      ...agent.pregnancy,
      partnerId: globalHandoffAgentId(agent.pregnancy.partnerId, originRegionId),
    };
  }
  if (agent.socialMemory !== undefined) {
    // socialMemory travels with the moving BOT. Promote source-local peers now:
    // once this BOT has detached, the source DO cannot mutate its memory when a
    // remembered peer crosses later. The peer will receive this exact same
    // world-global ID on its own first handoff.
    agent.socialMemory = agent.socialMemory.map((memory) => ({
      ...memory,
      agentId: globalHandoffAgentId(memory.agentId, originRegionId),
    }));
  }
}

function rewriteResidentFamilyReference(
  agent: Agent,
  sourceLocalId: string,
  promotedId: string,
): void {
  if (sourceLocalId === promotedId) return;
  if (agent.parents !== undefined) {
    agent.parents = agent.parents.map((parentId) =>
      parentId === sourceLocalId ? promotedId : parentId
    ) as [string, string];
  }
  if (agent.pregnancy?.partnerId === sourceLocalId) {
    agent.pregnancy = { ...agent.pregnancy, partnerId: promotedId };
  }
  if (
    agent.task?.source === "autonomy"
    && agent.task.type === "trade"
    && agent.task.targetAgentId === sourceLocalId
  ) {
    // The counterparty's ownership moved, but the resident trader remains in
    // this Region DO. Keep the autonomous promise bound to the same physical
    // BOT by promoting only its identity; route planning may decide later how
    // to reach that global counterparty. External commands stay source-local.
    agent.task = { ...agent.task, targetAgentId: promotedId };
  }
  if (agent.socialMemory !== undefined) {
    agent.socialMemory = agent.socialMemory.map((memory) =>
      memory.agentId === sourceLocalId
        ? { ...memory, agentId: promotedId }
        : memory
    );
  }
}

function rewriteHistoricalAgentReference(
  state: WorldState,
  sourceLocalId: string,
  promotedId: string,
): void {
  if (sourceLocalId === promotedId) return;
  for (const event of state.events) {
    if (event.agentId === sourceLocalId) event.agentId = promotedId;
    if (event.data?.targetAgentId === sourceLocalId) {
      event.data = { ...event.data, targetAgentId: promotedId };
    }
  }
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
  const promotedId = globalHandoffAgentId(agent.id, state.regionId);
  for (const resident of snapshot.state.agents) {
    rewriteResidentFamilyReference(resident, agent.id, promotedId);
  }
  // Recent events remain a rolling-deploy compatibility memory, while the
  // bounded per-agent socialMemory above is the durable low-level relationship
  // state. Promote both to the same world-global identity when a resident leaves.
  rewriteHistoricalAgentReference(snapshot.state, agent.id, promotedId);

  const detachedAgent = structuredClone(agent);
  // Demographic and durable social references are identity links rather than
  // region-local targets. Normalize them before the moving agent leaves its
  // origin so peers that cross later resolve to the same stable identity.
  promoteAgentFamilyReferences(detachedAgent, state.regionId);
  return {
    ok: true,
    value: {
      agent: detachedAgent,
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
  if (arrived.settlementFamilyTargetRegionId === state.regionId) {
    delete arrived.settlementFamilyTargetRegionId;
  }
  // Keep lineage, active pregnancy, and durable social references on the same
  // stable identity scheme even when callers attach a legacy snapshot without
  // first detaching it.
  promoteAgentFamilyReferences(arrived, originRegionId);
  // Coordinate-bound tasks still belong to the source region and must be
  // cleared. Region-independent autonomous intent can survive only after its
  // source-local target has been stripped and will be re-resolved on arrival.
  const arrivalTask = arrivalTaskAfterHandoff(arrived, snapshot.state, originRegionId);
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
