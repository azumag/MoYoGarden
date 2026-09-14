# Settlement migration support scoring

Settlement migration compares neighboring halo observations as **samples of destination quality**, not as a vote by the number of observed cells. A wider seam can expose more halo cells without representing a better region, so raw sample counts must not be used as a destination-quality tie-break.

Current support ordering is intentionally lexicographic:

1. sustainable resource diversity;
2. food / wood / stone carrying-capacity density (`maxAmount / passableCells`), with the same small epsilon used by continuation checks;
3. average pathogen reservoir when both sides have samples;
4. live food / wood / stone density (`amount / passableCells`);
5. average drainage when both sides have samples;
6. surface-water fraction (`waterCells / observedCells`).

Only after support quality ties should route cost, crowding, canonical hex-direction order, and stable IDs resolve the choice. Observation footprint itself is not destination quality.

The current halo remains a bounded depth-1 observation. Generalized multi-region routing should build on bounded/persisted region summaries and route hysteresis rather than expanding synchronous deep reads or reintroducing raw halo-size bias.
