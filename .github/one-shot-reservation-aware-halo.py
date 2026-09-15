from pathlib import Path

source = Path("src/autonomy-region.ts")
text = source.read_text()

old = '''  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith(INTERNAL_AUTONOMY_PREFIX)) {
      return ["GET", "HEAD", "OPTIONS"].includes(request.method)
        ? this.fetchAutonomyRequest(request)
        : this.withHaloEdgeMutation(() => this.fetchAutonomyRequest(request));
    }
    return super.fetch(request);
  }
'''
new = '''  private async fetchReservationAwareHaloEdge(request: Request): Promise<Response> {
    const response = await super.fetch(request);
    if (!response.ok || request.method !== "GET") return response;

    let payload: unknown;
    try {
      payload = await response.clone().json();
    } catch {
      return response;
    }
    if (!isRecord(payload) || !isRecord(payload.regionSummary)) return response;
    const summary = payload.regionSummary;
    if (!isRecord(summary.storageHeadroomByFaction)) return response;

    const reservations = await this.activeDestinationStorageReservations();
    if (reservations.length === 0) return response;
    const reservedByFaction = new Map<string, number>();
    for (const reservation of reservations) {
      reservedByFaction.set(
        reservation.factionId,
        (reservedByFaction.get(reservation.factionId) ?? 0) + reservation.amount,
      );
    }
    const storageHeadroomByFaction = { ...summary.storageHeadroomByFaction };
    for (const [factionId, reserved] of reservedByFaction) {
      const observed = storageHeadroomByFaction[factionId];
      if (typeof observed !== "number" || !Number.isFinite(observed) || observed < 0) continue;
      storageHeadroomByFaction[factionId] = Math.max(0, observed - reserved);
    }

    return new Response(JSON.stringify({
      ...payload,
      regionSummary: {
        ...summary,
        storageHeadroomByFaction,
      },
    }), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith(INTERNAL_AUTONOMY_PREFIX)) {
      return ["GET", "HEAD", "OPTIONS"].includes(request.method)
        ? this.fetchAutonomyRequest(request)
        : this.withHaloEdgeMutation(() => this.fetchAutonomyRequest(request));
    }
    if (request.method === "GET" && url.pathname === INTERNAL_EDGE_PATH) {
      return this.fetchReservationAwareHaloEdge(request);
    }
    return super.fetch(request);
  }
'''
assert old in text, "fetch override anchor not found"
text = text.replace(old, new, 1)
source.write_text(text)

test_path = Path("tests/autonomous-concurrent-travel-do.test.mjs")
tests = test_path.read_text()
old = '''  assert.equal((await reserve("source-c", "garden-1", 1)).grantedAmount, 0);
  assert.equal(
    (await reserve("source-a", "garden-1", 2)).grantedAmount,
    sourceA.grantedAmount,
    "retry must be idempotent",
  );

  const release = await destination.object.fetch(new Request(
'''
new = '''  assert.equal((await reserve("source-c", "garden-1", 1)).grantedAmount, 0);
  assert.equal(
    (await reserve("source-a", "garden-1", 2)).grantedAmount,
    sourceA.grantedAmount,
    "retry must be idempotent",
  );

  const edgeResponse = await destination.object.fetch(new Request(
    "https://moyo.internal/api/internal/halo/edge?direction=west",
    {
      method: "GET",
      headers: { "x-moyo-region-internal": "garden-2" },
    },
  ));
  assert.equal(edgeResponse.status, 200);
  const edge = await edgeResponse.json();
  assert.equal(
    edge.regionSummary.storageHeadroomByFaction[factionId],
    0,
    "halo summary must advertise headroom after active destination reservations",
  );

  const release = await destination.object.fetch(new Request(
'''
assert old in tests, "destination reservation test anchor not found"
tests = tests.replace(old, new, 1)
test_path.write_text(tests)
