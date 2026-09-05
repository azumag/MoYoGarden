# Quaternius Decay Props Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace selected procedural decay props with lightweight authored Quaternius geometry while preserving the existing procedural fallback.

**Architecture:** A build-time vendor script fetches three CC0 Quaternius glTF meshes from a pinned Git commit, verifies Git blob SHAs, strips external texture dependencies, rewrites materials to MoYoGarden's decayed PBR palette, and emits self-contained GLBs. `ModelLibrary` loads them as optional authored models. `decay-dressing.js` uses the authored geometry when present and rebuilds only its decay layer as the models arrive.

**Tech Stack:** Node.js 22, Three.js r185, glTF 2.0/GLB, Cloudflare Workers build pipeline.

**Spec:** Conversation-approved lightweight shape-only Quaternius integration.

## Global Constraints

- Keep current procedural decay props as runtime fallback.
- Do not vendor Quaternius' multi-megabyte texture set.
- Pin upstream to `agentkaerf/FreeModels@db3df04d1e4714298a09510b26fb6de6645138a2` and verify every downloaded blob SHA.
- Source license is CC0 1.0; preserve attribution/license metadata in NOTICE and manifest.
- Authored model loading remains optional and must not block startup.

---

### Task 1: Shape-only vendor pipeline

**Files:**
- Create: `scripts/vendor-quaternius-decay.mjs`
- Create: `scripts/validate-quaternius-decay.mjs`
- Modify: `package.json`
- Test: `tests/rendering-regression.test.mjs`

**Interfaces:**
- Produces: `public/assets/authored/quaternius-decay/{rubble,support,fence}.glb`, `NOTICE.txt`, `manifest.json`.

- [ ] Add failing source-level tests requiring a pinned Quaternius vendor script, GLB conversion, and build integration.
- [ ] Confirm the tests fail before production code exists.
- [ ] Implement Git-blob validation, texture stripping, PBR material replacement, and GLB packing for `Prop_Brick1`, `Prop_Support`, and `Prop_WoodenFence_Single`.
- [ ] Add a validation script that confirms the emitted GLBs have no external URI dependencies and remain small.
- [ ] Add the vendor and validation steps to `build:web`.

### Task 2: Runtime authored override

**Files:**
- Modify: `public/client/model-library.js`
- Modify: `public/client/decay-dressing.js`
- Test: `tests/rendering-regression.test.mjs`

**Interfaces:**
- Consumes model keys: `authored:decay-rubble`, `authored:decay-support`, `authored:decay-fence`.
- Produces refresh key: `decay`.

- [ ] Add failing tests requiring the three model keys, `decay` refresh routing, and authored-geometry fallback logic.
- [ ] Add the optional models to `MODEL_MANIFEST` and map their load callbacks to `decay`.
- [ ] In `decay-dressing.js`, extract the first mesh geometry/material from loaded authored templates; use it for instancing when available, otherwise retain current procedural geometry/material.
- [ ] Patch `refreshModelType` so a `decay` model load removes/rebuilds only `MoyoDecayDressing` rather than rebuilding the whole terrain/world.
- [ ] Run the full build and confirm GitHub Validate build and Workers Builds succeed.
