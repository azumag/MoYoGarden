import type { Agent, AgentLineage, AgentPregnancy } from "./protocol.js";

// Biological grandparents are the only ancestors persisted per agent: parents
// already live on `Agent.parents`, and deeper ancestors are intentionally out
// of scope so the record stays bounded like `socialMemory`.
export const LINEAGE_GRANDPARENT_LIMIT = 4;

const GLOBAL_AGENT_PREFIX = "agent-global:";

export function isGlobalAgentId(agentId: string): boolean {
  return agentId.startsWith(GLOBAL_AGENT_PREFIX);
}

/**
 * Canonical world-global identity for an agent reference. Region-local IDs are
 * scoped by the region that owns the reference today; already-global IDs pass
 * through unchanged so promotion is idempotent across repeated handoffs.
 */
export function canonicalLineageId(regionId: string, agentId: string): string {
  return isGlobalAgentId(agentId)
    ? agentId
    : `${GLOBAL_AGENT_PREFIX}${regionId}:${agentId}`;
}

export function globalHandoffAgentId(agentId: string, originRegionId: string): string {
  return canonicalLineageId(originRegionId, agentId);
}

/**
 * Compare a stored family reference with a resident agent ID. The two sides
 * may use different surface forms (region-local vs world-global) while still
 * naming the same physical agent, so both are canonicalized before comparing.
 */
export function lineageReferenceMatchesAgent(
  regionId: string,
  candidateId: string,
  referenceId: string,
): boolean {
  if (candidateId === referenceId) return true;
  return canonicalLineageId(regionId, candidateId)
    === canonicalLineageId(regionId, referenceId);
}

function normalizedGenerationValue(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Defensive read-side normalization for persisted lineage fields. */
export function normalizedLineageGeneration(
  lineage: Pick<AgentLineage, "generation"> | undefined,
): number {
  return normalizedGenerationValue(lineage?.generation);
}

function normalizedGrandparentList(ids: readonly unknown[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of (Array.isArray(ids) ? ids : [])) {
    if (typeof id !== "string" || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result.slice(0, LINEAGE_GRANDPARENT_LIMIT);
}

/**
 * Read-side view of an agent's lineage. Founders and residents persisted
 * before the field read as an empty record (`generation=0`, no grandparents).
 */
export function normalizedAgentLineage(
  agent: Pick<Agent, "lineage"> | undefined,
): AgentLineage {
  return {
    generation: normalizedLineageGeneration(agent?.lineage),
    grandparents: normalizedGrandparentList(agent?.lineage?.grandparents),
  };
}

/**
 * Canonicalize, deduplicate, sort and bound a list of grandparent references.
 * Sorting by the stored canonical form keeps the write order deterministic no
 * matter which surface form (local/global) each input arrived in.
 */
export function canonicalGrandparentList(
  regionId: string,
  ids: readonly unknown[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0) continue;
    const canonical = canonicalLineageId(regionId, id);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    result.push(canonical);
  }
  result.sort((a, b) => a.localeCompare(b));
  return result.slice(0, LINEAGE_GRANDPARENT_LIMIT);
}

/**
 * Close-kin check for reproduction. Every reference is canonicalized before
 * comparison so a handoff that promoted only one side of a relationship
 * cannot hide it, and so persisted `parents` in mixed local/global forms
 * still resolve to the same world-global identities.
 *
 * Bounded scope: great-grandparents are never recorded, so second cousins
 * (shared great-grandparents) stay outside the filter by design.
 */
export function areCloseLineageKin(
  regionId: string,
  first: Pick<Agent, "id" | "parents" | "lineage">,
  second: Pick<Agent, "id" | "parents" | "lineage">,
): boolean {
  const firstId = canonicalLineageId(regionId, first.id);
  const secondId = canonicalLineageId(regionId, second.id);
  if (firstId === secondId) return true;
  const canonicalRefs = (ids: readonly string[] | undefined): string[] =>
    (ids ?? []).map((id) => canonicalLineageId(regionId, id));
  const firstParents = canonicalRefs(first.parents);
  const secondParents = canonicalRefs(second.parents);
  const firstGrandparents = canonicalRefs(normalizedAgentLineage(first).grandparents);
  const secondGrandparents = canonicalRefs(normalizedAgentLineage(second).grandparents);
  const shares = (a: readonly string[], b: readonly string[]): boolean =>
    a.some((id) => b.includes(id));

  if (firstParents.includes(secondId) || secondParents.includes(firstId)) return true;
  if (shares(firstParents, secondParents)) return true;
  if (firstGrandparents.includes(secondId) || secondGrandparents.includes(firstId)) return true;
  if (shares(firstParents, secondGrandparents) || shares(secondParents, firstGrandparents)) return true;
  return shares(firstGrandparents, secondGrandparents);
}

/**
 * Conception-time snapshot of the partner's lineage, mirroring the existing
 * `partnerTraits` precedent so a later handoff or death cannot erase the
 * child's generation or grandparents before birth.
 */
export function pregnancyLineageSnapshot(
  partner: Pick<Agent, "lineage" | "parents">,
): Pick<AgentPregnancy, "partnerGeneration" | "partnerParents"> {
  return {
    partnerGeneration: normalizedLineageGeneration(partner.lineage),
    ...(Array.isArray(partner.parents)
      ? { partnerParents: [...partner.parents] as [string, string] }
      : {}),
  };
}

/**
 * Fix a newborn's lineage once at birth. Both parent sides are canonicalized
 * before the union so references still in region-local form (a `parents` list
 * or a `partnerParents` snapshot whose owner never handoffed) resolve to the
 * same world-global identities the ancestors themselves get on handoff. The
 * conception snapshot is authoritative for the partner side; a living
 * partner's current fields only backfill pregnancies persisted before the
 * snapshot existed.
 */
export function newbornAgentLineage(
  regionId: string,
  gestationalParent: Pick<Agent, "lineage" | "parents">,
  pregnancy: Pick<AgentPregnancy, "partnerGeneration" | "partnerParents">,
  partner: Pick<Agent, "lineage" | "parents"> | undefined,
): AgentLineage {
  const partnerGeneration = pregnancy.partnerGeneration === undefined
    ? normalizedLineageGeneration(partner?.lineage)
    : normalizedGenerationValue(pregnancy.partnerGeneration);
  const partnerParents = pregnancy.partnerParents ?? partner?.parents;
  const ids = (value: readonly string[] | undefined): readonly string[] =>
    Array.isArray(value) ? value : [];
  return {
    generation: Math.max(
      normalizedLineageGeneration(gestationalParent.lineage),
      partnerGeneration,
    ) + 1,
    grandparents: canonicalGrandparentList(regionId, [
      ...ids(gestationalParent.parents),
      ...ids(partnerParents),
    ]),
  };
}
