# Settlement migration support scoring

Settlement migration compares neighboring halo observations as **samples of destination quality**, not as a vote by the number of observed cells. A wider seam can expose more halo cells without representing a better region, so raw sample counts must not be used as a destination-quality tie-break.

Current support ordering is intentionally lexicographic:

1. sustainable resource diversity;
2. food / wood / stone carrying-capacity density (`maxAmount / passableCells`), with a small epsilon so floating-point normalization noise does not dominate later signals;
3. average pathogen reservoir when both sides have samples;
4. average erosion pressure when both sides have samples, preferring land that is currently less exposed to drainage/slope-driven soil loss;
5. live food / wood / stone density (`amount / passableCells`), using the same small-noise rule so negligible live-supply differences do not mask meaningful environmental differences;
6. average drainage when both sides have samples;
7. surface-water fraction (`waterCells / observedCells`).

Only after support quality ties should route cost, crowding, canonical hex-direction order, and stable IDs resolve the choice. Observation footprint itself is not destination quality.

## Bounded route hysteresis

A transit pioneer keeps exactly one previous-region hint. Besides rejecting an exact A→B→A reversal, the planner treats the previous region's immediate axial neighbor ring as the recent route wedge. On a hex lattice this prevents the shortest non-reversal loop, A→B→C→A, because the closing region is adjacent to both the current and immediately previous regions. The comparison uses axial identity, so legacy `garden-*` aliases and canonical `hex-q*-r*` IDs share the same hysteresis geometry.

Settlement migration now also keeps one bounded route anchor on the pioneer itself: `settlementMigrationOriginRegionId`. Preparing a camp kit in an established settlement resets that anchor to the current region; camp-less transit regions preserve it across ownership handoffs. Once the anchor exists, every continuation hop must **strictly increase axial hex distance from the migration origin**. A richer same-ring or inward frontier therefore cannot pull a pioneer into A→…→A circulation, while outward frontiers remain eligible and are still ranked by the normal support score.

This remains O(1) route memory: one immutable origin plus the existing immediate previous-region hint. It does not persist an unbounded visited-region log, does not add deeper synchronous region reads, and does not change Durable Object ownership. The origin is an optional field on the existing persisted `Agent` snapshot, so no schema-version bump or new handoff message is required. Older in-flight pioneers without the marker safely fall back to the previous-region wedge until the next camp-kit preparation establishes a new anchor. If all improving frontiers are non-progressing, the pioneer settles instead of oscillating.

The current halo remains a bounded depth-1 observation. Generalized multi-region routing should build on bounded/persisted region support and congestion summaries rather than expanding synchronous deep reads or reintroducing raw halo-size bias. The monotonic anchor prevents route cycles; summaries are still needed to choose better long-range destinations and to share planning with trade, build, and general logistics.
