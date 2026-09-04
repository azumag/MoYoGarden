import {
  advanceOutgoingHandoff,
  commitIncomingHandoff,
  prepareIncomingHandoff,
  reserveOutgoingHandoff,
  type AgentHandoffEnvelope,
  type IncomingAgentHandoff,
  type OutgoingAgentHandoff,
} from "./agent-handoff.js";
import {
  attachAgentOwnership,
  detachAgentOwnership,
  globalHandoffAgentId,
} from "./agent-ownership.js";
import {
  HEX_GRID_DIRECTIONS,
  hexGridDistance,
  hexGridHandoffTarget,
  nearestHexGridCell,
  type HexGridDirection,
} from "./hex-grid.js";
import type { GridPosition } from "./protocol.js";
import { regionHexTopology } from "./region-topology.js";
import { WorldRuntime } from "./runtime.js";
import { RegionDurableObject as BaseRegionDurableObject } from "./worker.js";
import { isPassable } from "./world.js";

interface HandoffEnv {
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

interface BaseRegionAccess {
  runtime: WorldRuntime;
  persist(): Promise<void>;
  broadcastSnapshot(): void;
}

const OUTGOING_HANDOFF_KEY = "handoff:outgoing:v1";
const INCOMING_HANDOFF_KEY = "handoff:incoming:v1";
const INTERNAL_PREFIX = "/api/internal/handoff/";
const ADMIN_HANDOFF_PATH = "/api/admin/handoff";
const ENTRY_FALLBACK_RADIUS = 3;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePosition(value: unknown): GridPosition | undefined {
  if (!isRecord(value)) return undefined;
  const x = Number(value.x);
  const y = Number(value.y);
  return Number.isInteger(x) && Number.isInteger(y) ? { x, y } : undefined;
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

function configuredRegionIds(env: HandoffEnv): string[] {
  const configured = env.REGION_IDS ?? env.DEFAULT_REGION_ID ?? "garden-1";
  const regions = configured
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => /^[a-z0-9][a-z0-9-]{0,47}$/.test(entry));
  return regions.length > 0 ? [...new Set(regions)] : ["garden-1"];
}

function adminAuthorized(request: Request, env: HandoffEnv): boolean {
  const hostname = new URL(request.url).hostname;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return true;
  const authorization = request.headers.get("authorization");
  const token = authorization === null ? undefined : /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim();
  return token !== undefined && env.ADMIN_TOKEN !== undefined && token === env.ADMIN_TOKEN;
}

function baseAccess(instance: RegionDurableObject): BaseRegionAccess {
  // Base RegionDurableObject currently declares these members as TypeScript
  // `private`, but they are ordinary runtime properties/methods rather than JS
  // `#private` fields. Keep this compatibility bridge isolated here while the
  // handoff protocol is staged; no public API depends on it.
  return instance as unknown as BaseRegionAccess;
}

function directionValue(value: unknown): HexGridDirection | undefined {
  return typeof value === "string" && HEX_GRID_DIRECTIONS.includes(value as HexGridDirection)
    ? value as HexGridDirection
    : undefined;
}

export class RegionDurableObject extends BaseRegionDurableObject {
  constructor(
    private readonly handoffCtx: DurableObjectState,
    private readonly handoffEnv: HandoffEnv,
  ) {
    super(handoffCtx, handoffEnv);
  }

  private async ensureAssigned(request: Request): Promise<Response | undefined> {
    const probe = new URL(request.url);
    probe.pathname = "/api/health";
    probe.search = "";
    const response = await super.fetch(new Request(probe, {
      method: "GET",
      headers: request.headers,
    }));
    return response.ok ? undefined : response;
  }

  private async outgoingRecords(): Promise<OutgoingAgentHandoff[]> {
    return await this.handoffCtx.storage.get<OutgoingAgentHandoff[]>(OUTGOING_HANDOFF_KEY) ?? [];
  }

  private async incomingRecords(): Promise<IncomingAgentHandoff[]> {
    return await this.handoffCtx.storage.get<IncomingAgentHandoff[]>(INCOMING_HANDOFF_KEY) ?? [];
  }

  private async writeOutgoing(records: readonly OutgoingAgentHandoff[]): Promise<void> {
    await this.handoffCtx.storage.put(OUTGOING_HANDOFF_KEY, structuredClone(records));
  }

  private async writeIncoming(records: readonly IncomingAgentHandoff[]): Promise<void> {
    await this.handoffCtx.storage.put(INCOMING_HANDOFF_KEY, structuredClone(records));
  }

  private stub(regionId: string): DurableObjectStub {
    return this.handoffEnv.REGIONS.get(this.handoffEnv.REGIONS.idFromName(regionId));
  }

  private internalRequest(regionId: string, path: string, value: unknown): Request {
    return new Request(`https://moyo.internal${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-moyo-region-internal": regionId,
      },
      body: JSON.stringify(value),
    });
  }

  private async resolveIncomingTarget(request: Request): Promise<Response> {
    const body = await readJson(request);
    const desired = isRecord(body) ? parsePosition(body.targetPosition) : undefined;
    if (desired === undefined) return json({ error: "targetPosition is required" }, 400);

    const access = baseAccess(this);
    const state = access.runtime.snapshot();
    if (isPassable(state, desired)) return json({ targetPosition: desired });

    const fallback = nearestHexGridCell(
      state,
      desired,
      (position) => hexGridDistance(position, desired) <= ENTRY_FALLBACK_RADIUS && isPassable(state, position),
    );
    if (fallback === undefined) {
      return json({ error: "no passable target near the mapped entry cell" }, 409);
    }
    return json({ targetPosition: fallback });
  }

  private async prepareIncoming(request: Request): Promise<Response> {
    const body = await readJson(request);
    if (!isRecord(body) || !isRecord(body.envelope)) return json({ error: "envelope is required" }, 400);
    const envelope = body.envelope as unknown as AgentHandoffEnvelope;
    const access = baseAccess(this);
    const state = access.runtime.snapshot();
    if (envelope.toRegionId !== state.regionId) return json({ error: "handoff target region mismatch" }, 409);
    if (!isPassable(state, envelope.targetPosition)) return json({ error: "handoff target is impassable" }, 409);

    const result = prepareIncomingHandoff(await this.incomingRecords(), envelope, state.tick);
    if (!result.ok) return json({ error: result.reason }, 409);
    await this.writeIncoming(result.records);
    return json({ transferId: envelope.transferId, phase: result.record?.phase ?? "prepared" });
  }

  private async commitIncoming(request: Request): Promise<Response> {
    const body = await readJson(request);
    const transferId = isRecord(body) && typeof body.transferId === "string" ? body.transferId : undefined;
    if (transferId === undefined) return json({ error: "transferId is required" }, 400);

    const records = await this.incomingRecords();
    const record = records.find((entry) => entry.envelope.transferId === transferId);
    if (record === undefined) return json({ error: "unknown incoming handoff" }, 404);
    const access = baseAccess(this);
    const state = access.runtime.snapshot();
    const globalId = globalHandoffAgentId(record.envelope.agent.id, record.envelope.fromRegionId);

    if (!state.agents.some((agent) => agent.id === globalId)) {
      const attached = attachAgentOwnership(
        state,
        access.runtime.pendingCommands(),
        record.envelope.agent,
        record.envelope.targetPosition,
        record.envelope.fromRegionId,
      );
      if (!attached.ok || attached.value === undefined) return json({ error: attached.reason }, 409);
      access.runtime = new WorldRuntime({
        state: attached.value.state,
        pendingCommands: attached.value.pendingCommands,
      });
      await access.persist();
      access.broadcastSnapshot();
    }

    const committed = commitIncomingHandoff(records, transferId, access.runtime.snapshot().tick);
    if (!committed.ok) return json({ error: committed.reason }, 409);
    await this.writeIncoming(committed.records);
    return json({ transferId, phase: "committed", agentId: globalId });
  }

  private async callTarget(regionId: string, path: string, value: unknown): Promise<Response> {
    return this.stub(regionId).fetch(this.internalRequest(regionId, path, value));
  }

  private async createEnvelope(
    agentId: string,
    direction: HexGridDirection,
    transferId: string,
  ): Promise<{ envelope?: AgentHandoffEnvelope; error?: Response }> {
    const access = baseAccess(this);
    const state = access.runtime.snapshot();
    const detached = detachAgentOwnership(state, access.runtime.pendingCommands(), agentId);
    if (!detached.ok || detached.value === undefined) {
      return { error: json({ error: detached.reason }, 409) };
    }

    const sourcePosition = detached.value.agent.position;
    const mappedTarget = hexGridHandoffTarget(state, sourcePosition, direction);
    if (mappedTarget === undefined) {
      return { error: json({ error: "agent is not on the requested hex boundary" }, 409) };
    }

    const topology = regionHexTopology(configuredRegionIds(this.handoffEnv), state.width, state.height);
    const sourceRegion = topology.find((entry) => entry.id === state.regionId);
    const targetRegionId = sourceRegion?.neighbors[direction] ?? null;
    if (targetRegionId === null) return { error: json({ error: "no neighboring region in that direction" }, 409) };

    const resolved = await this.callTarget(targetRegionId, `${INTERNAL_PREFIX}resolve`, {
      targetPosition: mappedTarget,
    });
    if (!resolved.ok) return { error: json({ error: `target resolve failed: ${await resolved.text()}` }, 502) };
    const resolution = await resolved.json() as unknown;
    const targetPosition = isRecord(resolution) ? parsePosition(resolution.targetPosition) : undefined;
    if (targetPosition === undefined) return { error: json({ error: "target returned an invalid entry cell" }, 502) };

    return {
      envelope: {
        transferId,
        fromRegionId: state.regionId,
        toRegionId: targetRegionId,
        direction,
        sourcePosition: { ...sourcePosition },
        targetPosition,
        agent: structuredClone(detached.value.agent),
        createdAtTick: state.tick,
      },
    };
  }

  private async continueOutgoing(envelope: AgentHandoffEnvelope): Promise<Response> {
    const access = baseAccess(this);
    let records = await this.outgoingRecords();
    let current = records.find((entry) => entry.envelope.transferId === envelope.transferId);
    if (current === undefined) return json({ error: "outgoing handoff was not reserved" }, 409);
    if (current.phase === "committed") {
      return json({ transferId: envelope.transferId, phase: "committed", toRegionId: envelope.toRegionId });
    }

    if (current.phase === "reserved") {
      const prepared = await this.callTarget(envelope.toRegionId, `${INTERNAL_PREFIX}prepare`, { envelope });
      if (!prepared.ok) return json({ error: `target prepare failed: ${await prepared.text()}` }, 502);

      const state = access.runtime.snapshot();
      const detached = detachAgentOwnership(state, access.runtime.pendingCommands(), envelope.agent.id);
      if (detached.ok && detached.value !== undefined) {
        access.runtime = new WorldRuntime({
          state: detached.value.snapshot.state,
          pendingCommands: detached.value.snapshot.pendingCommands,
        });
        await access.persist();
        access.broadcastSnapshot();
      } else if (detached.reason !== "unknown agent") {
        return json({ error: detached.reason }, 409);
      }

      const advanced = advanceOutgoingHandoff(records, envelope.transferId, "detached", access.runtime.snapshot().tick);
      if (!advanced.ok) return json({ error: advanced.reason }, 409);
      records = advanced.records;
      await this.writeOutgoing(records);
      current = advanced.record;
    }

    if (current?.phase === "detached") {
      const committedTarget = await this.callTarget(envelope.toRegionId, `${INTERNAL_PREFIX}commit`, {
        transferId: envelope.transferId,
      });
      if (!committedTarget.ok) return json({ error: `target commit failed: ${await committedTarget.text()}` }, 502);

      const advanced = advanceOutgoingHandoff(records, envelope.transferId, "committed", access.runtime.snapshot().tick);
      if (!advanced.ok) return json({ error: advanced.reason }, 409);
      await this.writeOutgoing(advanced.records);
      const targetResult = await committedTarget.json() as unknown;
      return json({
        transferId: envelope.transferId,
        phase: "committed",
        toRegionId: envelope.toRegionId,
        agentId: isRecord(targetResult) ? targetResult.agentId : undefined,
      });
    }

    return json({ error: "unexpected outgoing handoff phase" }, 500);
  }

  private async adminHandoff(request: Request): Promise<Response> {
    if (!adminAuthorized(request, this.handoffEnv)) return json({ error: "admin token required" }, 401);
    const body = await readJson(request);
    if (!isRecord(body) || typeof body.transferId !== "string" || body.transferId.trim() === "") {
      return json({ error: "transferId is required for idempotent retries" }, 400);
    }
    const transferId = body.transferId.trim();

    const existing = (await this.outgoingRecords()).find(
      (entry) => entry.envelope.transferId === transferId,
    );
    if (existing !== undefined) return this.continueOutgoing(existing.envelope);

    if (typeof body.agentId !== "string") return json({ error: "agentId is required" }, 400);
    const direction = directionValue(body.direction);
    if (direction === undefined) return json({ error: "valid hex direction is required" }, 400);

    const created = await this.createEnvelope(body.agentId, direction, transferId);
    if (created.error !== undefined || created.envelope === undefined) {
      return created.error ?? json({ error: "could not create handoff" }, 409);
    }

    const access = baseAccess(this);
    const reserved = reserveOutgoingHandoff(
      await this.outgoingRecords(),
      created.envelope,
      access.runtime.snapshot().tick,
    );
    if (!reserved.ok) return json({ error: reserved.reason }, 409);
    await this.writeOutgoing(reserved.records);
    return this.continueOutgoing(created.envelope);
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith(INTERNAL_PREFIX) || url.pathname === ADMIN_HANDOFF_PATH) {
      const assignmentError = await this.ensureAssigned(request);
      if (assignmentError !== undefined) return assignmentError;
    }

    if (request.method === "POST" && url.pathname === `${INTERNAL_PREFIX}resolve`) {
      return this.handoffCtx.blockConcurrencyWhile(() => this.resolveIncomingTarget(request));
    }
    if (request.method === "POST" && url.pathname === `${INTERNAL_PREFIX}prepare`) {
      return this.handoffCtx.blockConcurrencyWhile(() => this.prepareIncoming(request));
    }
    if (request.method === "POST" && url.pathname === `${INTERNAL_PREFIX}commit`) {
      return this.handoffCtx.blockConcurrencyWhile(() => this.commitIncoming(request));
    }
    if (request.method === "POST" && url.pathname === ADMIN_HANDOFF_PATH) {
      return this.handoffCtx.blockConcurrencyWhile(() => this.adminHandoff(request));
    }
    return super.fetch(request);
  }
}
