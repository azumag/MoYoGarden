# Settlement migration support scoring

Settlement migration compares neighboring halo observations as **samples of destination quality**, not as a vote by the number of observed cells. A wider seam can expose more halo cells without representing a better region, so raw sample counts must not be used as a destination-quality tie-break.

Current support ordering is intentionally lexicographic:

1. sustainable resource diversity;
2. food / wood / stone carrying-capacity density (`maxAmount / passableCells`), with a small epsilon so floating-point normalization noise does not dominate later signals;
3. average pathogen reservoir when both sides have samples;
4. live food / wood / stone density (`amount / passableCells`), using the same small-noise rule so negligible live-supply differences do not mask meaningful environmental differences;
5. average drainage when both sides have samples;
6. surface-water fraction (`waterCells / observedCells`).

Only after support quality ties should route cost, crowding, canonical hex-direction order, and stable IDs resolve the choice. Observation footprint itself is not destination quality.

## Bounded route hysteresis

A transit pioneer keeps exactly one previous-region hint. Besides rejecting an exact A→B→A reversal, the planner treats the previous region's immediate axial neighbor ring as the recent route wedge. On a hex lattice this prevents the shortest non-reversal loop, A→B→C→A, because the closing region is adjacent to both the current and immediately previous regions. The comparison uses axial identity, so legacy `garden-*` aliases and canonical `hex-q*-r*` IDs share the same hysteresis geometry.

This deliberately remains bounded and fail-closed: no visited-region log is persisted, no deeper synchronous region reads are added, and if every improving frontier would close the recent triangle the pioneer settles instead. Longer cycles still require bounded/persisted region summaries plus multi-hop route hysteresis or monotonic progress; this local rule is only the safe first layer.

The current halo remains a bounded depth-1 observation. Generalized multi-region routing should build on bounded/persisted region summaries and route hysteresis rather than expanding synchronous deep reads or reintroducing raw halo-size bias.
