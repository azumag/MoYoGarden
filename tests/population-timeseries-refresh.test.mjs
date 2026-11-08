import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Regression guard for MoYoGarden#81: connect()/transitionRegion() called
// startPopulationTimeseriesRefresh() before it existed, which threw
// ReferenceError and prevented the live socket from ever connecting.
// These checks statically verify that every refresh starter invoked from
// app.js is actually defined in the same module.
const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const indexSource = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

test("every startXxxRefresh() invoked in app.js is defined in app.js", () => {
  const invoked = new Set();
  for (const match of appSource.matchAll(/\b(start[A-Za-z]+Refresh)\s*\(/g)) {
    invoked.add(match[1]);
  }
  assert.ok(invoked.size > 0, "expected at least one refresh starter call");
  for (const name of invoked) {
    assert.match(
      appSource,
      new RegExp(`function ${name}\\s*\\(`),
      `${name}() is invoked but never defined`,
    );
  }
});

test("population timeseries refresh polls the API and updates the panel element", () => {
  const start = appSource.indexOf("function startPopulationTimeseriesRefresh");
  assert.ok(start >= 0, "startPopulationTimeseriesRefresh is defined");
  const end = appSource.indexOf("\nfunction ", start + 1);
  const body = appSource.slice(start, end > start ? end : undefined);
  assert.match(body, /setInterval/);
  assert.match(body, /loadPopulationTimeseries/);
  // interval must be driven by a named millisecond constant of 60 s
  assert.match(appSource, /POPULATION_\w*REFRESH_MS = 60_000/);

  const loadStart = appSource.indexOf("async function loadPopulationTimeseries");
  assert.ok(loadStart >= 0, "loadPopulationTimeseries is defined");
  const loadEnd = appSource.indexOf("\nfunction ", loadStart + 1);
  const loadBody = appSource.slice(loadStart, loadEnd > loadStart ? loadEnd : undefined);
  assert.match(loadBody, /\/api\/population\/timeseries\?limit=/);
  assert.match(loadBody, /observation-population-series|populationSeries/);
  // fail-open: errors must be caught, never propagated into connect()
  assert.match(loadBody, /catch/);
});

test("population series element exists and is wired from app.js", () => {
  assert.match(indexSource, /id="observation-population-series"/);
  assert.match(
    appSource,
    /(\$\(|querySelector\()"#observation-population-series"\)/,
    "app.js must resolve the #observation-population-series element",
  );
});
