import {
  DEFAULT_SIMULATION_CONFIG,
  type CommandReceipt,
  parseCommand,
  type SimulationConfig,
  type WorldCommand,
  type WorldState,
} from "./protocol.js";
import { simulate } from "./simulation.js";
import { createInitialWorld, getAgent, getPerception, inBounds, isPassable } from "./world.js";

export interface RuntimeOptions {
  state?: WorldState;
  seed?: number;
  width?: number;
  height?: number;
  simulationConfig?: SimulationConfig;
  pendingCommands?: WorldCommand[];
}

export type SnapshotListener = (state: WorldState, receipts: readonly CommandReceipt[]) => void;

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
    const result = simulate(this.#state, commands, this.#simulationConfig);
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
