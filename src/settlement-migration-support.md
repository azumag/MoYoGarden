# Settlement migration support scoring

Settlement migration compares neighboring halo observations as **samples of destination quality**, not as a vote by the number of observed cells. A wider seam can expose more halo cells without representing a better region, so raw sample counts must not be used as a destination-quality tie-break.

Current support ordering is intentionally lexicographic:

1. sustainable resource diversity;
2. food / wood / stone carrying-capacity density (`maxAmount / passableCells`), with a small epsilon so floating-point normalization noise does not dominate later signals;
3. average pathogen reservoir when both sides have samples;
4. average erosion pressure when both sides have samples, preferring land that is currently less exposed to drainage/slope-driven soil loss;
5. whole-region population density (`occupants / passableCells`) when coherent bounded summaries exist;
6. active camp density (`activeStructures.camp / passableCells`) when coherent bounded summaries exist, preferring less already-settled land after ecological support and population pressure tie;
7. live food / wood / stone density (`amount / passableCells`), using the same small-noise rule so negligible live-supply differences do not mask meaningful environmental differences;
8. average drainage when both sides have samples;
9. surface-water fraction (`waterCells / observedCells`).

Only after support quality ties should route cost, crowding, canonical hex-direction order, and stable IDs resolve the choice. Observation footprint itself is not destination quality.

The existing depth-1 edge read carries a constant-size rolling-compatible region summary: current resources, renewable resource capacity, passable-cell count, population count, and optional active structure counts. Structure counts include only completed active `camp` / `storehouse` / `market` / `workshop` records; remote structure IDs, coordinates, inventories, and tasks are never copied. If independent edge reads disagree on a whole-region summary during a rolling tick, that signal is neutral for the planning pass rather than synthesizing mixed-time state.

## Bounded route hysteresis

A transit pioneer keeps exactly one previous-region hint. Besides rejecting an exact A→B→A reversal, the planner treats the previous region's immediate axial neighbor ring as the recent route wedge. On a hex lattice this prevents the shortest non-reversal loop, A→B→C→A, because the closing region is adjacent to both the current and immediately previous regions. The comparison uses axial identity, so legacy `garden-*` aliases and canonical `hex-q*-r*` IDs share the same hysteresis geometry.

Settlement migration now also keeps one bounded route anchor on the pioneer itself: `settlementMigrationOriginRegionId`. Preparing a camp kit in an established settlement resets that anchor to the current region; camp-less transit regions preserve it across ownership handoffs. Once the anchor exists, every continuation hop must **strictly increase axial hex distance from the migration origin**. A richer same-ring or inward frontier therefore cannot pull a pioneer into A→…→A circulation, while outward frontiers remain eligible and are still ranked by the normal support score.

This remains O(1) route memory: one immutable origin plus the existing immediate previous-region hint. It does not persist an unbounded visited-region log, does not add deeper synchronous region reads, and does not change Durable Object ownership. The origin is an optional field on the existing persisted `Agent` snapshot, so no schema-version bump or new handoff message is required. Older in-flight pioneers without the marker safely fall back to the previous-region wedge until the next camp-kit preparation establishes a new anchor. If all improving frontiers are non-progressing, the pioneer settles instead of oscillating.

The current halo remains a bounded depth-1 observation. Generalized multi-region routing should build on bounded/persisted region support and congestion summaries rather than expanding synchronous deep reads or reintroducing raw halo-size bias. The monotonic anchor prevents route cycles; summaries are still needed to choose better long-range destinations and to share planning with trade, build, and general logistics.


## Bounded family follow after frontier admission

A pioneer no longer causes immediate family members to teleport or follow every scouting hop. The pioneer keeps its existing immutable settlement origin while scouting. Once a target region has an active same-faction camp, positive storage headroom, and either stored food or live local food supply, that target sends an idempotent registration back to the origin region. The origin marks at most six directly related residents (active pregnancy partner, dependent children, their caregiver/co-parent) with only a final region identity.

Marked followers reuse the same depth-1 six-direction halo and crash-safe per-agent ownership handoff. Each hop must strictly reduce axial hex distance to the final region, source-local coordinates are discarded at the seam, and only one existing handoff journal is used at a time. External tasks remain authoritative. Infant/juvenile local caregiver-follow is suspended while this explicit family route marker exists, avoiding two competing autonomous move goals. The marker survives intermediate ownership transfers and is removed only when the follower actually attaches in the final region.

This is intentionally a bounded first stage rather than atomic group transfer: adults/caregivers are prioritized before dependents, the group is capped at six, and temporary separation can exist while serialized handoffs complete. It preserves existing WorldState schemaVersion 1 and does not copy remote Agent snapshots or source-local structure IDs across regions.
