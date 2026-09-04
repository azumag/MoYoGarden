import type { Agent, GridPosition } from "./protocol.js";
import type { HexGridDirection } from "./hex-grid.js";

export interface AgentHandoffEnvelope {
  transferId: string;
  fromRegionId: string;
  toRegionId: string;
  direction: HexGridDirection;
  sourcePosition: GridPosition;
  targetPosition: GridPosition;
  agent: Agent;
  createdAtTick: number;
}

export type OutgoingHandoffPhase = "reserved" | "detached" | "committed";
export type IncomingHandoffPhase = "prepared" | "committed";

export interface OutgoingAgentHandoff {
  envelope: AgentHandoffEnvelope;
  phase: OutgoingHandoffPhase;
  updatedAtTick: number;
}

export interface IncomingAgentHandoff {
  envelope: AgentHandoffEnvelope;
  phase: IncomingHandoffPhase;
  updatedAtTick: number;
}

export interface HandoffMutationResult<T> {
  ok: boolean;
  records: T[];
  record?: T;
  reason?: string;
}

const OUTGOING_PHASE_ORDER: Record<OutgoingHandoffPhase, number> = {
  reserved: 0,
  detached: 1,
  committed: 2,
};

function validIdentifier(value: string): boolean {
  return /^[a-z0-9][a-z0-9:._-]{0,159}$/i.test(value);
}

export function validateAgentHandoffEnvelope(envelope: AgentHandoffEnvelope): string | undefined {
  if (!validIdentifier(envelope.transferId)) return "invalid transfer id";
  if (!validIdentifier(envelope.fromRegionId) || !validIdentifier(envelope.toRegionId)) {
    return "invalid region id";
  }
  if (envelope.fromRegionId === envelope.toRegionId) return "handoff regions must differ";
  if (!validIdentifier(envelope.agent.id)) return "invalid agent id";
  if (!Number.isInteger(envelope.createdAtTick) || envelope.createdAtTick < 0) {
    return "invalid creation tick";
  }
  for (const position of [envelope.sourcePosition, envelope.targetPosition, envelope.agent.position]) {
    if (!Number.isInteger(position.x) || !Number.isInteger(position.y)) return "invalid handoff position";
  }
  if (
    envelope.agent.position.x !== envelope.sourcePosition.x ||
    envelope.agent.position.y !== envelope.sourcePosition.y
  ) {
    return "agent snapshot must remain at the reserved source position";
  }
  return undefined;
}

function samePosition(a: GridPosition, b: GridPosition): boolean {
  return a.x === b.x && a.y === b.y;
}

function sameEnvelope(a: AgentHandoffEnvelope, b: AgentHandoffEnvelope): boolean {
  return (
    a.transferId === b.transferId &&
    a.fromRegionId === b.fromRegionId &&
    a.toRegionId === b.toRegionId &&
    a.direction === b.direction &&
    a.createdAtTick === b.createdAtTick &&
    samePosition(a.sourcePosition, b.sourcePosition) &&
    samePosition(a.targetPosition, b.targetPosition) &&
    JSON.stringify(a.agent) === JSON.stringify(b.agent)
  );
}

function cloneEnvelope(envelope: AgentHandoffEnvelope): AgentHandoffEnvelope {
  return structuredClone(envelope);
}

export function reserveOutgoingHandoff(
  records: readonly OutgoingAgentHandoff[],
  envelope: AgentHandoffEnvelope,
  updatedAtTick = envelope.createdAtTick,
): HandoffMutationResult<OutgoingAgentHandoff> {
  const reason = validateAgentHandoffEnvelope(envelope);
  if (reason !== undefined) return { ok: false, records: structuredClone(records), reason };

  const existing = records.find((record) => record.envelope.transferId === envelope.transferId);
  if (existing !== undefined) {
    if (!sameEnvelope(existing.envelope, envelope)) {
      return {
        ok: false,
        records: structuredClone(records),
        reason: "transfer id already belongs to a different handoff",
      };
    }
    return { ok: true, records: structuredClone(records), record: structuredClone(existing) };
  }

  const conflictingAgent = records.find(
    (record) =>
      record.envelope.agent.id === envelope.agent.id &&
      record.phase !== "committed",
  );
  if (conflictingAgent !== undefined) {
    return {
      ok: false,
      records: structuredClone(records),
      reason: "agent already has an in-flight outgoing handoff",
    };
  }

  const record: OutgoingAgentHandoff = {
    envelope: cloneEnvelope(envelope),
    phase: "reserved",
    updatedAtTick,
  };
  return { ok: true, records: [...structuredClone(records), record], record: structuredClone(record) };
}

export function advanceOutgoingHandoff(
  records: readonly OutgoingAgentHandoff[],
  transferId: string,
  phase: OutgoingHandoffPhase,
  updatedAtTick: number,
): HandoffMutationResult<OutgoingAgentHandoff> {
  const index = records.findIndex((record) => record.envelope.transferId === transferId);
  if (index < 0) {
    return { ok: false, records: structuredClone(records), reason: "unknown outgoing handoff" };
  }
  const current = records[index];
  if (OUTGOING_PHASE_ORDER[phase] < OUTGOING_PHASE_ORDER[current.phase]) {
    return {
      ok: false,
      records: structuredClone(records),
      reason: "outgoing handoff phase cannot move backwards",
    };
  }
  if (phase === current.phase) {
    return { ok: true, records: structuredClone(records), record: structuredClone(current) };
  }
  const next: OutgoingAgentHandoff = {
    ...structuredClone(current),
    phase,
    updatedAtTick,
  };
  const nextRecords = structuredClone(records);
  nextRecords[index] = next;
  return { ok: true, records: nextRecords, record: structuredClone(next) };
}

export function prepareIncomingHandoff(
  records: readonly IncomingAgentHandoff[],
  envelope: AgentHandoffEnvelope,
  updatedAtTick: number,
): HandoffMutationResult<IncomingAgentHandoff> {
  const reason = validateAgentHandoffEnvelope(envelope);
  if (reason !== undefined) return { ok: false, records: structuredClone(records), reason };

  const existing = records.find((record) => record.envelope.transferId === envelope.transferId);
  if (existing !== undefined) {
    if (!sameEnvelope(existing.envelope, envelope)) {
      return {
        ok: false,
        records: structuredClone(records),
        reason: "transfer id already belongs to a different incoming handoff",
      };
    }
    return { ok: true, records: structuredClone(records), record: structuredClone(existing) };
  }

  const conflictingAgent = records.find(
    (record) => record.envelope.agent.id === envelope.agent.id && record.phase !== "committed",
  );
  if (conflictingAgent !== undefined) {
    return {
      ok: false,
      records: structuredClone(records),
      reason: "agent already has an in-flight incoming handoff",
    };
  }

  const record: IncomingAgentHandoff = {
    envelope: cloneEnvelope(envelope),
    phase: "prepared",
    updatedAtTick,
  };
  return { ok: true, records: [...structuredClone(records), record], record: structuredClone(record) };
}

export function commitIncomingHandoff(
  records: readonly IncomingAgentHandoff[],
  transferId: string,
  updatedAtTick: number,
): HandoffMutationResult<IncomingAgentHandoff> {
  const index = records.findIndex((record) => record.envelope.transferId === transferId);
  if (index < 0) {
    return { ok: false, records: structuredClone(records), reason: "unknown incoming handoff" };
  }
  const current = records[index];
  if (current.phase === "committed") {
    return { ok: true, records: structuredClone(records), record: structuredClone(current) };
  }
  const next: IncomingAgentHandoff = {
    ...structuredClone(current),
    phase: "committed",
    updatedAtTick,
  };
  const nextRecords = structuredClone(records);
  nextRecords[index] = next;
  return { ok: true, records: nextRecords, record: structuredClone(next) };
}

export function pendingOutgoingHandoffs(
  records: readonly OutgoingAgentHandoff[],
): OutgoingAgentHandoff[] {
  return structuredClone(records)
    .filter((record) => record.phase !== "committed")
    .sort((a, b) =>
      a.envelope.createdAtTick - b.envelope.createdAtTick ||
      a.envelope.transferId.localeCompare(b.envelope.transferId)
    );
}

export function pendingIncomingHandoffs(
  records: readonly IncomingAgentHandoff[],
): IncomingAgentHandoff[] {
  return structuredClone(records)
    .filter((record) => record.phase !== "committed")
    .sort((a, b) =>
      a.envelope.createdAtTick - b.envelope.createdAtTick ||
      a.envelope.transferId.localeCompare(b.envelope.transferId)
    );
}
