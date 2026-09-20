from pathlib import Path

app_path = Path("public/app.js")
app = app_path.read_text()

old_snapshot = '''async function loadSnapshot() {
  const [state, health] = await Promise.all([
    requestJson("/api/world/snapshot"),
    requestOptionalJson("/api/health"),
  ]);
  applyEnvelope({ state, paused: health?.paused, tickMs: health?.tickMs });
}
'''
new_snapshot = '''async function refreshHealth(requestedRegion, requestTransitionVersion) {
  const health = await requestOptionalJson("/api/health");
  if (
    !health
    || requestedRegion !== app.region
    || requestTransitionVersion !== regionTransitionVersion
    || !app.state
  ) return;
  applyEnvelope({ state: app.state, paused: health.paused, tickMs: health.tickMs });
}

async function loadSnapshot() {
  const requestedRegion = app.region;
  const requestTransitionVersion = regionTransitionVersion;
  const state = await requestJson("/api/world/snapshot");
  if (requestedRegion !== app.region || requestTransitionVersion !== regionTransitionVersion) return;
  applyEnvelope({ state, paused: app.paused, tickMs: app.tickMs });
  void refreshHealth(requestedRegion, requestTransitionVersion);
}
'''
if old_snapshot not in app:
    raise SystemExit("loadSnapshot anchor did not match")
app = app.replace(old_snapshot, new_snapshot, 1)

old_transition = '''  try {
    const [windowPayload, health, terrainPayload] = await Promise.all([
      requestJson("/api/world/window?radius=1&live=1", {}, 10_000),
      requestOptionalJson("/api/health"),
      requestOptionalJson(`/api/world/window?radius=${FAR_TERRAIN_RADIUS}&terrain=1`, {}, 12_000),
    ]);
    if (transitionVersion !== regionTransitionVersion || app.region !== targetRegion) return;

    const chunks = Array.isArray(windowPayload?.chunks) ? windowPayload.chunks : [];
    const center = chunks.find((chunk) =>
      chunk?.regionId === targetRegion
      && chunk?.state?.tiles
      && chunk?.state?.agents
      && chunk?.state?.structures
    );
    if (!center) throw new Error(`live window did not include full center ${targetRegion}`);

    app.regions = chunks.map((chunk) => chunk?.regionId).filter(Boolean);
    populateRegions();
    liveNeighborSimulation?.syncWindow(
      windowPayload,
      targetRegion,
      Number(health?.tickMs) || app.tickMs,
    );
    applyEnvelope({ state: center.state, paused: health?.paused, tickMs: health?.tickMs });

    terrainWindowPayload = mergeLiveTerrainWindow(terrainPayload ?? windowPayload, windowPayload);
    terrainWindowCenter = targetRegion;
    neighborTerrainUpdatedAt = terrainPayload ? Date.now() : 0;
    buildNeighborPreview(terrainWindowPayload);
    if (!terrainPayload) void loadTerrainWindow(true);

    startRegionWindowRefresh();
    connectSocket();
'''
new_transition = '''  try {
    const windowPayload = await requestJson("/api/world/window?radius=1&live=1", {}, 10_000);
    if (transitionVersion !== regionTransitionVersion || app.region !== targetRegion) return;

    const chunks = Array.isArray(windowPayload?.chunks) ? windowPayload.chunks : [];
    const center = chunks.find((chunk) =>
      chunk?.regionId === targetRegion
      && chunk?.state?.tiles
      && chunk?.state?.agents
      && chunk?.state?.structures
    );
    if (!center) throw new Error(`live window did not include full center ${targetRegion}`);

    app.regions = chunks.map((chunk) => chunk?.regionId).filter(Boolean);
    populateRegions();
    liveNeighborSimulation?.syncWindow(windowPayload, targetRegion, app.tickMs);
    applyEnvelope({ state: center.state, paused: app.paused, tickMs: app.tickMs });

    terrainWindowPayload = windowPayload;
    terrainWindowCenter = targetRegion;
    neighborTerrainUpdatedAt = 0;
    buildNeighborPreview(terrainWindowPayload);

    startRegionWindowRefresh();
    connectSocket();
    void refreshHealth(targetRegion, transitionVersion);
    void loadTerrainWindow(true);
'''
if old_transition not in app:
    raise SystemExit("transitionRegion anchor did not match")
app = app.replace(old_transition, new_transition, 1)
app_path.write_text(app)

test_path = Path("tests/seamless-region-transition.test.mjs")
tests = test_path.read_text()
old_test = '''test("soft transition requires the live center but treats health and far terrain as best-effort", () => {
  const body = functionBody(appSource, "transitionRegion", "async function loadHighResolutionModels");
  assert.match(body, /requestJson\\("\\/api\\/world\\/window\\?radius=1&live=1", \\{\\}, 10_000\\)/);
  assert.match(body, /requestOptionalJson\\("\\/api\\/health"\\)/);
  assert.match(
    body,
    /requestOptionalJson\\(`\\/api\\/world\\/window\\?radius=\\$\\{FAR_TERRAIN_RADIUS\\}&terrain=1`, \\{\\}, 12_000\\)/,
  );
  assert.match(body, /terrainPayload \\?\\? windowPayload/);
  assert.match(body, /if \\(!terrainPayload\\) void loadTerrainWindow\\(true\\);/);
  assert.match(body, /buildNeighborPreview\\(terrainWindowPayload\\)/);

  const liveWindow = body.indexOf("requestJson(\\\"/api/world/window?radius=1&live=1\\\"");
  const promote = body.indexOf("applyEnvelope");
  assert.ok(liveWindow >= 0 && liveWindow < promote, "live center remains the transition authority");
});

test("snapshot startup keeps the world when health is temporarily unavailable", () => {
  assert.match(appSource, /async function requestOptionalJson/);
  const body = functionBody(appSource, "loadSnapshot", "function startPolling");
  assert.match(body, /requestJson\\("\\/api\\/world\\/snapshot"\\)/);
  assert.match(body, /requestOptionalJson\\("\\/api\\/health"\\)/);
  assert.match(body, /health\\?\\.paused/);
  assert.match(body, /health\\?\\.tickMs/);
});
'''
new_test = '''test("soft transition promotes the live center before optional health and far terrain enrichment", () => {
  const body = functionBody(appSource, "transitionRegion", "async function loadHighResolutionModels");
  assert.match(body, /const windowPayload = await requestJson\\("\\/api\\/world\\/window\\?radius=1&live=1", \\{\\}, 10_000\\);/);
  assert.doesNotMatch(body, /requestOptionalJson/);
  assert.doesNotMatch(body, /Promise\\.all/);
  assert.match(body, /terrainWindowPayload = windowPayload;/);
  assert.match(body, /buildNeighborPreview\\(terrainWindowPayload\\)/);
  assert.match(body, /void refreshHealth\\(targetRegion, transitionVersion\\);/);
  assert.match(body, /void loadTerrainWindow\\(true\\);/);

  const liveWindow = body.indexOf("requestJson(\\\"/api/world/window?radius=1&live=1\\\"");
  const promote = body.indexOf("applyEnvelope");
  const healthRefresh = body.indexOf("void refreshHealth(targetRegion, transitionVersion)");
  const terrainRefresh = body.indexOf("void loadTerrainWindow(true)");
  assert.ok(liveWindow >= 0 && liveWindow < promote, "live center remains the transition authority");
  assert.ok(promote < healthRefresh, "health enrichment must not delay center promotion");
  assert.ok(promote < terrainRefresh, "far terrain enrichment must not delay center promotion");
});

test("snapshot startup promotes state before optional health and rejects stale enrichment", () => {
  assert.match(appSource, /async function requestOptionalJson/);
  const healthBody = functionBody(appSource, "refreshHealth", "async function loadSnapshot");
  assert.match(healthBody, /requestOptionalJson\\("\\/api\\/health"\\)/);
  assert.match(healthBody, /requestedRegion !== app\\.region/);
  assert.match(healthBody, /requestTransitionVersion !== regionTransitionVersion/);

  const body = functionBody(appSource, "loadSnapshot", "function startPolling");
  assert.match(body, /const state = await requestJson\\("\\/api\\/world\\/snapshot"\\);/);
  assert.match(body, /requestedRegion !== app\\.region \\|\\| requestTransitionVersion !== regionTransitionVersion/);
  assert.match(body, /applyEnvelope\\(\\{ state, paused: app\\.paused, tickMs: app\\.tickMs \\}\\);/);
  assert.match(body, /void refreshHealth\\(requestedRegion, requestTransitionVersion\\);/);
  assert.doesNotMatch(body, /Promise\\.all/);

  const promote = body.indexOf("applyEnvelope");
  const healthRefresh = body.indexOf("void refreshHealth(requestedRegion, requestTransitionVersion)");
  assert.ok(promote >= 0 && promote < healthRefresh, "snapshot should render before optional health");
});
'''
if old_test not in tests:
    raise SystemExit("transition tests anchor did not match")
tests = tests.replace(old_test, new_test, 1)
test_path.write_text(tests)
