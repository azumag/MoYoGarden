import { hexGridCrossingDirection } from "./hex-grid.js";
import type { WorldState } from "./protocol.js";
import { WorldRuntime } from "./runtime.js";
import { RegionDurableObject as HandoffRegionDurableObject } from "./handoff-region.js";

interface MoveHandoffEnv {
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

interface RuntimeAccess {
  runtime: WorldRuntime;
}

const COMMAND_PATH = /^\/api\/agents\/([^/]+)\/commands$/;
const STABLE_COMMAND_ID = /^[a-z0-9][a-z0-9:._-]{0,119}$/i;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePosition(value: unknown): { x: number; y: number } | undefined {
  if (!isRecord(value)) return undefined;
  const x = Number(value.x);
  const y = Number(value.y);
  return Number.isInteger(x) && Number.isInteger(y) ? { x, y } : undefined;
}

function commandAuthorized(request: Request, env: MoveHandoffEnv): boolean {
  const hostname = new URL(request.url).hostname;
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    env.OPEN_COMMANDS?.toLowerCase() === "true"
  ) {
    return true;
  }
  const authorization = request.headers.get("authorization");
  const token = authorization === null ? undefined : /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim();
  return token !== undefined && (
    token === env.COMMAND_TOKEN ||
    token === env.ADMIN_TOKEN
  );
}

function runtimeAccess(instance: RegionDurableObject): RuntimeAccess {
  return instance as unknown as RuntimeAccess;
}

export class RegionDurableObject extends HandoffRegionDurableObject {
  constructor(
    state: DurableObjectState,
    private readonly moveEnv: MoveHandoffEnv,
  ) {
    super(state, moveEnv);
  }

  private async ensureMoveAssigned(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url);
    url.pathname = "/api/health";
    url.search = "";
    const response = await super.fetch(new Request(url, {
      method: "GET",
      headers: request.headers,
    }));
    return response.ok ? undefined : response;
  }

  private localHandoffRequest(request: Request, payload: unknown): Request {
    const headers = new Headers({ "content-type": "application/json" });
    const regionId = request.headers.get("x-moyo-region-internal");
    if (regionId !== null) headers.set("x-moyo-region-internal", regionId);
    // This request never leaves the Durable Object. The localhost host activates
    // the base handoff class's local-admin allowance without depending on an
    // ADMIN_TOKEN being configured for command-token clients.
    return new Request("http://localhost/api/admin/handoff", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
  }

  private async handoffResponse(
    request: Request,
    commandId: string,
    tick: number,
    payload: unknown,
  ): Promise<Response> {
    const handoff = await super.fetch(this.localHandoffRequest(request, payload));
    if (!handoff.ok) return handoff;
    return json({
      accepted: true,
      commandId,
      tick,
      handoff: await handoff.json() as unknown,
    }, 202);
  }

  private async maybeCrossRegionMove(request: Request, agentId: string): Promise<Response | undefined> {
    let raw: unknown;
    try {
      raw = await request.clone().json() as unknown;
    } catch {
      return undefined;
    }
    if (!isRecord(raw) || raw.type !== "move") return undefined;
    const target = parsePosition(raw.target);
    if (target === undefined) return undefined;

    const commandId = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!STABLE_COMMAND_ID.test(commandId)) {
      const assignmentError = await this.ensureMoveAssigned(request);
      if (assignmentError !== undefined) return assignmentError;
      const state = runtimeAccess(this).runtime.snapshot();
      const agent = state.agents.find((entry) => entry.id === agentId);
      if (agent === undefined || hexGridCrossingDirection(state, agent.position, target) === undefined) {
        return undefined;
      }
      return json({
        accepted: false,
        commandId: commandId || "missing",
        tick: state.tick,
        reason: "cross-region move requires a stable command id",
      }, 400);
    }

    if (!commandAuthorized(request, this.moveEnv)) {
      return json({ error: "command token required" }, 401);
    }

    const assignmentError = await this.ensureMoveAssigned(request);
    if (assignmentError !== undefined) return assignmentError;
    const access = runtimeAccess(this);
    const state: WorldState = access.runtime.snapshot();
    const transferId = `move:${commandId}`;
    const agent = state.agents.find((entry) => entry.id === agentId);

    if (agent === undefined) {
      // Successful handoff removes the source agent before the client receives
      // the response. Retrying the same command therefore resumes by transfer
      // ID before falling back to the ordinary "unknown agent" response.
      const resumed = await super.fetch(this.localHandoffRequest(request, { transferId }));
      if (resumed.ok) {
        return json({
          accepted: true,
          commandId,
          tick: state.tick,
          handoff: await resumed.json() as unknown,
        }, 202);
      }
      if (resumed.status !== 400) return resumed;
      return undefined;
    }

    const direction = hexGridCrossingDirection(state, agent.position, target);
    if (direction === undefined) return undefined;

    if (
      state.processedCommandIds.includes(commandId) ||
      access.runtime.pendingCommands().some((command) => command.id === commandId)
    ) {
      return json({
        accepted: false,
        commandId,
        tick: state.tick,
        reason: "duplicate command id",
      }, 400);
    }

    return this.handoffResponse(
      request,
      commandId,
      state.tick,
      { transferId, agentId, direction },
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = request.method === "POST" ? COMMAND_PATH.exec(url.pathname) : null;
    if (match !== null) {
      const agentId = decodeURIComponent(match[1] ?? "");
      const crossing = await this.maybeCrossRegionMove(request, agentId);
      if (crossing !== undefined) return crossing;
    }
    return super.fetch(request);
  }
}
