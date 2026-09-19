from pathlib import Path


APP_PATH = Path("public/app.js")
TEST_PATH = Path("tests/seamless-region-transition.test.mjs")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one anchor, found {count}")
    return text.replace(old, new, 1)


app = APP_PATH.read_text()
app = replace_once(
    app,
    "let neighborTerrainUpdatedAt = 0;\nlet readyDispatched = false;\n",
    "let neighborTerrainUpdatedAt = 0;\nlet terrainWindowRequestVersion = 0;\nlet regionTransitionVersion = 0;\nlet readyDispatched = false;\n",
    "request version declarations",
)
app = replace_once(
    app,
    "async function loadTerrainWindow(force = false) {\n  if (!app.state || (!force && terrainWindowCenter === app.region && neighborPreviewRoot)) return;\n  const requestedRegion = app.region;\n  try {\n",
    "async function loadTerrainWindow(force = false) {\n  if (!app.state || (!force && terrainWindowCenter === app.region && neighborPreviewRoot)) return;\n  const requestedRegion = app.region;\n  const requestVersion = ++terrainWindowRequestVersion;\n  try {\n",
    "terrain request version start",
)
app = replace_once(
    app,
    "    if (requestedRegion !== app.region) return;\n    buildNeighborPreview(payload);\n",
    "    if (requestVersion !== terrainWindowRequestVersion || requestedRegion !== app.region) return;\n    buildNeighborPreview(payload);\n",
    "terrain request stale guard",
)
app = replace_once(
    app,
    "async function connect() {\n  clearInterval(app.pollTimer);\n",
    "async function connect() {\n  regionTransitionVersion += 1;\n  terrainWindowRequestVersion += 1;\n  clearInterval(app.pollTimer);\n",
    "connect invalidation",
)
app = replace_once(
    app,
    "async function transitionRegion(regionId) {\n  const targetRegion = typeof regionId === \"string\" ? regionId.trim() : \"\";\n  if (!targetRegion || targetRegion === app.region) return;\n\n  const previousRegion = app.region;\n",
    "async function transitionRegion(regionId) {\n  const targetRegion = typeof regionId === \"string\" ? regionId.trim() : \"\";\n  if (!targetRegion || targetRegion === app.region) return;\n\n  const transitionVersion = ++regionTransitionVersion;\n  terrainWindowRequestVersion += 1;\n  const previousRegion = app.region;\n",
    "transition version start",
)
app = replace_once(
    app,
    "    if (app.region !== targetRegion) return;\n\n    const chunks = Array.isArray(windowPayload?.chunks) ? windowPayload.chunks : [];\n",
    "    if (transitionVersion !== regionTransitionVersion || app.region !== targetRegion) return;\n\n    const chunks = Array.isArray(windowPayload?.chunks) ? windowPayload.chunks : [];\n",
    "transition success stale guard",
)
app = replace_once(
    app,
    "  } catch (error) {\n    if (app.region !== targetRegion) return;\n    app.region = previousRegion;\n",
    "  } catch (error) {\n    if (transitionVersion !== regionTransitionVersion || app.region !== targetRegion) return;\n    app.region = previousRegion;\n",
    "transition failure stale guard",
)
APP_PATH.write_text(app)

tests = TEST_PATH.read_text()
marker = 'test("same-region re-entry ignores stale terrain and transition responses"'
if marker in tests:
    raise SystemExit("regression test already present")
addition = r'''

test("same-region re-entry ignores stale terrain and transition responses", () => {
  assert.match(appSource, /let terrainWindowRequestVersion = 0;/);
  assert.match(appSource, /let regionTransitionVersion = 0;/);

  const terrainBody = functionBody(appSource, "loadTerrainWindow", "function refreshNearTerrainFromLive");
  assert.match(terrainBody, /const requestVersion = \+\+terrainWindowRequestVersion;/);
  assert.match(
    terrainBody,
    /requestVersion !== terrainWindowRequestVersion \|\| requestedRegion !== app\.region/,
  );

  const connectBody = functionBody(appSource, "connect", "async function transitionRegion");
  assert.match(connectBody, /regionTransitionVersion \+= 1;/);
  assert.match(connectBody, /terrainWindowRequestVersion \+= 1;/);

  const transitionBody = functionBody(appSource, "transitionRegion", "async function loadHighResolutionModels");
  assert.match(transitionBody, /const transitionVersion = \+\+regionTransitionVersion;/);
  assert.match(transitionBody, /terrainWindowRequestVersion \+= 1;/);
  const staleGuards = transitionBody.match(
    /transitionVersion !== regionTransitionVersion \|\| app\.region !== targetRegion/g,
  ) || [];
  assert.equal(staleGuards.length, 2, "success and failure paths must both reject stale transitions");
});
'''
TEST_PATH.write_text(tests.rstrip() + addition)
