import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// Regression for #81: PR #71 added calls to startPopulationTimeseriesRefresh()
// in connect() / transitionRegion() but never defined the function, so every
// page load threw ReferenceError before connectSocket() and the live
// connection never established (Validate build does not execute public/app.js).
// This static check pins that every refresh starter called from the connect
// paths is actually defined in public/app.js.
const appJsPath = new URL("../public/app.js", import.meta.url).pathname;
const source = readFileSync(appJsPath, "utf8");

const definitions = new Set(
  [...source.matchAll(/function\s+(start[A-Za-z]+Refresh)\s*\(/g)].map((m) => m[1]),
);

test("population timeseries refresh starter is defined (#81)", () => {
  assert.ok(
    definitions.has("startPopulationTimeseriesRefresh"),
    "startPopulationTimeseriesRefresh must be defined in public/app.js",
  );
  assert.ok(
    source.includes('document.querySelector("#observation-population-series")'),
    "the refresh must update #observation-population-series",
  );
  assert.ok(
    source.includes("/api/population/timeseries"),
    "the refresh must fetch /api/population/timeseries",
  );
});

test("every refresh starter called from connect paths is defined", () => {
  const calls = new Set(
    [...source.matchAll(/(?<![\w$.])start[A-Za-z]+Refresh\(\)/g)].map((m) => m[0].slice(0, -2)),
  );
  assert.ok(calls.size > 0, "expected at least one refresh starter call");
  for (const name of calls) {
    assert.ok(definitions.has(name), `${name} is called but never defined`);
  }
});
