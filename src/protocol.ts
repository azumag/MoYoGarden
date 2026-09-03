export const RESOURCE_KINDS = ["wood", "stone", "food"] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

export const TERRAIN_KINDS = ["plain", "forest", "hill", "water"] as const;
export type TerrainKind = (typeof TERRAIN_KINDS)[number];

export const STRUCTURE_TYPES = ["camp", "storehouse", "market", "workshop"] as const;
export type StructureType = (typeof STRUCTURE_TYPES)[number];

export const AGENT_ROLES = [
  "builder",
  "woodcutter",
  "miner",
  "forager",
  "scout",
  "trader",
] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export interface GridPosition {
  x: number;
  y: number;
}

export type Inventory = Record<ResourceKind, number>;

export interface ResourceDeposit {
  kind: ResourceKind;
  amount: number;
  maxAmount: number;
}

export interface Tile {
  x: number;
  y: number;
  terrain: TerrainKind;
  elevation?: number;
  flowTo?: GridPosition;
  drainage?: number;
  erosionPressure?: number;
  resource?: ResourceDeposit;
}

export interface Faction {
  id: string;
  name: string;
  color: string;
  resources: Inventory;
  credits: number;
}

export interface AgentTaskBase {
  source: "autonomy" | "external";
  issuedAtTick: number;
  expiresAtTick?: number;
}

export interface MoveTask extends AgentTaskBase {
  type: "move";
  target: GridPosition;
}

export interface GatherTask extends AgentTaskBase {
  type: "gather";
  resource: ResourceKind;
  target?: GridPosition;
}

export interface BuildTask extends AgentTaskBase {
  type: "build";
  structureType: StructureType;
  target: GridPosition;
  structureId?: string;
}

export interface DepositTask extends AgentTaskBase {
  type: "deposit";
  structureId?: string;
}

export interface TradeTask extends AgentTaskBase {
  type: "trade";
  targetAgentId: string;
  offer: Inventory;
  request: Inventory;
}

export type AgentTask = MoveTask | GatherTask | BuildTask | DepositTask | TradeTask;

export interface Agent {
  id: string;
  name: string;
  factionId: string;
  role: AgentRole;
  position: GridPosition;
  hp: number;
  energy: number;
  capacity: number;
  inventory: Inventory;
  autonomy: boolean;
  goal: string;
  status: string;
  task?: AgentTask;
}

export interface Structure {
  id: string;
  factionId: string;
  type: StructureType;
  position: GridPosition;
  status: "building" | "active";
  progress: number;
  requiredProgress: number;
  storage: Inventory;
}

export type EventKind =
  | "world_started"
  | "command_accepted"
  | "command_rejected"
  | "resource_gathered"
  | "resource_depleted"
  | "resources_deposited"
  | "construction_started"
  | "construction_progress"
  | "construction_completed"
  | "trade_completed"
  | "trade_failed"
  | "agent_moved"
  | "autonomy_changed"
  | "goal_changed";

export interface WorldEvent {
  id: string;
  tick: number;
  kind: EventKind;
  message: string;
  agentId?: string;
  factionId?: string;
  position?: GridPosition;
  data?: Record<string, unknown>;
}

export interface WorldState {
  schemaVersion: 1;
  worldId: string;
  regionId: string;
  revision: number;
  tick: number;
  seed: number;
  rngState: number;
  width: number;
  height: number;
  tiles: Tile[];
  factions: Faction[];
  agents: Agent[];
  structures: Structure[];
  events: WorldEvent[];
  processedCommandIds: string[];
}

export interface PublicAgent {
  id: string;
  name: string;
  factionId: string;
  role: AgentRole;
  position: GridPosition;
  hp: number;
  status: string;
  autonomy: boolean;
  goal: string;
}

export interface Perception {
  tick: number;
  revision: number;
  regionId: string;
  radius: number;
  self: Agent;
  faction: Faction;
  visibleTiles: Tile[];
  visibleAgents: PublicAgent[];
  visibleStructures: Structure[];
  recentEvents: WorldEvent[];
  rules: {
    passableTerrain: TerrainKind[];
    inventoryCapacity: number;
    commandTypes: CommandType[];
  };
}

export const COMMAND_TYPES = [
  "move",
  "gather",
  "build",
  "deposit",
  "trade",
  "set_autonomy",
  "set_goal",
  "clear_task",
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export interface CommandBase {
  id: string;
  agentId: string;
  submittedAtTick: number;
  type: CommandType;
}

export interface MoveCommand extends CommandBase {
  type: "move";
  target: GridPosition;
}

export interface GatherCommand extends CommandBase {
  type: "gather";
  resource: ResourceKind;
  target?: GridPosition;
}

export interface BuildCommand extends CommandBase {
  type: "build";
  structureType: StructureType;
  target: GridPosition;
}

export interface DepositCommand extends CommandBase {
  type: "deposit";
  structureId?: string;
}

export interface TradeCommand extends CommandBase {
  type: "trade";
  targetAgentId: string;
  offer: Inventory;
  request: Inventory;
}

export interface SetAutonomyCommand extends CommandBase {
  type: "set_autonomy";
  enabled: boolean;
}

export interface SetGoalCommand extends CommandBase {
  type: "set_goal";
  goal: string;
}

export interface ClearTaskCommand extends CommandBase {
  type: "clear_task";
}

export type WorldCommand =
  | MoveCommand
  | GatherCommand
  | BuildCommand
  | DepositCommand
  | TradeCommand
  | SetAutonomyCommand
  | SetGoalCommand
  | ClearTaskCommand;

export interface CommandReceipt {
  accepted: boolean;
  commandId: string;
  tick: number;
  reason?: string;
}

export interface SimulationConfig {
  eventLimit: number;
  commandHistoryLimit: number;
  resourceRegrowthInterval: number;
  externalTaskTtl: number;
}

export const DEFAULT_SIMULATION_CONFIG: SimulationConfig = {
  eventLimit: 300,
  commandHistoryLimit: 1_000,
  resourceRegrowthInterval: 30,
  externalTaskTtl: 120,
};

export const BUILD_RECIPES: Record<
  StructureType,
  { cost: Inventory; work: number; storageCapacity: number }
> = {
  camp: {
    cost: { wood: 8, stone: 4, food: 0 },
    work: 6,
    storageCapacity: 120,
  },
  storehouse: {
    cost: { wood: 14, stone: 8, food: 0 },
    work: 9,
    storageCapacity: 500,
  },
  market: {
    cost: { wood: 12, stone: 10, food: 4 },
    work: 11,
    storageCapacity: 250,
  },
  workshop: {
    cost: { wood: 10, stone: 14, food: 2 },
    work: 13,
    storageCapacity: 200,
  },
};

export function emptyInventory(): Inventory {
  return { wood: 0, stone: 0, food: 0 };
}

export function inventoryTotal(inventory: Inventory): number {
  return RESOURCE_KINDS.reduce((sum, kind) => sum + inventory[kind], 0);
}

export function cloneInventory(inventory: Inventory): Inventory {
  return {
    wood: inventory.wood,
    stone: inventory.stone,
    food: inventory.food,
  };
}

export function publicAgent(agent: Agent): PublicAgent {
  return {
    id: agent.id,
    name: agent.name,
    factionId: agent.factionId,
    role: agent.role,
    position: { ...agent.position },
    hp: agent.hp,
    status: agent.status,
    autonomy: agent.autonomy,
    goal: agent.goal,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function parsePosition(value: unknown, field: string): GridPosition {
  if (!isRecord(value) || !isInteger(value.x) || !isInteger(value.y)) {
    throw new Error(`${field} must be an object with integer x and y`);
  }
  return { x: value.x, y: value.y };
}

function parseInventory(value: unknown, field: string): Inventory {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  const inventory = emptyInventory();
  for (const kind of RESOURCE_KINDS) {
    const amount = value[kind] ?? 0;
    if (!isInteger(amount) || amount < 0) {
      throw new Error(`${field}.${kind} must be a non-negative integer`);
    }
    inventory[kind] = amount;
  }
  return inventory;
}

function enumValue<T extends readonly string[]>(
  values: T,
  value: unknown,
  field: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${field} must be one of: ${values.join(", ")}`);
  }
  return value as T[number];
}

export function parseCommand(
  agentId: string,
  raw: unknown,
  tick: number,
  generatedId: string,
): WorldCommand {
  if (!isRecord(raw)) {
    throw new Error("command body must be a JSON object");
  }

  const type = enumValue(COMMAND_TYPES, raw.type, "type");
  const id =
    typeof raw.id === "string" && raw.id.trim().length > 0
      ? raw.id.trim().slice(0, 120)
      : generatedId;
  const base = { id, agentId, submittedAtTick: tick };

  switch (type) {
    case "move":
      return { ...base, type, target: parsePosition(raw.target, "target") };
    case "gather": {
      const resource = enumValue(RESOURCE_KINDS, raw.resource, "resource");
      if (raw.target === undefined) {
        return { ...base, type, resource };
      }
      return {
        ...base,
        type,
        resource,
        target: parsePosition(raw.target, "target"),
      };
    }
    case "build":
      return {
        ...base,
        type,
        structureType: enumValue(STRUCTURE_TYPES, raw.structureType, "structureType"),
        target: parsePosition(raw.target, "target"),
      };
    case "deposit":
      return typeof raw.structureId === "string"
        ? { ...base, type, structureId: raw.structureId }
        : { ...base, type };
    case "trade":
      if (typeof raw.targetAgentId !== "string" || raw.targetAgentId.length === 0) {
        throw new Error("targetAgentId must be a non-empty string");
      }
      return {
        ...base,
        type,
        targetAgentId: raw.targetAgentId,
        offer: parseInventory(raw.offer, "offer"),
        request: parseInventory(raw.request, "request"),
      };
    case "set_autonomy":
      if (typeof raw.enabled !== "boolean") {
        throw new Error("enabled must be a boolean");
      }
      return { ...base, type, enabled: raw.enabled };
    case "set_goal":
      if (typeof raw.goal !== "string" || raw.goal.trim().length === 0) {
        throw new Error("goal must be a non-empty string");
      }
      return { ...base, type, goal: raw.goal.trim().slice(0, 240) };
    case "clear_task":
      return { ...base, type };
  }
}

export function positionKey(position: GridPosition): string {
  return `${position.x},${position.y}`;
}

export function samePosition(a: GridPosition, b: GridPosition): boolean {
  return a.x === b.x && a.y === b.y;
}

export function manhattanDistance(a: GridPosition, b: GridPosition): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}
