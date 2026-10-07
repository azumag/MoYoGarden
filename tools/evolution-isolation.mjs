import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// A regression boundary for our trusted engine, not a sandbox for hostile code.
// No SDK, Worker, DO, network/storage built-in or third-party module may enter
// this complete, reviewed dependency graph. Check BEFORE evaluating imports.
const MODULES = ["demography", "hex-grid", "prng", "protocol", "runtime", "simulation", "world", "world-scale"];
export function auditEvolutionEngine(root = new URL("../dist-ts/src/", import.meta.url)) {
  const files = [];
  for (const name of MODULES) {
    const source = readFileSync(new URL(`${name}.js`, root), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (/\b(?:import\s*\(|require\s*\(|getBuiltinModule|eval\s*\(|new\s+Function\s*\()/.test(code)) {
      throw new Error(`evolution isolation: dynamic code/import in ${name}`);
    }
    for (const match of code.matchAll(/\b(?:from\s*|import\s*)["']([^"']+)["']/g)) {
      if (!MODULES.some((entry) => match[1] === `./${entry}.js`)) {
        throw new Error(`evolution isolation: forbidden dependency ${match[1]} in ${name}`);
      }
    }
    if (/\b(?:fetch|WebSocket|EventSource|XMLHttpRequest|DurableObject|REGIONS|ASSETS|localStorage|sessionStorage|caches)\b|\bprocess\s*\.|cloudflare:|workers\.dev|moyo\.bluemoon\.works/.test(code)) {
      throw new Error(`evolution isolation: production I/O reference in ${name}`);
    }
    files.push({ name: `${name}.js`, sha256: createHash("sha256").update(source).digest("hex") });
  }
  return { files, hash: createHash("sha256").update(JSON.stringify(files)).digest("hex") };
}

let depth = 0;
let undo = [];
function deny(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  // Fail closed instead of silently leaving an unpatchable capability enabled.
  if (descriptor?.configurable === false && descriptor.writable !== true) {
    throw new Error(`evolution isolation: cannot guard ${key}`);
  }
  const blocked = () => { throw new Error(`evolution canary blocked external I/O via ${key} (including entropy)`); };
  Object.defineProperty(object, key, descriptor?.configurable === false
    ? { value: blocked }
    : { configurable: true, writable: true, value: blocked });
  undo.push(() => descriptor === undefined
    ? delete object[key] : Object.defineProperty(object, key, descriptor));
}
function restore() {
  for (const action of undo.reverse()) action();
  undo = [];
}
export async function withProductionIoGuard(callback) {
  if (depth === 0) {
    try {
      for (const key of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest", "caches", "localStorage", "sessionStorage", "REGIONS", "ASSETS", "DurableObject"]) deny(globalThis, key);
      deny(Math, "random");
      deny(Date, "now");
      if (globalThis.crypto) {
        deny(globalThis.crypto, "randomUUID");
        deny(globalThis.crypto, "getRandomValues");
      }
    } catch (error) {
      restore();
      throw error;
    }
  }
  depth += 1;
  try { return await callback(); }
  finally { if (--depth === 0) restore(); }
}
