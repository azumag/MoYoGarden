import {
  DEFAULT_SIMULATION_CONFIG,
  emptyInventory,
  inventoryTotal,
  manhattanDistance,
  samePosition,
  type Agent,
  type AgentRole,
  type CommandReceipt,
  type GridPosition,
  parseCommand,
  type ResourceKind,
  RESOURCE_KINDS,
  type SimulationConfig,
  type WorldCommand,
  type WorldState,
} from "./protocol.js";
import { applyPopulationAging, dependentCaregiverId } from "./demography.js";
import { hexGridDistance } from "./hex-grid.js";
import { simulate } from "./simulation.js";
import { ensureWorldExtent } from "./world-scale.js";
import {
  activeFactionStructures,
  createInitialWorld,
  getAgent,
  getFaction,
  getPerception,
  getTile,
  inBounds,
  isPassable,
} from "./world.js";

export interface RuntimeOptions {
  state?: WorldState;
  seed?: number;
  width?: number;
  height?: number;
  simulationConfig?: SimulationConfig;
  pendingCommands?: WorldCommand[];
}

export type SnapshotListener = (state: WorldState, receipts: readonly CommandReceipt[]) => void;

const LOW_ENERGY_THRESHOLD = 18;
const FOOD_ENERGY_RECOVERY = 35;
const STARVATION_DAMAGE = 1;
// Demography uses a compressed biological timescale. At the production 10s
// virtual tick, 8,640 ticks is one simulation day. Population can now grow only
// through conception -> gestation -> birth, and virtual-time catch-up preserves
// the same elapsed-time semantics for sleeping regions.
const POPULATION_REPRODUCTION_INTERVAL = 8_640;
const POPULATION_GESTATION_TICKS = POPULATION_REPRODUCTION_INTERVAL;
const POPULATION_INFANCY_TICKS = POPULATION_REPRODUCTION_INTERVAL;
const POPULATION_MATURITY_TICKS = POPULATION_REPRODUCTION_INTERVAL * 3;
const POPULATION_POSTPARTUM_COOLDOWN_TICKS = POPULATION_REPRODUCTION_INTERVAL;
const POPULATION_FOOD_BUFFER_PER_AGENT = 4;
const POPULATION_BIRTH_FOOD_COST = 6;
const POPULATION_HEALTH_THRESHOLD = 70;
const POPULATION_ENERGY_THRESHOLD = 35;
const POPULATION_PARENT_RADIUS = 2;
const POPULATION_RESIDENT_CAPACITY_PER_CAMP = 6;
const POPULATION_DEPENDENT_CARE_RADIUS = 1;
const SOCIAL_INTERVAL = 12;
const SOCIAL_RADIUS = 2;
const SOCIAL_PAIR_COOLDOWN = 48;
const SOCIAL_MAX_CONVERSATIONS_PER_TICK = 2;
const SOCIAL_MEMORY_LIMIT = 8;
const SOCIAL_FAMILIARITY_MAX = 32;
const SOCIAL_ADVICE_ENERGY_THRESHOLD = LOW_ENERGY_THRESHOLD + 7;
const SOCIAL_KNOWLEDGE_TTL = 96;

type SocialTopic = {
  topic:
    | "warning"
    | "resource_report"
    | "construction"
    | "logistics"
    | "trade"
    | "supply_shortage"
    | "goal";
  line: string;
  resource?: ResourceKind;
  target?: GridPosition;
  knowledgeSourceAgentId?: string;
  relayed?: boolean;
};

function nearestFoodStorage(state: WorldState, factionId: string, position: { x: number; y: number }) {
  return activeFactionStructures(state, factionId)
    .filter((structure) => structure.storage.food > 0)
    .sort((a, b) => {
      const distance = manhattanDistance(a.position, position) - manhattanDistance(b.position, position);
      return distance || a.id.localeCompare(b.id);
    })[0];
}

function nearestFoodTile(state: WorldState, position: { x: number; y: number }) {
  return state.tiles
    .filter((tile) => tile.terrain !== "water" && tile.resource?.kind === "food" && tile.resource.amount > 0)
    .sort((a, b) => {
      const distance = manhattanDistance(a, position) - manhattanDistance(b, position);
      return distance || a.y - b.y || a.x - b.x;
    })[0];
}

function localFoodDonor(
  state: WorldState,
  recipient: Agent,
  commandedAgentIds: ReadonlySet<string>,
): Agent | undefined {
  return state.agents
    .filter((candidate) =>
      candidate.id !== recipient.id &&
      candidate.factionId === recipient.factionId &&
      candidate.autonomy &&
      !commandedAgentIds.has(candidate.id) &&
      candidate.task?.source !== "external" &&
      candidate.energy > LOW_ENERGY_THRESHOLD &&
      candidate.inventory.food > 1 &&
      samePosition(candidate.position, recipient.position)
    )
    .sort((a, b) =>
      b.inventory.food - a.inventory.food ||
      b.energy - a.energy ||
      a.id.localeCompare(b.id)
    )[0];
}

function applyDependentCaregiverFollow(
  state: WorldState,
  commandedAgentIds: ReadonlySet<string>,
): void {
  const dependents = [...state.agents]
    .filter((agent) =>
      agent.hp > 0 &&
      (agent.lifeStage === "infant" || agent.lifeStage === "juvenile")
    )
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const dependent of dependents) {
    // Explicit commands remain authoritative. Dependent following is only a
    // low-level autonomous care behavior, not a replacement for the command API.
    if (commandedAgentIds.has(dependent.id) || dependent.task?.source === "external") continue;

    const caregiverId = dependentCaregiverId(state, dependent);
    const caregiver = caregiverId === undefined ? undefined : getAgent(state, caregiverId);
    if (caregiver === undefined) continue;

    const distance = hexGridDistance(dependent.position, caregiver.position);
    if (distance <= POPULATION_DEPENDENT_CARE_RADIUS) {
      // Non-autonomous dependents do not receive normal worker autonomy tasks, so
      // an autonomous move here can only be the bounded caregiver-follow intent.
      if (dependent.task?.source === "autonomy" && dependent.task.type === "move") {
        delete dependent.task;
      }
      continue;
    }

    dependent.task = {
      source: "autonomy",
      issuedAtTick: state.tick,
      type: "move",
      target: { ...caregiver.position },
    };
    dependent.status = `following caregiver ${caregiver.name}`;
  }
}

function applyAutonomousNeeds(
  state: WorldState,
  commandedAgentIds: ReadonlySet<string>,
): Map<string, string> {
  const fedAgents = new Map<string, string>();
  for (const agent of state.agents) {
    if (
      !agent.autonomy ||
      commandedAgentIds.has(agent.id) ||
      agent.task?.source === "external" ||
      agent.energy > LOW_ENERGY_THRESHOLD
    ) {
      continue;
    }

    let ate = false;
    let mealStatus = "resting after a meal";
    if (agent.inventory.food > 0) {
      agent.inventory.food -= 1;
      ate = true;
    } else {
      const donor = localFoodDonor(state, agent, commandedAgentIds);
      if (donor !== undefined) {
        donor.inventory.food -= 1;
        ate = true;
        mealStatus = `resting after ${donor.name} shared food`;
      } else {
        const storage = nearestFoodStorage(state, agent.factionId, agent.position);
        if (storage !== undefined && samePosition(storage.position, agent.position)) {
          const faction = getFaction(state, agent.factionId);
          if (faction !== undefined && faction.resources.food > 0) {
            storage.storage.food -= 1;
            faction.resources.food -= 1;
            ate = true;
          }
        } else if (storage !== undefined) {
          agent.task = {
            source: "autonomy",
            issuedAtTick: state.tick,
            type: "move",
            target: { ...storage.position },
          };
          agent.status = "seeking stored food";
          continue;
        }
      }
    }

    if (ate) {
      agent.energy = Math.min(100, agent.energy + FOOD_ENERGY_RECOVERY);
      agent.task = {
        source: "autonomy",
        issuedAtTick: state.tick,
        type: "move",
        target: { ...agent.position },
      };
      agent.status = mealStatus;
      fedAgents.set(agent.id, mealStatus);
      continue;
    }

    const foodTile = nearestFoodTile(state, agent.position);
    if (foodTile !== undefined) {
      agent.task = {
        source: "autonomy",
        issuedAtTick: state.tick,
        type: "gather",
        resource: "food",
        target: { x: foodTile.x, y: foodTile.y },
      };
      agent.status = "seeking food";
      continue;
    }

    if (agent.task?.source === "autonomy") delete agent.task;
    agent.status = "hungry; no food available";
  }
  return fedAgents;
}

function applyStarvation(state: WorldState, starvingAgentIds: ReadonlySet<string>): void {
  const deadAgentIds = new Set<string>();
  for (const agentId of starvingAgentIds) {
    const agent = getAgent(state, agentId);
    if (agent === undefined) continue;
    agent.hp = Math.max(0, agent.hp - STARVATION_DAMAGE);
    if (agent.hp === 0) {
      deadAgentIds.add(agent.id);
      continue;
    }
    agent.status = agent.status.startsWith("starving") ? agent.status : `starving; ${agent.status}`;
  }
  if (deadAgentIds.size > 0) {
    state.agents = state.agents.filter((agent) => !deadAgentIds.has(agent.id));
  }
}

function consumeStoredFood(state: WorldState, factionId: string, amount: number): boolean {
  const faction = getFaction(state, factionId);
  if (faction === undefined || faction.resources.food < amount) return false;
  const storages = activeFactionStructures(state, factionId)
    .filter((structure) => structure.storage.food > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  const storedFood = storages.reduce((sum, structure) => sum + structure.storage.food, 0);
  if (storedFood < amount) return false;

  faction.resources.food -= amount;
  let remaining = amount;
  for (const structure of storages) {
    const taken = Math.min(remaining, structure.storage.food);
    structure.storage.food -= taken;
    remaining -= taken;
    if (remaining === 0) break;
  }
  return true;
}

function settlementResidentCapacity(state: WorldState, factionId: string): number {
  return activeFactionStructures(state, factionId)
    .filter((structure) => structure.type === "camp")
    .length * POPULATION_RESIDENT_CAPACITY_PER_CAMP;
}

function populationRole(state: WorldState, factionId: string): AgentRole {
  const agents = state.agents.filter((agent) => agent.factionId === factionId);
  if (!agents.some((agent) => agent.role === "builder")) return "builder";
  const faction = getFaction(state, factionId);
  if (faction === undefined) return "forager";

  const supplyRoles: ReadonlyArray<{ kind: ResourceKind; role: AgentRole }> = [
    { kind: "food", role: "forager" },
    { kind: "wood", role: "woodcutter" },
    { kind: "stone", role: "miner" },
  ];
  return supplyRoles
    .map(({ kind, role }) => ({
      role,
      stockPerWorker: faction.resources[kind] /
        Math.max(1, agents.filter((agent) => agent.role === role).length),
    }))
    .sort((a, b) => a.stockPerWorker - b.stockPerWorker || a.role.localeCompare(b.role))[0]?.role ?? "forager";
}

function populationGoal(role: AgentRole): string {
  if (role === "builder") return "Maintain and expand a viable settlement";
  if (role === "woodcutter") return "Supply wood without exhausting nearby sources";
  if (role === "miner") return "Supply stone to the settlement";
  return "Secure food for the growing settlement";
}

function demographicHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function reproductiveRole(agent: Agent): "gestational" | "partner" {
  return agent.reproductiveRole ?? (demographicHash(agent.id) % 2 === 0 ? "gestational" : "partner");
}

function isAdultForReproduction(agent: Agent, tick: number): boolean {
  if (agent.lifeStage === "elder") return false;
  if (agent.lifeStage === "adult") return true;
  if (agent.birthTick === undefined) return true;
  return tick - agent.birthTick >= POPULATION_MATURITY_TICKS;
}

function areCloseReproductiveKin(first: Agent, second: Agent): boolean {
  const firstParents: readonly string[] = first.parents ?? [];
  const secondParents: readonly string[] = second.parents ?? [];
  if (firstParents.includes(second.id) || secondParents.includes(first.id)) return true;
  return firstParents.some((parentId) => secondParents.includes(parentId));
}

function pairConversationCount(state: WorldState, firstId: string, secondId: string): number {
  let count = 0;
  for (const event of state.events) {
    if (event.kind !== "agent_conversation" || event.tick > state.tick) continue;
    const targetAgentId = event.data?.targetAgentId;
    if (
      (event.agentId === firstId && targetAgentId === secondId) ||
      (event.agentId === secondId && targetAgentId === firstId)
    ) {
      count += 1;
    }
  }
  return count;
}

function rememberedFamiliarity(agent: Agent, otherId: string): number {
  const entry = agent.socialMemory?.find((memory) => memory.agentId === otherId);
  return entry === undefined || !Number.isFinite(entry.familiarity)
    ? 0
    : Math.max(0, entry.familiarity);
}

function pairFamiliarity(state: WorldState, first: Agent, second: Agent): number {
  // Read either side so rolling-deploy or handoff snapshots with one reciprocal
  // memory missing still retain the strongest known relationship. Recent events
  // remain a compatibility fallback for persisted worlds that predate socialMemory.
  return Math.max(
    rememberedFamiliarity(first, second.id),
    rememberedFamiliarity(second, first.id),
    pairConversationCount(state, first.id, second.id),
  );
}

function rememberSocialInteraction(agent: Agent, otherId: string, tick: number): void {
  if (agent.id === otherId) return;
  const memory = (agent.socialMemory ?? []).map((entry) => ({ ...entry }));
  const existing = memory.find((entry) => entry.agentId === otherId);
  if (existing === undefined) {
    memory.push({ agentId: otherId, familiarity: 1, lastInteractionTick: tick });
  } else {
    existing.familiarity = Math.min(
      SOCIAL_FAMILIARITY_MAX,
      Math.max(0, existing.familiarity) + 1,
    );
    existing.lastInteractionTick = tick;
  }
  memory.sort((a, b) =>
    b.familiarity - a.familiarity ||
    b.lastInteractionTick - a.lastInteractionTick ||
    a.agentId.localeCompare(b.agentId)
  );
  agent.socialMemory = memory.slice(0, SOCIAL_MEMORY_LIMIT);
}

function applyLifeStageTransitions(state: WorldState): void {
  for (const agent of state.agents) {
    if (agent.birthTick === undefined || agent.lifeStage === "adult" || agent.lifeStage === "elder") continue;
    const age = state.tick - agent.birthTick;
    if (age >= POPULATION_MATURITY_TICKS) {
      const role = populationRole(state, agent.factionId);
      agent.lifeStage = "adult";
      agent.role = role;
      agent.capacity = role === "builder" ? 32 : 24;
      agent.autonomy = true;
      agent.goal = populationGoal(role);
      if (agent.task?.source === "autonomy") delete agent.task;
      agent.status = "reached adulthood";
      continue;
    }
    if (age >= POPULATION_INFANCY_TICKS && agent.lifeStage === "infant") {
      agent.lifeStage = "juvenile";
      agent.status = "juvenile; growing with the settlement";
    }
  }
}

function birthDuePregnancies(state: WorldState): void {
  const gestationalParents = [...state.agents]
    .filter((agent) => agent.pregnancy !== undefined && agent.pregnancy.dueAtTick <= state.tick)
    .sort((a, b) => a.id.localeCompare(b.id));

  for (const parent of gestationalParents) {
    const pregnancy = parent.pregnancy;
    if (pregnancy === undefined) continue;
    const faction = getFaction(state, parent.factionId);
    if (faction === undefined) {
      delete parent.pregnancy;
      continue;
    }

    const population = state.agents.filter((agent) => agent.factionId === parent.factionId);
    const generation = population.length + 1;
    const role = populationRole(state, parent.factionId);
    const childId = `agent-${parent.factionId}-birth-${state.tick}-${generation}`;
    const prefix = faction.name.split(/\s+/)[0] || faction.id;
    const nourished = consumeStoredFood(state, parent.factionId, POPULATION_BIRTH_FOOD_COST);

    state.agents.push({
      id: childId,
      name: `${prefix} ${generation}`,
      factionId: parent.factionId,
      role,
      position: { ...parent.position },
      hp: 100,
      energy: nourished ? 70 : 35,
      capacity: 8,
      inventory: emptyInventory(),
      autonomy: false,
      goal: "Grow safely before joining settlement work",
      status: nourished ? "infant; dependent on parents" : "infant; food insecure",
      birthTick: state.tick,
      lifeStage: "infant",
      reproductiveRole: demographicHash(childId) % 2 === 0 ? "gestational" : "partner",
      parents: [parent.id, pregnancy.partnerId],
    });
    delete parent.pregnancy;
    parent.lastBirthTick = state.tick;
    parent.status = `caring for newborn ${prefix} ${generation}`;
  }
}

function planConceptions(state: WorldState): void {
  if (state.tick === 0 || state.tick % POPULATION_REPRODUCTION_INTERVAL !== 0) return;

  for (const faction of [...state.factions].sort((a, b) => a.id.localeCompare(b.id))) {
    const population = state.agents
      .filter((agent) => agent.factionId === faction.id)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (population.length < 2) continue;
    const pregnancies = population.filter((agent) => agent.pregnancy !== undefined).length;
    if (population.length + pregnancies >= settlementResidentCapacity(state, faction.id)) continue;

    const foodNeeded = population.length * POPULATION_FOOD_BUFFER_PER_AGENT + POPULATION_BIRTH_FOOD_COST;
    const storedFood = activeFactionStructures(state, faction.id)
      .reduce((sum, structure) => sum + structure.storage.food, 0);
    if (faction.resources.food < foodNeeded || storedFood < POPULATION_BIRTH_FOOD_COST) continue;

    const healthyAdults = population.filter((agent) =>
      isAdultForReproduction(agent, state.tick) &&
      agent.hp >= POPULATION_HEALTH_THRESHOLD &&
      agent.energy >= POPULATION_ENERGY_THRESHOLD
    );
    const gestationalParents = healthyAdults.filter((agent) =>
      reproductiveRole(agent) === "gestational" &&
      agent.pregnancy === undefined &&
      (agent.lastBirthTick === undefined || state.tick - agent.lastBirthTick >= POPULATION_POSTPARTUM_COOLDOWN_TICKS)
    );

    for (const parent of gestationalParents) {
      const partner = healthyAdults
        .filter((candidate) =>
          candidate.id !== parent.id &&
          reproductiveRole(candidate) === "partner" &&
          !areCloseReproductiveKin(parent, candidate) &&
          manhattanDistance(candidate.position, parent.position) <= POPULATION_PARENT_RADIUS
        )
        .map((candidate) => ({
          candidate,
          familiarity: pairFamiliarity(state, parent, candidate),
          distance: manhattanDistance(candidate.position, parent.position),
        }))
        .sort((a, b) =>
          b.familiarity - a.familiarity ||
          a.distance - b.distance ||
          a.candidate.id.localeCompare(b.candidate.id)
        )[0]?.candidate;
      if (partner === undefined) continue;

      parent.pregnancy = {
        partnerId: partner.id,
        conceivedAtTick: state.tick,
        dueAtTick: state.tick + POPULATION_GESTATION_TICKS,
      };
      parent.reproductiveRole ??= "gestational";
      partner.reproductiveRole ??= "partner";
      parent.status = `expecting offspring with ${partner.name}`;
      break;
    }
  }
}

function applyDemography(state: WorldState): void {
  applyPopulationAging(state);
  applyLifeStageTransitions(state);
  birthDuePregnancies(state);
  planConceptions(state);
}

function factionSupplyShortage(state: WorldState, factionId: string): ResourceKind | undefined {
  const faction = getFaction(state, factionId);
  if (faction === undefined) return undefined;
  const population = Math.max(1, state.agents.filter((agent) => agent.factionId === factionId).length);
  const candidate = RESOURCE_KINDS
    .map((kind) => ({ kind, perCapita: faction.resources[kind] / population }))
    .sort((a, b) => a.perCapita - b.perCapita || a.kind.localeCompare(b.kind))[0];
  if (candidate === undefined || candidate.perCapita >= 4) return undefined;
  return candidate.kind;
}

function eventResource(value: unknown): ResourceKind | undefined {
  return typeof value === "string" && RESOURCE_KINDS.includes(value as ResourceKind)
    ? value as ResourceKind
    : undefined;
}

function eventPosition(value: unknown): GridPosition | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const x = Number((value as { x?: unknown }).x);
  const y = Number((value as { y?: unknown }).y);
  return Number.isInteger(x) && Number.isInteger(y) ? { x, y } : undefined;
}

function heardResourceReport(
  state: WorldState,
  speaker: Agent,
  listener: Agent,
): SocialTopic | undefined {
  const cutoff = state.tick - SOCIAL_KNOWLEDGE_TTL;
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const event = state.events[index];
    if (event === undefined) continue;
    if (event.tick < cutoff) break;
    if (
      event.kind !== "agent_conversation" ||
      event.data?.targetAgentId !== speaker.id ||
      event.data?.topic !== "resource_report"
    ) {
      continue;
    }

    const resource = eventResource(event.data.resource);
    const target = eventPosition(event.data.reportedTarget);
    if (resource === undefined || target === undefined || !inBounds(state, target)) continue;
    const tile = getTile(state, target);
    if (tile?.resource?.kind !== resource || tile.resource.amount <= 0) continue;

    const knowledgeSourceAgentId =
      typeof event.data.knowledgeSourceAgentId === "string"
        ? event.data.knowledgeSourceAgentId
        : event.agentId;
    if (knowledgeSourceAgentId === undefined || knowledgeSourceAgentId === listener.id) continue;
    const sourceName = getAgent(state, knowledgeSourceAgentId)?.name ?? "another ally";
    return {
      topic: "resource_report",
      resource,
      target,
      knowledgeSourceAgentId,
      relayed: true,
      line: `${sourceName} reported ${resource} near ${target.x},${target.y}.`,
    };
  }
  return undefined;
}

function socialTopic(state: WorldState, speaker: Agent, listener: Agent): SocialTopic {
  if (speaker.energy <= LOW_ENERGY_THRESHOLD + 7) {
    return {
      topic: "warning",
      resource: "food",
      line: "I'm running low on energy; nearby food access is becoming important.",
    };
  }

  const task = speaker.task;
  if (task?.type === "gather") {
    const location = task.target === undefined ? "nearby" : `near ${task.target.x},${task.target.y}`;
    return {
      topic: "resource_report",
      resource: task.resource,
      ...(task.target === undefined ? {} : { target: { ...task.target } }),
      knowledgeSourceAgentId: speaker.id,
      line: `I'm gathering ${task.resource} ${location}.`,
    };
  }
  if (task?.type === "build") {
    const location = task.target === undefined ? "in this region" : `at ${task.target.x},${task.target.y}`;
    return {
      topic: "construction",
      line: `I'm working on the ${task.structureType} ${location}.`,
    };
  }
  if (task?.type === "deposit") {
    return {
      topic: "logistics",
      line: `I'm carrying ${inventoryTotal(speaker.inventory)} supplies back to storage.`,
    };
  }
  if (task?.type === "trade") {
    const target = getAgent(state, task.targetAgentId);
    return {
      topic: "trade",
      line: `I'm trying to trade with ${target?.name ?? task.targetAgentId}.`,
    };
  }

  const heard = heardResourceReport(state, speaker, listener);
  if (heard !== undefined) return heard;

  const shortage = factionSupplyShortage(state, speaker.factionId);
  if (shortage !== undefined) {
    const specialistRole: AgentRole =
      shortage === "wood" ? "woodcutter" : shortage === "stone" ? "miner" : "forager";
    return {
      topic: "supply_shortage",
      resource: shortage,
      line: listener.role === specialistRole
        ? `We're short on ${shortage}; your ${specialistRole} work is especially useful now.`
        : `We're short on ${shortage}; keep that in mind while you work.`,
    };
  }

  return {
    topic: "goal",
    line: `My current goal is ${speaker.goal.slice(0, 100)}.`,
  };
}

function roleResource(role: AgentRole): ResourceKind | undefined {
  if (role === "woodcutter") return "wood";
  if (role === "miner") return "stone";
  if (role === "forager") return "food";
  return undefined;
}

function nearestAvailableResource(
  state: WorldState,
  origin: GridPosition,
  resource: ResourceKind,
): GridPosition | undefined {
  const tile = state.tiles
    .filter((candidate) =>
      candidate.terrain !== "water" &&
      candidate.resource?.kind === resource &&
      candidate.resource.amount > 0
    )
    .sort((a, b) => {
      const distance = manhattanDistance(a, origin) - manhattanDistance(b, origin);
      return distance || a.y - b.y || a.x - b.x;
    })[0];
  return tile === undefined ? undefined : { x: tile.x, y: tile.y };
}

function applySocialAdvice(
  state: WorldState,
  speaker: Agent,
  listener: Agent,
  social: SocialTopic,
): GridPosition | undefined {
  if (
    !listener.autonomy ||
    listener.task?.source === "external" ||
    listener.energy <= SOCIAL_ADVICE_ENERGY_THRESHOLD ||
    inventoryTotal(listener.inventory) > 0
  ) {
    return undefined;
  }

  const currentTask = listener.task;
  if (
    currentTask?.type === "build" ||
    currentTask?.type === "deposit" ||
    currentTask?.type === "trade"
  ) {
    return undefined;
  }

  if (social.topic === "resource_report" && social.resource !== undefined) {
    const sharedTarget = social.target;
    if (
      sharedTarget === undefined ||
      !inBounds(state, sharedTarget) ||
      !isPassable(state, sharedTarget)
    ) {
      return undefined;
    }
    const sharedTile = getTile(state, sharedTarget);
    if (sharedTile?.resource?.kind !== social.resource || sharedTile.resource.amount <= 0) {
      return undefined;
    }

    const shortage = factionSupplyShortage(state, listener.factionId);
    const relevant =
      roleResource(listener.role) === social.resource ||
      shortage === social.resource ||
      currentTask?.type === "gather" && currentTask.resource === social.resource;
    if (!relevant) return undefined;
    if (currentTask?.type === "gather" && currentTask.resource !== social.resource) return undefined;

    const sharedDistance = manhattanDistance(listener.position, sharedTarget);
    const currentDistance =
      currentTask?.type === "gather" && currentTask.target !== undefined
        ? manhattanDistance(listener.position, currentTask.target)
        : Number.POSITIVE_INFINITY;
    if (sharedDistance >= currentDistance) return undefined;

    listener.task = {
      source: "autonomy",
      issuedAtTick: state.tick,
      type: "gather",
      resource: social.resource,
      target: { ...sharedTarget },
    };
    listener.status = social.relayed
      ? `following ${speaker.name}'s relayed ${social.resource} report`
      : `following ${speaker.name}'s ${social.resource} report`;
    return { ...sharedTarget };
  }

  if (social.topic === "supply_shortage" && social.resource !== undefined) {
    if (currentTask?.type === "gather" && currentTask.resource === social.resource) return undefined;
    if (listener.role === "builder" && currentTask?.type === "gather") return undefined;
    const target = nearestAvailableResource(state, listener.position, social.resource);
    if (target === undefined) return undefined;

    listener.task = {
      source: "autonomy",
      issuedAtTick: state.tick,
      type: "gather",
      resource: social.resource,
      target,
    };
    listener.status = `helping with ${social.resource} shortage after ${speaker.name}'s advice`;
    return target;
  }

  return undefined;
}

function talkedRecently(state: WorldState, firstId: string, secondId: string): boolean {
  const cutoff = state.tick - SOCIAL_PAIR_COOLDOWN;
  return state.events.some((event) => {
    if (event.kind !== "agent_conversation" || event.tick > state.tick || event.tick > cutoff === false) {
      return false;
    }
    const targetAgentId = event.data?.targetAgentId;
    return (
      (event.agentId === firstId && targetAgentId === secondId) ||
      (event.agentId === secondId && targetAgentId === firstId)
    );
  });
}

export function applySocialInteractions(state: WorldState): number {
  if (state.tick === 0 || state.tick % SOCIAL_INTERVAL !== 0) return 0;

  const agents = [...state.agents]
    .filter((agent) => agent.hp > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
  const engaged = new Set<string>();
  let conversations = 0;

  for (const speaker of agents) {
    if (engaged.has(speaker.id)) continue;
    const listener = agents
      .filter((candidate) =>
        candidate.id !== speaker.id &&
        candidate.factionId === speaker.factionId &&
        !engaged.has(candidate.id) &&
        manhattanDistance(candidate.position, speaker.position) <= SOCIAL_RADIUS &&
        !talkedRecently(state, speaker.id, candidate.id)
      )
      .sort((a, b) =>
        manhattanDistance(a.position, speaker.position) - manhattanDistance(b.position, speaker.position) ||
        a.id.localeCompare(b.id)
      )[0];
    if (listener === undefined) continue;

    const social = socialTopic(state, speaker, listener);
    const adviceTarget = applySocialAdvice(state, speaker, listener, social);
    state.events.push({
      id: `event-${state.tick}-${state.events.length + 1}`,
      tick: state.tick,
      kind: "agent_conversation",
      message: `${speaker.name} to ${listener.name}: "${social.line}"`,
      agentId: speaker.id,
      factionId: speaker.factionId,
      position: { ...speaker.position },
      data: {
        targetAgentId: listener.id,
        targetAgentName: listener.name,
        topic: social.topic,
        line: social.line,
        speakerRole: speaker.role,
        listenerRole: listener.role,
        ...(social.resource === undefined ? {} : { resource: social.resource }),
        ...(social.target === undefined ? {} : { reportedTarget: { ...social.target } }),
        ...(social.knowledgeSourceAgentId === undefined
          ? {}
          : { knowledgeSourceAgentId: social.knowledgeSourceAgentId }),
        ...(social.relayed ? { relayed: true } : {}),
        ...(adviceTarget === undefined ? {} : { adviceAccepted: true, adviceTarget }),
      },
    });
    rememberSocialInteraction(speaker, listener.id, state.tick);
    rememberSocialInteraction(listener, speaker.id, state.tick);
    engaged.add(speaker.id);
    engaged.add(listener.id);
    conversations += 1;
    if (conversations >= SOCIAL_MAX_CONVERSATIONS_PER_TICK) break;
  }

  return conversations;
}

export class WorldRuntime {
  #state: WorldState;
  #pendingCommands: WorldCommand[] = [];
  #queuedCommandIds = new Set<string>();
  #listeners = new Set<SnapshotListener>();
  #commandSequence = 0;
  #simulationConfig: SimulationConfig;

  constructor(options: RuntimeOptions = {}) {
    const initialState = options.state ?? createInitialWorld({
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.width === undefined ? {} : { width: options.width }),
      ...(options.height === undefined ? {} : { height: options.height }),
    });
    const isLegacyDefault = initialState.width === 32 && initialState.height === 20;
    const usesDefaultExtent = options.state === undefined
      ? options.width === undefined && options.height === undefined
      : isLegacyDefault;
    if (usesDefaultExtent) ensureWorldExtent(initialState);
    this.#state = initialState;
    this.#simulationConfig = options.simulationConfig ?? DEFAULT_SIMULATION_CONFIG;
    if (options.pendingCommands !== undefined) {
      this.#pendingCommands = structuredClone(options.pendingCommands);
      for (const command of this.#pendingCommands) this.#queuedCommandIds.add(command.id);
    }
  }

  snapshot(): WorldState {
    return structuredClone(this.#state);
  }

  perception(agentId: string, radius = 6) {
    return getPerception(this.#state, agentId, radius);
  }

  submit(agentId: string, raw: unknown): CommandReceipt {
    const generatedId = `cmd-${this.#state.tick}-${Date.now()}-${++this.#commandSequence}-${crypto.randomUUID()}`;
    let command: WorldCommand;
    try {
      command = parseCommand(agentId, raw, this.#state.tick, generatedId);
    } catch (error) {
      return {
        accepted: false,
        commandId: generatedId,
        tick: this.#state.tick,
        reason: error instanceof Error ? error.message : "invalid command",
      };
    }

    const reason = this.#validateForQueue(command);
    if (reason !== undefined) {
      return { accepted: false, commandId: command.id, tick: this.#state.tick, reason };
    }

    this.#pendingCommands.push(command);
    this.#queuedCommandIds.add(command.id);
    return { accepted: true, commandId: command.id, tick: this.#state.tick };
  }

  #validateForQueue(command: WorldCommand): string | undefined {
    if (getAgent(this.#state, command.agentId) === undefined) return "unknown agent";
    if (
      this.#queuedCommandIds.has(command.id) ||
      this.#state.processedCommandIds.includes(command.id)
    ) {
      return "duplicate command id";
    }
    if (
      (command.type === "move" || command.type === "build") &&
      (!inBounds(this.#state, command.target) || !isPassable(this.#state, command.target))
    ) {
      return "target is outside the map or impassable";
    }
    if (
      command.type === "gather" &&
      command.target !== undefined &&
      (!inBounds(this.#state, command.target) || !isPassable(this.#state, command.target))
    ) {
      return "target is outside the map or impassable";
    }
    return undefined;
  }

  pendingCommands(): WorldCommand[] {
    return structuredClone(this.#pendingCommands);
  }

  tick(): { state: WorldState; receipts: readonly CommandReceipt[] } {
    const commands = this.#pendingCommands;
    this.#pendingCommands = [];
    for (const command of commands) this.#queuedCommandIds.delete(command.id);
    const commandedAgentIds = new Set(commands.map((command) => command.agentId));
    applyDependentCaregiverFollow(this.#state, commandedAgentIds);
    const fedAgents = applyAutonomousNeeds(this.#state, commandedAgentIds);
    const starvingAgentIds = new Set(
      this.#state.agents
        .filter((agent) => agent.autonomy && agent.energy <= 0 && !fedAgents.has(agent.id))
        .map((agent) => agent.id),
    );
    const result = simulate(this.#state, commands, this.#simulationConfig);
    for (const [agentId, status] of fedAgents) {
      const agent = getAgent(result.state, agentId);
      if (agent !== undefined) agent.status = status;
    }
    applyStarvation(result.state, starvingAgentIds);
    applyDemography(result.state);
    applySocialInteractions(result.state);
    result.state.events = result.state.events.slice(-this.#simulationConfig.eventLimit);
    this.#state = result.state;
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot, result.receipts);
    return { state: snapshot, receipts: result.receipts };
  }

  tickMany(count: number): WorldState {
    const safeCount = Math.max(1, Math.min(2_000, Math.floor(count)));
    for (let index = 0; index < safeCount; index += 1) this.tick();
    return this.snapshot();
  }

  reset(seed = this.#state.seed): WorldState {
    this.#state = createInitialWorld({
      seed,
      width: this.#state.width,
      height: this.#state.height,
      worldId: this.#state.worldId,
      regionId: this.#state.regionId,
    });
    this.#pendingCommands = [];
    this.#queuedCommandIds.clear();
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot, []);
    return snapshot;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
