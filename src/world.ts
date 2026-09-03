import {
  AGENT_ROLES,
  type Agent,
  type AgentRole,
  emptyInventory,
  type Faction,
  type GridPosition,
  type Perception,
  publicAgent,
  type ResourceKind,
  type Structure,
  type Tile,
  type WorldEvent,
  type WorldState,
  manhattanDistance,
  positionKey,
} from "./protocol.js";
import { createRandom } from "./prng.js";

export interface WorldOptions {
  seed?: number;
  width?: number;
  height?: number;
  worldId?: string;
  regionId?: string;
}

const DEFAULT_WIDTH = 32;
const DEFAULT_HEIGHT = 20;

const FACTION_DEFINITIONS = [
  {
    id: "ember",
    name: "Ember Union",
    color: "#ef6c45",
    spawn: { x: 4, y: 4 },
    agentNames: ["Aki", "Beryl", "Cinder", "Dawn"],
  },
  {
    id: "azure",
    name: "Azure Compact",
    color: "#4f86e8",
    spawn: { x: 27, y: 4 },
    agentNames: ["Iris", "Juno", "Kite", "Lumen"],
  },
  {
    id: "verdant",
    name: "Verdant League",
    color: "#53a968",
    spawn: { x: 16, y: 15 },
    agentNames: ["Moss", "Nori", "Olive", "Pine"],
  },
] as const;

const ROLE_ORDER: readonly AgentRole[] = [
  "builder",
  "woodcutter",
  "miner",
  "forager",
];

const ELEVATION_WATER_RADIUS = 5;

function seededUnit(seed: number, salt: number): number {
  let value = (seed ^ salt) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  value = (value ^ (value >>> 16)) >>> 0;
  return value / 0xffff_ffff;
}

export function ensureTileElevations(
  state: Pick<WorldState, "seed" | "width" | "height" | "tiles">,
): void {
  if (state.tiles.every((tile) => Number.isFinite(tile.elevation ?? Number.NaN))) return;

  const waterTiles = state.tiles.filter((tile) => tile.terrain === "water");
  const phaseX = seededUnit(state.seed, 0x1f123bb5) * Math.PI * 2;
  const phaseY = seededUnit(state.seed, 0x5a17c9e3) * Math.PI * 2;
  const phaseDiagonal = seededUnit(state.seed, 0x7139a2d1) * Math.PI * 2;

  for (const tile of state.tiles) {
    if (tile.terrain === "water") {
      tile.elevation = 0;
      continue;
    }

    let nearestWater = ELEVATION_WATER_RADIUS;
    for (const water of waterTiles) {
      nearestWater = Math.min(nearestWater, manhattanDistance(tile, water));
      if (nearestWater <= 1) break;
    }

    const nx = (tile.x + 0.5) / Math.max(1, state.width);
    const ny = (tile.y + 0.5) / Math.max(1, state.height);
    const broad = (
      Math.sin(nx * Math.PI * 2 + phaseX) +
      Math.cos(ny * Math.PI * 2 + phaseY)
    ) * 0.5;
    const diagonal = Math.sin((nx + ny) * Math.PI * 3 + phaseDiagonal);
    const waterRise = Math.min(1, nearestWater / ELEVATION_WATER_RADIUS);
    const elevation = 0.3 + broad * 0.13 + diagonal * 0.07 + waterRise * 0.22;
    tile.elevation = Math.max(0.03, Math.min(0.95, elevation));
  }
}

export function tileIndex(state: Pick<WorldState, "width">, x: number, y: number): number {
  return y * state.width + x;
}

export function inBounds(
  state: Pick<WorldState, "width" | "height">,
  position: GridPosition,
): boolean {
  return (
    position.x >= 0 &&
    position.y >= 0 &&
    position.x < state.width &&
    position.y < state.height
  );
}

export function getTile(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  position: GridPosition,
): Tile | undefined {
  if (!inBounds(state, position)) return undefined;
  return state.tiles[tileIndex(state, position.x, position.y)];
}

export function isPassableTile(tile: Tile | undefined): boolean {
  return tile !== undefined && tile.terrain !== "water";
}

export function isPassable(
  state: Pick<WorldState, "width" | "height" | "tiles">,
  position: GridPosition,
): boolean {
  return isPassableTile(getTile(state, position));
}

export function getAgent(state: WorldState, agentId: string): Agent | undefined {
  return state.agents.find((agent) => agent.id === agentId);
}

export function getFaction(state: WorldState, factionId: string): Faction | undefined {
  return state.factions.find((faction) => faction.id === factionId);
}

export function getStructure(state: WorldState, structureId: string): Structure | undefined {
  return state.structures.find((structure) => structure.id === structureId);
}

export function activeFactionStructures(state: WorldState, factionId: string): Structure[] {
  return state.structures.filter(
    (structure) => structure.factionId === factionId && structure.status === "active",
  );
}

export function nearestFactionStructure(
  state: WorldState,
  factionId: string,
  position: GridPosition,
): Structure | undefined {
  return activeFactionStructures(state, factionId)
    .sort((a, b) => {
      const distance =
        manhattanDistance(a.position, position) - manhattanDistance(b.position, position);
      return distance || a.id.localeCompare(b.id);
    })[0];
}

function createTile(x: number, y: number, random: ReturnType<typeof createRandom>): Tile {
  const terrainRoll = random.next();
  if (terrainRoll < 0.08) {
    return { x, y, terrain: "water" };
  }
  if (terrainRoll < 0.33) {
    const maxAmount = random.int(20, 38);
    return {
      x,
      y,
      terrain: "forest",
      resource: { kind: "wood", amount: maxAmount, maxAmount },
    };
  }
  if (terrainRoll < 0.5) {
    const maxAmount = random.int(18, 34);
    return {
      x,
      y,
      terrain: "hill",
      resource: { kind: "stone", amount: maxAmount, maxAmount },
    };
  }

  if (random.next() < 0.34) {
    const maxAmount = random.int(12, 28);
    return {
      x,
      y,
      terrain: "plain",
      resource: { kind: "food", amount: maxAmount, maxAmount },
    };
  }
  return { x, y, terrain: "plain" };
}

function forceTile(
  tiles: Tile[],
  width: number,
  position: GridPosition,
  terrain: Tile["terrain"],
  resource?: ResourceKind,
): void {
  const index = position.y * width + position.x;
  const tile: Tile = { x: position.x, y: position.y, terrain };
  if (resource !== undefined) {
    const amount = 32;
    tile.resource = { kind: resource, amount, maxAmount: amount };
  }
  tiles[index] = tile;
}

function ensureSpawnArea(tiles: Tile[], width: number, height: number, spawn: GridPosition): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const x = spawn.x + dx;
      const y = spawn.y + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      forceTile(tiles, width, { x, y }, "plain");
    }
  }
  forceTile(tiles, width, { x: spawn.x + 2, y: spawn.y }, "forest", "wood");
  forceTile(tiles, width, { x: spawn.x - 2, y: spawn.y }, "forest", "wood");
  forceTile(tiles, width, { x: spawn.x, y: spawn.y + 2 }, "hill", "stone");
  forceTile(tiles, width, { x: spawn.x, y: spawn.y - 2 }, "hill", "stone");
  forceTile(tiles, width, { x: spawn.x + 1, y: spawn.y + 1 }, "plain", "food");
}

function spawnPositions(spawn: GridPosition): GridPosition[] {
  return [
    { x: spawn.x, y: spawn.y },
    { x: spawn.x + 1, y: spawn.y },
    { x: spawn.x, y: spawn.y + 1 },
    { x: spawn.x - 1, y: spawn.y },
  ];
}

function createAgent(
  factionId: string,
  name: string,
  role: AgentRole,
  position: GridPosition,
): Agent {
  return {
    id: `agent-${factionId}-${role}`,
    name,
    factionId,
    role,
    position,
    hp: 100,
    energy: 100,
    capacity: role === "builder" ? 32 : 24,
    inventory: emptyInventory(),
    autonomy: true,
    goal:
      role === "builder"
        ? "Found a settlement and expand it"
        : `Supply ${role === "woodcutter" ? "wood" : role === "miner" ? "stone" : "food"} to the settlement`,
    status: "idle",
  };
}

export function createInitialWorld(options: WorldOptions = {}): WorldState {
  const seed = options.seed ?? 424_242;
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  if (width < 16 || height < 12) {
    throw new Error("world must be at least 16x12");
  }

  const random = createRandom(seed);
  const tiles: Tile[] = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      tiles.push(createTile(x, y, random));
    }
  }

  const factions: Faction[] = [];
  const agents: Agent[] = [];

  for (const definition of FACTION_DEFINITIONS) {
    const spawn = {
      x: Math.min(width - 3, Math.max(2, definition.spawn.x)),
      y: Math.min(height - 3, Math.max(2, definition.spawn.y)),
    };
    ensureSpawnArea(tiles, width, height, spawn);
    factions.push({
      id: definition.id,
      name: definition.name,
      color: definition.color,
      resources: emptyInventory(),
      credits: 0,
    });

    const positions = spawnPositions(spawn);
    for (let index = 0; index < ROLE_ORDER.length; index += 1) {
      const role = ROLE_ORDER[index] ?? AGENT_ROLES[0];
      const position = positions[index] ?? spawn;
      const name = definition.agentNames[index] ?? `${definition.name} ${role}`;
      agents.push(createAgent(definition.id, name, role, position));
    }
  }

  ensureTileElevations({ seed, width, height, tiles });

  const initialEvent: WorldEvent = {
    id: "event-0-world-started",
    tick: 0,
    kind: "world_started",
    message: `Region ${options.regionId ?? "origin"} started with ${agents.length} autonomous agents.`,
  };

  return {
    schemaVersion: 1,
    worldId: options.worldId ?? "bot-mmo-demo",
    regionId: options.regionId ?? "origin",
    revision: 0,
    tick: 0,
    seed,
    rngState: random.state(),
    width,
    height,
    tiles,
    factions,
    agents,
    structures: [],
    events: [initialEvent],
    processedCommandIds: [],
  };
}

export function getPerception(state: WorldState, agentId: string, radius = 6): Perception {
  const self = getAgent(state, agentId);
  if (self === undefined) throw new Error(`unknown agent: ${agentId}`);
  const faction = getFaction(state, self.factionId);
  if (faction === undefined) throw new Error(`unknown faction: ${self.factionId}`);
  const safeRadius = Math.max(1, Math.min(12, Math.floor(radius)));

  const visibleTiles = state.tiles.filter(
    (tile) => manhattanDistance(tile, self.position) <= safeRadius,
  );
  const visibleTileKeys = new Set(visibleTiles.map((tile) => positionKey(tile)));
  const visibleAgents = state.agents
    .filter((agent) => visibleTileKeys.has(positionKey(agent.position)))
    .map(publicAgent);
  const visibleStructures = state.structures.filter((structure) =>
    visibleTileKeys.has(positionKey(structure.position)),
  );
  const recentEvents = state.events
    .filter((event) => {
      if (event.factionId === self.factionId) return true;
      if (event.position === undefined) return false;
      return visibleTileKeys.has(positionKey(event.position));
    })
    .slice(-30);

  return {
    tick: state.tick,
    revision: state.revision,
    regionId: state.regionId,
    radius: safeRadius,
    self: structuredClone(self),
    faction: structuredClone(faction),
    visibleTiles: structuredClone(visibleTiles),
    visibleAgents: structuredClone(visibleAgents),
    visibleStructures: structuredClone(visibleStructures),
    recentEvents: structuredClone(recentEvents),
    rules: {
      passableTerrain: ["plain", "forest", "hill"],
      inventoryCapacity: self.capacity,
      commandTypes: [
        "move",
        "gather",
        "build",
        "deposit",
        "trade",
        "set_autonomy",
        "set_goal",
        "clear_task",
      ],
    },
  };
}

export function validateWorldState(state: WorldState): string[] {
  const errors: string[] = [];
  if (state.tiles.length !== state.width * state.height) {
    errors.push("tile count does not match width * height");
  }
  for (const tile of state.tiles) {
    const elevation = tile.elevation;
    if (
      elevation !== undefined &&
      (!Number.isFinite(elevation) || elevation < 0 || elevation > 1)
    ) {
      errors.push(`invalid tile elevation: ${tile.x},${tile.y}`);
    }
  }
  const ids = new Set<string>();
  for (const agent of state.agents) {
    if (ids.has(agent.id)) errors.push(`duplicate agent id: ${agent.id}`);
    ids.add(agent.id);
    if (!inBounds(state, agent.position)) errors.push(`agent out of bounds: ${agent.id}`);
    if (!isPassable(state, agent.position)) errors.push(`agent on water: ${agent.id}`);
  }
  for (const structure of state.structures) {
    if (ids.has(structure.id)) errors.push(`duplicate structure id: ${structure.id}`);
    ids.add(structure.id);
    if (!inBounds(state, structure.position)) {
      errors.push(`structure out of bounds: ${structure.id}`);
    }
  }
  return errors;
}
