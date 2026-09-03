import {
  DEFAULT_SIMULATION_CONFIG,
  manhattanDistance,
  samePosition,
  type Agent,
  type CommandReceipt,
  parseCommand,
  type SimulationConfig,
  type WorldCommand,
  type WorldState,
} from "./protocol.js";
import { simulate } from "./simulation.js";
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

export class WorldRuntime {
  #state: WorldState;
  #pendingCommands: WorldCommand[] = [];
  #queuedCommandIds = new Set<string>();
  #listeners = new Set<SnapshotListener>();
  #commandSequence = 0;
  #simulationConfig: SimulationConfig;

  constructor(options: RuntimeOptions = {}) {
    this.#state = options.state ?? createInitialWorld({
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.width === undefined ? {} : { width: options.width }),
      ...(options.height === undefined ? {} : { height: options.height }),
    });
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
