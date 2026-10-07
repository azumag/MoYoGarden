import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WorldRuntime } from "../dist-ts/src/runtime.js";
import { createInitialWorld } from "../dist-ts/src/world.js";
import { inheritHeritableTraits } from "../dist-ts/src/demography.js";
import { auditEvolutionEngine, withProductionIoGuard } from "../tools/evolution-isolation.mjs";
import {
  buildSnapshot, initializeLineage, observeLineage, lineageSummary,
  localOutputDirectory, runEvolutionCanary, stableStringify,
} from "../tools/evolution-canary.mjs";

const hash = (s) => createHash("sha256").update(s).digest("hex");
const cli = new URL("../tools/evolution-canary.mjs", import.meta.url).pathname;
const temporary = () => mkdtempSync(join(tmpdir(), "moyo-evolution-"));

test("canary advances exactly the unchanged WorldRuntime, and sampling is observational", async () => {
  const runtime = new WorldRuntime({ state: createInitialWorld({ seed: 3902, worldId: "evolution-canary", regionId: "evolution-canary" }) });
  let state;
  for (let i = 0; i < 20; i++) state = runtime.tick().state;
  const a = await runEvolutionCanary({ seed: 3902, ticks: 20, sampleEvery: 6 });
  const b = await runEvolutionCanary({ seed: 3902, ticks: 20, sampleEvery: 1,
    collectSnapshots: false, onSnapshot: (snapshot) => { snapshot.population.living = -1; } });
  assert.equal(a.summary.finalStateHash, hash(stableStringify(state)));
  assert.equal(a.summary.finalStateHash, b.summary.finalStateHash);
  assert.deepEqual(a.snapshots.map((s) => s.tick), [0, 6, 12, 18, 20]);
  assert.deepEqual(b.snapshots, []);
  assert.equal(b.summary.snapshotCount, 21);
});

test("rejects malformed integers without truncating the requested experiment", async () => {
  for (const seed of ["1e6", "2.3", "12x", "", true, -1, Infinity, 4294967296]) {
    await assert.rejects(runEvolutionCanary({ seed, ticks: 1 }), /integer/);
  }
  for (const options of [{ ticks: 0 }, { ticks: "10x" }, { sampleEvery: 0 }, { maxRuntimeMs: 0 }]) {
    await assert.rejects(runEvolutionCanary(options), /integer/);
  }
});

test("lineage counts births/deaths between samples without inventing founder lifespans", () => {
  const state = createInitialWorld({ seed: 3901 });
  state.agents = state.agents.slice(0, 2);
  const [a, b] = state.agents;
  const tracker = initializeLineage(state);
  state.tick = 1;
  const child = { ...structuredClone(a), id: "child", birthTick: 1, lifeStage: "infant",
    parents: [a.id, b.id], heritableTraits: inheritHeritableTraits(a, undefined, "child") };
  state.agents.push(child);
  observeLineage(tracker, state);
  assert.equal(tracker.records.get(child.id).generation, 1);
  assert.deepEqual([...tracker.records.get(child.id).ancestry.values()], [0.5, 0.5]);
  state.tick = 4;
  state.agents = [b];
  observeLineage(tracker, state);
  const summary = lineageSummary(tracker);
  assert.equal(summary.births, 1);
  assert.equal(summary.deaths, 2);
  assert.equal(summary.completedLifespan.count, 1);
  assert.equal(summary.completedLifespan.mean, 3);
  assert.equal(summary.unknownBirthDateDeaths, 1);
  assert.equal(summary.topFounderConcentration, 1);
  assert.equal(summary.maxGeneration, 1);
  state.tick = 5;
  state.agents = [];
  observeLineage(tracker, state);
  const empty = buildSnapshot(state, tracker);
  assert.equal(empty.population.extinct, true);
  assert.equal(empty.traits.vitality.mean, null);
  assert.equal(empty.traits.carryingCapacity.p50, null);
  assert.equal(lineageSummary(tracker).topFounderConcentration, null);
  assert.equal(tracker.extinctionTick, 5);
});

test("raw inherited bounds are checked before normalization could conceal an engine regression", () => {
  const state = createInitialWorld({ seed: 3901 });
  const tracker = initializeLineage(state);
  state.tick = 1;
  const child = { ...structuredClone(state.agents[0]), id: "bad-child", birthTick: 1,
    parents: state.agents.slice(0, 2).map((a) => a.id), heritableTraits: { vitality: 1.2, carryingCapacity: 1 } };
  state.agents.push(child);
  assert.throws(() => observeLineage(tracker, state), /out-of-bounds/);
});

test("fractional ancestry is conserved across overlapping grandparents", () => {
  const state = createInitialWorld({ seed: 3901 });
  state.agents = state.agents.slice(0, 4);
  const tracker = initializeLineage(state);
  const newborn = (id, parents, tick) => ({ ...structuredClone(state.agents[0]), id, parents, birthTick: tick,
    heritableTraits: { vitality: 1, carryingCapacity: 1 } });
  state.tick = 1;
  state.agents.push(newborn("ab", state.agents.slice(0, 2).map((a) => a.id), 1));
  state.agents.push(newborn("ac", [state.agents[0].id, state.agents[2].id], 1));
  observeLineage(tracker, state);
  state.tick = 2;
  state.agents.push(newborn("grandchild", ["ab", "ac"], 2));
  observeLineage(tracker, state);
  const record = tracker.records.get("grandchild");
  assert.equal(record.generation, 2);
  assert.equal(record.ancestry.get(state.agents[0].id), 0.5);
  assert.equal([...record.ancestry.values()].reduce((a, b) => a + b, 0), 1);
  assert.ok(Math.abs(lineageSummary(tracker).topFounders.reduce((sum, entry) => sum + entry.livingAncestryShare, 0) - 1) < 1e-10);
});

test("production/entropy guards restore globals on rejection and overlapping calls", async () => {
  const originalFetch = globalThis.fetch;
  const originalRandom = Math.random;
  for (const callback of [() => fetch("https://example.invalid"), () => Math.random(), () => Date.now(), () => crypto.randomUUID()]) {
    await assert.rejects(withProductionIoGuard(callback), /blocked/);
  }
  let release;
  const first = withProductionIoGuard(() => new Promise((resolve) => { release = resolve; }));
  await withProductionIoGuard(() => assert.throws(() => Math.random(), /blocked/));
  assert.throws(() => Math.random(), /blocked/);
  release();
  await first;
  assert.equal(globalThis.fetch, originalFetch);
  assert.equal(Math.random, originalRandom);
});

test("unpatchable capability fails closed and restores earlier patches", () => {
  const module = new URL("../tools/evolution-isolation.mjs", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { withProductionIoGuard } from ${JSON.stringify(module)};
    const original = fetch;
    Object.defineProperty(globalThis, 'REGIONS', { value: {}, configurable: false, writable: false });
    await assert.rejects(withProductionIoGuard(() => {}), /cannot guard REGIONS/);
    assert.equal(fetch, original);
  `], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
});

test("entire engine import graph rejects network/DO/storage dependencies before execution", () => {
  const dir = temporary();
  try {
    cpSync(new URL("../dist-ts/src/", import.meta.url), dir, { recursive: true });
    const file = join(dir, "demography.js");
    const original = readFileSync(file, "utf8");
    const root = pathToFileURL(dir + "/");
    for (const source of [
      'import "node:http";', 'import "cloudflare:workers";', 'import "./worker.js";',
      'import "node:fs";', 'await import("node:net");',
      'fetch("https://example.invalid");', 'REGIONS.get("production");',
      'localStorage.getItem("production");',
    ]) {
      writeFileSync(file, source + "\n" + original);
      assert.throws(() => auditEvolutionEngine(root), /evolution isolation/);
    }
    writeFileSync(file, original);
    assert.equal(auditEvolutionEngine(root).hash, auditEvolutionEngine().hash);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI streams verifiable JSONL, refuses overwrite, and marks a runtime-limited run incomplete", () => {
  const dir = temporary();
  try {
    const output = join(dir, "complete");
    const args = [cli, "--seed", "3901", "--ticks", "3", "--sample-every", "2", "--commit", "fixture", "--output", output];
    const child = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const summary = JSON.parse(readFileSync(join(output, "summary.json"), "utf8"));
    const text = readFileSync(join(output, "snapshots.jsonl"), "utf8");
    assert.deepEqual(text.trim().split("\n").map((line) => JSON.parse(line).tick), [0, 2, 3]);
    assert.equal(summary.snapshotSeriesHash, hash(text));
    const { durationMs, runtimeLimitMs, deterministicResultHash, ...payload } = summary;
    assert.equal(deterministicResultHash, hash(stableStringify(payload)));
    assert.equal(spawnSync(process.execPath, args).status, 1);
    assert.equal(readFileSync(join(output, "snapshots.jsonl"), "utf8"), text);
    const stopped = join(dir, "stopped");
    const partial = spawnSync(process.execPath, [cli, "--ticks", "100000", "--max-runtime-ms", "1", "--output", stopped], { encoding: "utf8" });
    assert.equal(partial.status, 2, partial.stderr);
    const incomplete = JSON.parse(readFileSync(join(stopped, "summary.json"), "utf8"));
    assert.equal(incomplete.run.completed, false);
    assert.equal(incomplete.run.stopReason, "max-runtime-ms");
    assert.ok(incomplete.run.completedTicks < 100000);
    assert.equal(incomplete.snapshotCount, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("output rejects URLs, network paths, reserved storage, and symlinks", () => {
  for (const value of ["https://example.invalid/a", "s3:bucket", "file:/tmp/x", "//host/share", "\\\\host\\share", ".wrangler/state/new"]) {
    assert.throws(() => localOutputDirectory(value, 1, 1));
  }
  const dir = temporary();
  try {
    symlinkSync(dir, join(dir, "link"));
    assert.throws(() => localOutputDirectory(join(dir, "link", "new"), 1, 1), /unsafe/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Validate the structural keywords used by our checked-in artifact schema.
// This is deliberately not a general JSON Schema implementation.
function validateShape(value, schema, root) {
  if (schema.$ref) return validateShape(value, root.$defs[schema.$ref.split("/").at(-1)], root);
  if (Object.hasOwn(schema, "const")) assert.deepEqual(value, schema.const);
  if (schema.enum) assert.ok(schema.enum.some((entry) => entry === value));
  if (schema.type) {
    const matches = (type) => type === "null" ? value === null
      : type === "array" ? Array.isArray(value)
      : type === "integer" ? Number.isSafeInteger(value)
      : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
      : typeof value === type;
    assert.ok([schema.type].flat().some(matches), `type mismatch: ${JSON.stringify(value)}`);
  }
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value));
    if (schema.minimum !== undefined) assert.ok(value >= schema.minimum);
    if (schema.maximum !== undefined) assert.ok(value <= schema.maximum);
  }
  if (schema.pattern) assert.match(value, new RegExp(schema.pattern));
  if (Array.isArray(value)) for (const entry of value) validateShape(entry, schema.items, root);
  if (schema.type === "object") {
    for (const key of schema.required ?? []) assert.ok(Object.hasOwn(value, key), `missing ${key}`);
    for (const [key, entry] of Object.entries(value)) {
      const rule = schema.properties?.[key] ?? schema.additionalProperties;
      assert.notEqual(rule, false, `unexpected ${key}`);
      if (rule && typeof rule === "object") validateShape(entry, rule, root);
    }
  }
}

test("snapshot and summary conform to the versioned artifact schema, including empty cohorts", async () => {
  const schema = JSON.parse(readFileSync(new URL("../tools/evolution-canary.schema.json", import.meta.url), "utf8"));
  const result = await runEvolutionCanary({ ticks: 1 });
  validateShape(result.summary, schema.$defs.summary, schema);
  for (const snapshot of result.snapshots) validateShape(snapshot, schema.$defs.snapshot, schema);
  const state = createInitialWorld({ seed: 3902 });
  state.agents = [];
  validateShape(buildSnapshot(state), schema.$defs.snapshot, schema);
  assert.throws(() => validateShape({ ...result.summary, finalPopulation: -1 }, schema.$defs.summary, schema));
  assert.throws(() => validateShape({ ...result.snapshots[0], fitness: 1 }, schema.$defs.snapshot, schema));
});
