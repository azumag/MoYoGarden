import {
  COMMAND_TYPES,
  RESOURCE_KINDS,
  STRUCTURE_TYPES,
  type WorldCommand,
  type WorldState,
} from "./protocol.js";
import { WorldRuntime } from "./runtime.js";
import { updateTileHydrology } from "./simulation.js";
import { createInitialWorld, validateWorldState } from "./world.js";
import {
  alignRegionBoundaryElevations,
  ensureWorldExtent,
  TARGET_WORLD_HEIGHT,
  TARGET_WORLD_WIDTH,
} from "./world-scale.js";
import { HEX_DIRECTIONS, regionHexTopology, regionHexWindow } from "./region-topology.js";

interface Env {
  REGIONS: DurableObjectNamespace<RegionDurableObject>;
  ASSETS: Fetcher;
  DEFAULT_REGION_ID?: string;
  REGION_IDS?: string;
  WORLD_SEED?: string;
  TICK_MS?: string;
  OPEN_COMMANDS?: string;
  COMMAND_TOKEN?: string;
  ADMIN_TOKEN?: string;
}

interface StoredRegion {
  schemaVersion: 1;
  terrainFrameVersion?: 1;
  state: WorldState;
  pendingCommands: WorldCommand[];
  paused: boolean;
  updatedAt: number;
  lastSimulatedAt?: number;
}

export interface RegionLayoutEntry {
  id: string;
  index: number;
  grid: { x: number; y: number };
  origin: { x: number; y: number };
  extent: { width: number; height: number };
  neighbors: { west: string | null; east: string | null };
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-moyo-region,x-moyo-prefetch",
} as const;

const IDLE_TICK_MULTIPLIER = 6;
const ACTIVE_GRACE_MULTIPLIER = 6;
const MAX_IDLE_TICK_MS = 3_600_000;
const MAX_VIRTUAL_CATCH_UP_TICKS = 60;
const TERRAIN_FRAME_VERSION = 1;

export function regionTickDelayMs(tickMs: number, active: boolean): number {
  if (active) return tickMs;
  return Math.min(MAX_IDLE_TICK_MS, tickMs * IDLE_TICK_MULTIPLIER);
}

export interface RegionVirtualCatchUpPlan {
  dueTicks: number;
  runnableTicks: number;
  capped: boolean;
}

export function regionVirtualCatchUpPlan(
  lastSimulatedAt: number,
  now: number,
  tickMs: number,
  paused = false,
  maxTicks = MAX_VIRTUAL_CATCH_UP_TICKS,
): RegionVirtualCatchUpPlan {
  if (paused) return { dueTicks: 0, runnableTicks: 0, capped: false };
  if (
    !Number.isFinite(lastSimulatedAt) ||
    !Number.isFinite(now) ||
    !Number.isFinite(tickMs) ||
    tickMs <= 0 ||
    now <= lastSimulatedAt
  ) {
    return { dueTicks: 0, runnableTicks: 0, capped: false };
  }
  const dueTicks = Math.max(0, Math.floor((now - lastSimulatedAt) / tickMs));
  const cap = Number.isFinite(maxTicks) ? Math.max(0, Math.floor(maxTicks)) : MAX_VIRTUAL_CATCH_UP_TICKS;
  const runnableTicks = Math.min(dueTicks, cap);
  return { dueTicks, runnableTicks, capped: runnableTicks < dueTicks };
}

export function regionLayout(
  regionIds: readonly string[],
  width = TARGET_WORLD_WIDTH,
  height = TARGET_WORLD_HEIGHT,
): RegionLayoutEntry[] {
  return regionIds.map((id, index) => ({
    id,
    index,
    grid: { x: index, y: 0 },
    origin: { x: index * width, y: 0 },
    extent: { width, height },
    neighbors: {
      west: index > 0 ? regionIds[index - 1] ?? null : null,
      east: index + 1 < regionIds.length ? regionIds[index + 1] ?? null : null,
    },
  }));
}

export function regionWindow(
  regionIds: readonly string[],
  centerRegionId: string,
  radius = 1,
  width = TARGET_WORLD_WIDTH,
  height = TARGET_WORLD_HEIGHT,
): RegionLayoutEntry[] {
  return regionHexWindow(regionIds, centerRegionId, radius, width, height).map((entry) => ({
    id: entry.id,
    index: entry.index,
    grid: { x: entry.index, y: 0 },
    origin: entry.physicalOrigin,
    extent: { width, height },
    neighbors: {
      west: entry.index > 0 ? regionIds[entry.index - 1] ?? null : null,
      east: entry.index + 1 < regionIds.length ? regionIds[entry.index + 1] ?? null : null,
    },
  }));
}

function json(value: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(JSON_HEADERS);
  if (extraHeaders !== undefined) {
    for (const [name, headerValue] of new Headers(extraHeaders)) headers.set(name, headerValue);
  }
  return new Response(JSON.stringify(value), { status, headers });
}

function noContent(): Response {
  return new Response(null, { status: 204, headers: JSON_HEADERS });
}

function integerValue(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function boolValue(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === "true";
}

function allowedRegions(env: Env): string[] {
  const configured = env.REGION_IDS ?? env.DEFAULT_REGION_ID ?? "garden-1";
  const regions = configured
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^[a-z0-9][a-z0-9-]{0,47}$/.test(entry));
  return regions.length > 0 ? [...new Set(regions)] : ["garden-1"];
}

function resolveRegion(request: Request, env: Env): string | undefined {
  const url = new URL(request.url);
  const requested =
    url.searchParams.get("region")?.trim() || request.headers.get("x-moyo-region")?.trim();
  const regions = allowedRegions(env);
  if (requested === undefined || requested === "") return regions[0];
  return regions.includes(requested) ? requested : undefined;
}

function hashRegion(regionId: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < regionId.length; index += 1) {
    hash ^= regionId.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization === null) return undefined;
  return /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim();
}

function isLocalRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function canIssueCommands(request: Request, env: Env): boolean {
  if (isLocalRequest(request) || boolValue(env.OPEN_COMMANDS, false)) return true;
  const token = bearerToken(request);
  return (
    token !== undefined &&
    ((env.COMMAND_TOKEN !== undefined && token === env.COMMAND_TOKEN) ||
      (env.ADMIN_TOKEN !== undefined && token === env.ADMIN_TOKEN))
  );
}

function isAdmin(request: Request, env: Env): boolean {
  if (isLocalRequest(request)) return true;
  const token = bearerToken(request);
  return token !== undefined && env.ADMIN_TOKEN !== undefined && token === env.ADMIN_TOKEN;
}

async function readJson(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const contentLength = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("request body is too large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new Error("request body is too large");
  }
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

function parseBoundedInteger(value: string | null, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function eventPayload(state: WorldState, afterTick: number, limit: number) {
  return state.events.filter((event) => event.tick > afterTick).slice(-limit);
}

export class RegionDurableObject {
  private runtime!: WorldRuntime;
  private paused = false;
  private updatedAt = Date.now();
  private lastSimulatedAt = Date.now();
  private readonly tickMs: number;
  private assigned = false;
  private lastActivityAt = 0;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    this.tickMs = integerValue(env.TICK_MS, 10_000, 1_000, 3_600_000);
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<StoredRegion>("region");
      let migratedTerrainFrame = false;

      if (stored !== undefined) {
        try {
          const errors = validateWorldState(stored.state);
          if (stored.schemaVersion !== 1 || errors.length > 0) {
            throw new Error(errors.join("; ") || "unsupported persisted schema");
          }
          if (stored.terrainFrameVersion !== TERRAIN_FRAME_VERSION) {
            this.prepareRegionTerrain(stored.state);
            migratedTerrainFrame = true;
          }
          this.runtime = new WorldRuntime({
            state: stored.state,
            pendingCommands: stored.pendingCommands,
          });
          this.paused = stored.paused;
          this.updatedAt = stored.updatedAt;
          this.lastSimulatedAt = Number.isFinite(stored.lastSimulatedAt ?? Number.NaN)
            ? stored.lastSimulatedAt ?? stored.updatedAt
            : stored.updatedAt;
          this.assigned = true;
        } catch (error) {
          console.error("Resetting invalid persisted MoYoGarden region", error);
          this.runtime = this.createRuntime("garden-1");
        }
      } else {
        this.runtime = this.createRuntime("garden-1");
      }

      if (this.assigned && migratedTerrainFrame) await this.persist();
      if (this.assigned && !this.paused && (await this.ctx.storage.getAlarm()) === null) {
        await this.scheduleNextTick();
      }
    });
  }

  private terrainFrame(regionId: string): {
    worldSeed: number;
    entry: RegionLayoutEntry | undefined;
  } {
    const worldSeed = integerValue(this.env.WORLD_SEED, 424_242, 1, 0x7fff_ffff);
    const entry = regionLayout(allowedRegions(this.env)).find((candidate) => candidate.id === regionId);
    return { worldSeed, entry };
  }

  private prepareRegionTerrain(state: WorldState): void {
    const { worldSeed, entry } = this.terrainFrame(state.regionId);
    const origin = entry?.origin ?? { x: 0, y: 0 };
    ensureWorldExtent(state, TARGET_WORLD_WIDTH, TARGET_WORLD_HEIGHT, {
      worldSeed,
      originX: origin.x,
      originY: origin.y,
    });
    if (entry !== undefined) {
      alignRegionBoundaryElevations(
        state,
        worldSeed,
        origin.x,
        origin.y,
        {
          west: entry.neighbors.west !== null,
          east: entry.neighbors.east !== null,
        },
      );
    }
    updateTileHydrology(state);
  }

  private createRuntime(regionId: string): WorldRuntime {
    const baseSeed = integerValue(this.env.WORLD_SEED, 424_242, 1, 0x7fff_ffff);
    const seed = ((baseSeed ^ hashRegion(regionId)) & 0x7fff_ffff) || baseSeed;
    const state = createInitialWorld({ seed, regionId });
    this.prepareRegionTerrain(state);
    return new WorldRuntime({ state });
  }

  private async ensureRegion(request: Request): Promise<void> {
    const headerRegion = request.headers.get("x-moyo-region-internal")?.trim();
    if (headerRegion === undefined || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(headerRegion)) {
      throw new Error("missing internal region routing header");
    }

    if (!this.assigned) {
      this.runtime = this.createRuntime(headerRegion);
      this.assigned = true;
      this.lastSimulatedAt = Date.now();
      await this.persist();
      if (!this.paused) await this.scheduleNextTick();
      return;
    }

    const current = this.runtime.snapshot().regionId;
    if (current !== headerRegion) {
      throw new Error(`region routing mismatch: expected ${current}, received ${headerRegion}`);
    }
  }

  private async persist(): Promise<void> {
    this.updatedAt = Date.now();
    const stored: StoredRegion = {
      schemaVersion: 1,
      terrainFrameVersion: TERRAIN_FRAME_VERSION,
      state: this.runtime.snapshot(),
      pendingCommands: this.runtime.pendingCommands(),
      paused: this.paused,
      updatedAt: this.updatedAt,
      lastSimulatedAt: this.lastSimulatedAt,
    };
    await this.ctx.storage.put("region", stored);
  }

  private active(): boolean {
    if (this.ctx.getWebSockets().length > 0) return true;
    const graceMs = Math.min(MAX_IDLE_TICK_MS, this.tickMs * ACTIVE_GRACE_MULTIPLIER);
    return this.lastActivityAt > 0 && Date.now() - this.lastActivityAt <= graceMs;
  }

  private async scheduleNextTick(delayMs = regionTickDelayMs(this.tickMs, this.active())): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  private async markActivity(): Promise<void> {
    this.lastActivityAt = Date.now();
    if (!this.assigned || this.paused) return;
    const scheduled = await this.ctx.storage.getAlarm();
    const desired = this.lastActivityAt + this.tickMs;
    if (scheduled === null || scheduled > desired) await this.ctx.storage.setAlarm(desired);
  }

  private snapshotEnvelope() {
    return {
      type: "snapshot",
      state: this.runtime.snapshot(),
      paused: this.paused,
      tickMs: this.tickMs,
    };
  }

  private broadcastSnapshot(): void {
    const payload = JSON.stringify(this.snapshotEnvelope());
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(payload);
      } catch (error) {
        console.error("Failed to send region snapshot", error);
      }
    }
  }

  private async websocketResponse(): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [`region:${this.runtime.snapshot().regionId}`]);
    if (!this.paused) await this.scheduleNextTick(this.tickMs);
    server.send(JSON.stringify(this.snapshotEnvelope()));
    return new Response(null, { status: 101, webSocket: client });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") return noContent();
    try {
      await this.ensureRegion(request);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "region routing failed" }, 400);
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const passivePrefetch =
      request.method === "GET" &&
      path === "/api/world/snapshot" &&
      request.headers.get("x-moyo-prefetch") === "1";
    if (path !== "/api/health" && path !== "/api/rules" && !passivePrefetch) {
      await this.markActivity();
    }

    if (path === "/api/stream") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json({ error: "websocket upgrade required" }, 426);
      }
      return this.websocketResponse();
    }

    if (request.method === "GET" && path === "/api/health") {
      const state = this.runtime.snapshot();
      const websocketClients = this.ctx.getWebSockets().length;
      const active = this.active();
      const catchUpPlan = regionVirtualCatchUpPlan(
        this.lastSimulatedAt,
        Date.now(),
        this.tickMs,
        this.paused,
      );
      return json({
        ok: true,
        service: "moyo-garden",
        regionId: state.regionId,
        tick: state.tick,
        revision: state.revision,
        paused: this.paused,
        tickMs: this.tickMs,
        effectiveTickMs: regionTickDelayMs(this.tickMs, active),
        tickMode: active ? "active" : "idle",
        agents: state.agents.length,
        structures: state.structures.length,
        pendingCommands: this.runtime.pendingCommands().length,
        websocketClients,
        updatedAt: this.updatedAt,
        lastSimulatedAt: this.lastSimulatedAt,
        simulationLagMs: Math.max(0, Date.now() - this.lastSimulatedAt),
        virtualTicksDue: catchUpPlan.dueTicks,
        virtualTicksRunnable: catchUpPlan.runnableTicks,
        virtualTicksCapped: catchUpPlan.capped,
      });
    }

    if (request.method === "GET" && path === "/api/rules") {
      return json({
        commandTypes: COMMAND_TYPES,
        resourceKinds: RESOURCE_KINDS,
        structureTypes: STRUCTURE_TYPES,
        tickMs: this.tickMs,
        perceptionRadius: { min: 1, max: 12, default: 6 },
        commandAuthentication: boolValue(this.env.OPEN_COMMANDS, false)
          ? "open"
          : "bearer-token",
      });
    }

    if (request.method === "GET" && path === "/api/world/snapshot") {
      return json(this.runtime.snapshot());
    }
    if (request.method === "GET" && path === "/api/factions") {
      return json(this.runtime.snapshot().factions);
    }
    if (request.method === "GET" && path === "/api/agents") {
      return json(this.runtime.snapshot().agents);
    }
    if (request.method === "GET" && path === "/api/events") {
      const afterTick = parseBoundedInteger(url.searchParams.get("afterTick"), -1, -1, 1_000_000_000);
      const limit = parseBoundedInteger(url.searchParams.get("limit"), 100, 1, 200);
      return json(eventPayload(this.runtime.snapshot(), afterTick, limit));
    }

    const perceptionMatch = /^\/api\/agents\/([^/]+)\/perception$/.exec(path);
    if (request.method === "GET" && perceptionMatch !== null) {
      const agentId = decodeURIComponent(perceptionMatch[1] ?? "");
      const radius = parseBoundedInteger(url.searchParams.get("radius"), 6, 1, 12);
      try {
        return json(this.runtime.perception(agentId, radius));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "unknown agent" }, 404);
      }
    }

    const commandMatch = /^\/api\/agents\/([^/]+)\/commands$/.exec(path);
    if (request.method === "POST" && commandMatch !== null) {
      if (!canIssueCommands(request, this.env)) {
        return json({ error: "command token required" }, 401, {
          "www-authenticate": 'Bearer realm="MoYoGarden commands"',
        });
      }
      try {
        const agentId = decodeURIComponent(commandMatch[1] ?? "");
        const receipt = this.runtime.submit(agentId, await readJson(request));
        if (!receipt.accepted) return json(receipt, 400);
        await this.persist();
        return json(receipt, 202);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "invalid command" }, 400);
      }
    }

    if (request.method === "POST" && path.startsWith("/api/admin/")) {
      if (!isAdmin(request, this.env)) {
        return json({ error: "admin token required" }, 401, {
          "www-authenticate": 'Bearer realm="MoYoGarden admin"',
        });
      }

      try {
        if (path === "/api/admin/pause") {
          this.paused = true;
          await this.ctx.storage.deleteAlarm();
          await this.persist();
          this.broadcastSnapshot();
          return json({ paused: true });
        }
        if (path === "/api/admin/resume") {
          this.paused = false;
          // Paused wall time is intentionally not simulation backlog. Rebase the
          // virtual-time clock before future catch-up is allowed to consume it.
          this.lastSimulatedAt = Date.now();
          await this.persist();
          await this.scheduleNextTick();
          this.broadcastSnapshot();
          return json({ paused: false });
        }
        if (path === "/api/admin/tick") {
          const body = await readJson(request);
          const rawCount =
            typeof body === "object" && body !== null && "count" in body
              ? Number((body as { count?: unknown }).count)
              : 1;
          const count = Number.isInteger(rawCount) ? Math.max(1, Math.min(100, rawCount)) : 1;
          const state = this.runtime.tickMany(count);
          this.lastSimulatedAt = Date.now();
          await this.persist();
          this.broadcastSnapshot();
          return json({ tick: state.tick, count, state });
        }
        if (path === "/api/admin/reset") {
          const body = await readJson(request);
          const currentSeed = this.runtime.snapshot().seed;
          const rawSeed =
            typeof body === "object" && body !== null && "seed" in body
              ? Number((body as { seed?: unknown }).seed)
              : currentSeed;
          const seed = Number.isInteger(rawSeed)
            ? Math.max(1, Math.min(0x7fff_ffff, rawSeed))
            : currentSeed;
          const resetState = this.runtime.reset(seed);
          this.prepareRegionTerrain(resetState);
          this.runtime = new WorldRuntime({ state: resetState });
          const state = this.runtime.snapshot();
          this.lastSimulatedAt = Date.now();
          await this.persist();
          if (!this.paused) await this.scheduleNextTick();
          this.broadcastSnapshot();
          return json(state);
        }
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "admin action failed" }, 400);
      }
    }

    return json({ error: "not found" }, 404);
  }

  async alarm(): Promise<void> {
    if (!this.assigned || this.paused) return;
    this.runtime.tick();
    this.lastSimulatedAt = Date.now();
    await this.persist();
    this.broadcastSnapshot();
    await this.scheduleNextTick();
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    if (text === "ping") socket.send("pong");
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // Already closed by the peer.
    }
  }

  webSocketError(_socket: WebSocket, error: unknown): void {
    console.error("MoYoGarden WebSocket error", error);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return noContent();

    const url = new URL(request.url);
    if (url.pathname === "/api/meta") {
      const regions = allowedRegions(env);
      const requestedRegion = url.searchParams.get("region")?.trim();
      const scopedRegion = requestedRegion === undefined || requestedRegion === ""
        ? undefined
        : resolveRegion(request, env);
      if (requestedRegion !== undefined && requestedRegion !== "" && scopedRegion === undefined) {
        return json({ error: "unknown or disabled region" }, 404);
      }
      const radius = parseBoundedInteger(url.searchParams.get("radius"), 1, 0, 4);
      const topology = scopedRegion === undefined
        ? regionHexTopology(regions)
        : regionHexWindow(regions, scopedRegion, radius);
      const layout = scopedRegion === undefined
        ? regionLayout(regions)
        : regionWindow(regions, scopedRegion, radius);
      const exposedRegions = scopedRegion === undefined
        ? regions
        : topology.map((entry) => entry.id);
      return json({
        service: "moyo-garden",
        version: "0.2.0",
        regions: exposedRegions,
        defaultRegion: regions[0],
        runtime: "Cloudflare Workers + Durable Objects",
        world: {
          coordinateSpace: "global-grid",
          regionExtent: { width: TARGET_WORLD_WIDTH, height: TARGET_WORLD_HEIGHT },
          regionLayout: layout,
          regionTopology: {
            kind: "hex-axial",
            directions: HEX_DIRECTIONS,
            regions: topology,
          },
          windowEndpoint: "/api/world/window?region={regionId}&radius=1",
        },
      });
    }

    if (request.method === "GET" && url.pathname === "/api/world/window") {
      const regions = allowedRegions(env);
      const regionId = resolveRegion(request, env);
      if (regionId === undefined) return json({ error: "unknown or disabled region" }, 404);
      const radius = parseBoundedInteger(url.searchParams.get("radius"), 1, 0, 4);
      const entries = regionWindow(regions, regionId, radius);
      const chunks = await Promise.all(entries.map(async (entry) => {
        const stub = env.REGIONS.get(env.REGIONS.idFromName(entry.id));
        const headers = new Headers(request.headers);
        headers.set("x-moyo-region-internal", entry.id);
        if (entry.id !== regionId) headers.set("x-moyo-prefetch", "1");
        else headers.delete("x-moyo-prefetch");
        const snapshotUrl = new URL(request.url);
        snapshotUrl.pathname = "/api/world/snapshot";
        snapshotUrl.search = "";
        const response = await stub.fetch(new Request(snapshotUrl, { method: "GET", headers }));
        if (!response.ok) {
          return {
            regionId: entry.id,
            origin: entry.origin,
            extent: entry.extent,
            error: `snapshot HTTP ${response.status}`,
          };
        }
        return {
          regionId: entry.id,
          origin: entry.origin,
          extent: entry.extent,
          state: await response.json(),
        };
      }));
      return json({
        coordinateSpace: "global-grid",
        centerRegion: regionId,
        radius,
        chunks,
      });
    }

    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    const regionId = resolveRegion(request, env);
    if (regionId === undefined) return json({ error: "unknown or disabled region" }, 404);

    const stub = env.REGIONS.get(env.REGIONS.idFromName(regionId));
    const headers = new Headers(request.headers);
    headers.set("x-moyo-region-internal", regionId);
    return stub.fetch(new Request(request, { headers }));
  },
};