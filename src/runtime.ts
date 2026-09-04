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
import { simulate } from "./simulation.js";
import { ensureWorldExtent } from "./world-scale.js";
import {
  activeFactionStructures,
  createInitialWorld,
  getAgent,
  getFaction,
  getPerception,
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
const POPULATION_GROWTH_INTERVAL = 60;
const POPULATION_FOOD_BUFFER_PER_AGENT = 4;
const POPULATION_GROWTH_FOOD_COST = 6;
const POPULATION_HEALTH_THRESHOLD = 70;
const POPULATION_ENERGY_THRESHOLD = 35;
const POPULATION_SETTLEMENT_RADIUS = 3;
const SOCIAL_INTERVAL = 12;
const SOCIAL_RADIUS = 2;
const SOCIAL_PAIR_COOLDOWN = 48;
const SOCIAL_MAX_CONVERSATIONS_PER_TICK = 2;
const SOCIAL_ADVICE_ENERGY_THRESHOLD = LOW_ENERGY_THRESHOLD + 7;

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

function settlementGrowthSite(state: WorldState, factionId: string): GridPosition | undefined {
  const camps = activeFactionStructures(state, factionId)
    .filter((structure) => structure.type === "camp")
    .sort((a, b) => a.id.localeCompare(b.id));
  if (camps.length === 0) return undefined;

  const occupied = new Set([
    ...state.agents.map((agent) => `${agent.position.x},${agent.position.y}`),
    ...state.structures.map((structure) => `${structure.position.x},${structure.position.y}`),
  ]);
  const candidates = state.tiles
    .filter((tile) => tile.terrain !== "water" && !occupied.has(`${tile.x},${tile.y}`))
    .map((tile) => ({
      tile,
      distance: Math.min(...camps.map((camp) => manhattanDistance(tile, camp.position))),
    }))
    .filter((candidate) => candidate.distance <= POPULATION_SETTLEMENT_RADIUS)
    .sort((a, b) => a.distance - b.distance || a.tile.y - b.tile.y || a.tile.x - b.tile.x);
  const candidate = candidates[0]?.tile;
  return candidate === undefined ? undefined : { x: candidate.x, y: candidate.y };
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

function applyPopulationGrowth(state: WorldState): void {
  if (state.tick === 0 || state.tick % POPULATION_GROWTH_INTERVAL !== 0) return;

  for (const faction of [...state.factions].sort((a, b) => a.id.localeCompare(b.id))) {
    const population = state.agents.filter((agent) => agent.factionId === faction.id);
    if (population.length < 2) continue;
    const healthyPopulation = population.filter(
      (agent) => agent.hp >= POPULATION_HEALTH_THRESHOLD && agent.energy >= POPULATION_ENERGY_THRESHOLD,
    );
    if (healthyPopulation.length < 2) continue;

    const foodNeeded =
      population.length * POPULATION_FOOD_BUFFER_PER_AGENT + POPULATION_GROWTH_FOOD_COST;
    if (faction.resources.food < foodNeeded) continue;
    const position = settlementGrowthSite(state, faction.id);
    if (position === undefined) continue;
    if (!consumeStoredFood(state, faction.id, POPULATION_GROWTH_FOOD_COST)) continue;

    const role = populationRole(state, faction.id);
    const generation = population.length + 1;
    const prefix = faction.name.split(/\s+/)[0] || faction.id;
    state.agents.push({
      id: `agent-${faction.id}-${role}-generation-${state.tick}-${generation}`,
      name: `${prefix} ${generation}`,
      factionId: faction.id,
      role,
      position,
      hp: 100,
      energy: 70,
      capacity: role === "builder" ? 32 : 24,
      inventory: emptyInventory(),
      autonomy: true,
      goal: populationGoal(role),
      status: "new generation settling",
    });
  }
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
      line: `I'm gathering ${task.resource} ${location}.`,
    };
  }
  if (task?.type === "build") {
    return {
      topic: "construction",
      line: `I'm working on the ${task.structureType} at ${task.target.x},${task.target.y}.`,
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
    const speakerTask = speaker.task;
    if (
      speakerTask?.type !== "gather" ||
      speakerTask.resource !== social.resource ||
      speakerTask.target === undefined ||
      !inBounds(state, speakerTask.target) ||
      !isPassable(state, speakerTask.target)
    ) {
      return undefined;
    }

    const shortage = factionSupplyShortage(state, listener.factionId);
    const relevant =
      roleResource(listener.role) === social.resource ||
      shortage === social.resource ||
      currentTask?.type === "gather" && currentTask.resource === social.resource;
    if (!relevant) return undefined;
    if (currentTask?.type === "gather" && currentTask.resource !== social.resource) return undefined;

    const sharedTarget = { ...speakerTask.target };
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
      target: sharedTarget,
    };
    listener.status = `following ${speaker.name}'s ${social.resource} report`;
    return sharedTarget;
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
        ...(adviceTarget === undefined ? {} : { adviceAccepted: true, adviceTarget }),
      },
    });
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
    applyPopulationGrowth(result.state);
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
