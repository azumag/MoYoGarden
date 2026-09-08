import assert from "node:assert/strict";
import test from "node:test";

import { haloEnvironmentOrigin } from "../dist-ts/src/halo-region.js";
import { regionGlobalCellOrigin } from "../dist-ts/src/region-topology.js";

test("legacy production aliases use the shared global cell frame for halo climate", () => {
  const physicalOrigins = new Map([
    ["garden-1", { x: 0, y: 0 }],
    ["garden-2", { x: 40, y: 0 }],
    ["garden-3", { x: 80, y: 0 }],
  ]);

  for (const [regionId, physicalOrigin] of physicalOrigins) {
    const globalOrigin = regionGlobalCellOrigin(regionId, 40, 24);
    assert.ok(globalOrigin);
    assert.deepEqual(
      haloEnvironmentOrigin(regionId, 40, 24, physicalOrigin),
      globalOrigin,
      `${regionId} halo climate must follow its stable axial identity`,
    );
  }

  assert.notDeepEqual(regionGlobalCellOrigin("garden-2", 40, 24), physicalOrigins.get("garden-2"));
  assert.notDeepEqual(regionGlobalCellOrigin("garden-3", 40, 24), physicalOrigins.get("garden-3"));
});

test("unknown legacy regions retain the physical compatibility fallback", () => {
  const physicalOrigin = { x: 120, y: 0 };
  assert.equal(regionGlobalCellOrigin("garden-historical", 40, 24), undefined);
  assert.deepEqual(
    haloEnvironmentOrigin("garden-historical", 40, 24, physicalOrigin),
    physicalOrigin,
  );
});
