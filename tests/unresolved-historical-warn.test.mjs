import assert from "node:assert/strict";
import test, { mock } from "node:test";
import {
  warnUnresolvedHistoricalRegionIds,
  regionHexWindow,
} from "../dist-ts/src/region-topology.js";
import { configuredDefaultRegionId } from "../dist-ts/src/worker-entry.js";
import {
  buildConfiguredHexHaloLinks,
  buildHexHaloLinks,
} from "../dist-ts/src/hex-halo.js";
import { isAutonomyClaimSourceRegionId } from "../dist-ts/src/autonomy-region.js";

const EXTENT = { width: 40, height: 24 };

function captureWarns(run) {
  const warn = mock.method(console, "warn", () => {});
  try {
    const result = run();
    return { result, calls: warn.mock.calls };
  } finally {
    warn.mock.restore();
  }
}

function assertUnresolvedWarn(calls, contextFragment, unresolvedRegionIds) {
  assert.ok(calls.length >= 1, "expected at least one console.warn call");
  const [message, meta] = calls[0].arguments;
  assert.match(String(message), /unresolved historical region id compatibility path/);
  assert.match(String(message), contextFragment);
  assert.deepEqual(meta?.unresolvedRegionIds, unresolvedRegionIds);
}

test("warnUnresolvedHistoricalRegionIds warns only for ids with no axial identity", () => {
  const { result, calls } = captureWarns(() =>
    warnUnresolvedHistoricalRegionIds("ctx", [
      "garden-1",
      "hex-q9-r9",
      "old-west",
      "legacy-42",
    ]),
  );
  assert.deepEqual(result, ["old-west", "legacy-42"]);
  assert.equal(calls.length, 1);
  assertUnresolvedWarn(calls, /ctx/, ["old-west", "legacy-42"]);
});

test("warnUnresolvedHistoricalRegionIds is silent for canonical and persisted legacy ids", () => {
  const { result, calls } = captureWarns(() =>
    warnUnresolvedHistoricalRegionIds("ctx", ["garden-1", "garden-2", "garden-3", "hex-q0-r0", "hex-q-2-r5"]),
  );
  assert.deepEqual(result, []);
  assert.equal(calls.length, 0);
});

test("configuredDefaultRegionId warns when resolving an unresolved historical default", () => {
  const { result, calls } = captureWarns(() =>
    configuredDefaultRegionId({ DEFAULT_REGION_ID: "old-west", REGION_IDS: "old-west,garden-1" }),
  );
  assert.equal(result, "old-west");
  assertUnresolvedWarn(calls, /configuredDefaultRegionId\(default=old-west\)/, ["old-west"]);
});

test("configuredDefaultRegionId warns when falling back to REGION_IDS[0] and it is unresolved", () => {
  const { result, calls } = captureWarns(() =>
    configuredDefaultRegionId({ REGION_IDS: "old-west,garden-1" }),
  );
  assert.equal(result, "old-west");
  assertUnresolvedWarn(calls, /configuredDefaultRegionId\(default=REGION_IDS\[0\]\)/, ["old-west"]);
});

test("configuredDefaultRegionId stays silent for persisted legacy and canonical defaults", () => {
  const legacy = captureWarns(() => configuredDefaultRegionId({ DEFAULT_REGION_ID: "garden-2", REGION_IDS: "garden-1,garden-2" }));
  assert.equal(legacy.result, "garden-2");
  assert.equal(legacy.calls.length, 0);

  const canonical = captureWarns(() => configuredDefaultRegionId({ DEFAULT_REGION_ID: "hex-q7-r-3" }));
  assert.equal(canonical.result, "hex-q7-r-3");
  assert.equal(canonical.calls.length, 0);
});

test("buildHexHaloLinks warns for the unresolved historical source path without changing link shape", () => {
  const { result, calls } = captureWarns(() =>
    buildHexHaloLinks(EXTENT, ["old-a", "old-b"], "old-a"),
  );
  assert.ok(Array.isArray(result));
  const matching = calls.filter((call) =>
    /buildHexHaloLinks\(source=old-a\) side-pair halo/.test(String(call.arguments[0])),
  );
  assert.equal(matching.length, 1);
  assert.deepEqual(matching[0].arguments[1]?.unresolvedRegionIds, ["old-a"]);
});

test("buildConfiguredHexHaloLinks warns when historical fallback neighbors remain unresolved", () => {
  const source = `hist-src-${Date.now()}`;
  const { result, calls } = captureWarns(() =>
    buildConfiguredHexHaloLinks(EXTENT, [source, "hist-neighbor"], source),
  );
  assert.ok(Array.isArray(result));
  const matching = calls.filter((call) => /unresolved historical region id/.test(String(call.arguments[0])));
  assert.ok(matching.length >= 1, "expected unresolved historical warn from configured halo fallback");
  const warnedIds = matching.flatMap((call) => call.arguments[1]?.unresolvedRegionIds ?? []);
  assert.ok(warnedIds.includes(source) || warnedIds.includes("hist-neighbor"));
});

test("isAutonomyClaimSourceRegionId warns when an unresolved historical source is accepted via allow-list", () => {
  const { result, calls } = captureWarns(() =>
    isAutonomyClaimSourceRegionId(["old-claim-src", "garden-1"], "old-claim-src"),
  );
  assert.equal(result, true);
  assertUnresolvedWarn(calls, /isAutonomyClaimSourceRegionId\(source=old-claim-src\)/, ["old-claim-src"]);
});

test("isAutonomyClaimSourceRegionId stays silent for axial ids and rejects unknown ids without axial identity or allow-list", () => {
  const axial = captureWarns(() => isAutonomyClaimSourceRegionId(["garden-1"], "hex-q3-r4"));
  assert.equal(axial.result, true);
  assert.equal(axial.calls.length, 0);

  const rejected = captureWarns(() => isAutonomyClaimSourceRegionId(["garden-1"], "old-unknown"));
  assert.equal(rejected.result, false);
  assert.equal(rejected.calls.length, 0);
});

test("regionHexWindow warns on full-topology fallback when unresolved historical ids are present", () => {
  const { result, calls } = captureWarns(() =>
    regionHexWindow(["old-west", "old-east"], "old-west", 1, EXTENT.width, EXTENT.height),
  );
  assert.ok(Array.isArray(result));
  assert.ok(result.some((entry) => entry.id === "old-west"));
  assertUnresolvedWarn(calls, /regionHexWindow\(center=old-west\) full-topology fallback/, ["old-west", "old-east"]);
});
