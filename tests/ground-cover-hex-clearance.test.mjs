import assert from 'node:assert/strict';
import test from 'node:test';
import {
  contactShadowEntries,
  groundCoverBlockedByStructure,
} from '../public/client/ground-cover.js';

const structure = { position: { x: 10, y: 10 } };

test('ground-cover clearance uses the six equal hex neighbors around structures', () => {
  const adjacent = [
    { x: 11, y: 10 },
    { x: 11, y: 9 },
    { x: 10, y: 9 },
    { x: 9, y: 10 },
    { x: 9, y: 11 },
    { x: 10, y: 11 },
  ];

  assert.equal(groundCoverBlockedByStructure(structure.position, [structure]), true);
  for (const tile of adjacent) {
    assert.equal(
      groundCoverBlockedByStructure(tile, [structure]),
      true,
      `expected ${tile.x},${tile.y} to be in the one-hex structure clearance ring`,
    );
  }
});

test('rectangular diagonals two hexes away no longer create asymmetric bare patches', () => {
  for (const tile of [{ x: 11, y: 11 }, { x: 9, y: 9 }]) {
    assert.equal(
      groundCoverBlockedByStructure(tile, [structure]),
      false,
      `expected ${tile.x},${tile.y} to remain two hexes from the structure`,
    );
  }
});

test('contact-shadow budget keeps every structure grounded before sampling natural props', () => {
  const width = 40;
  const height = 24;
  const tiles = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      tiles.push({
        x,
        y,
        terrain: 'forest',
        resource: { kind: 'wood', amount: 1, maxAmount: 1 },
      });
    }
  }
  const structures = Array.from({ length: 6 }, (_, index) => ({
    type: index === 0 ? 'market' : 'camp',
    position: { x: 12 + index, y: 11 },
  }));

  const entries = contactShadowEntries({ width, height, tiles, structures }, 400);
  const structureEntries = entries.filter((entry) => entry.radius >= 0.8);
  const resourceEntries = entries.filter((entry) => entry.radius < 0.8);

  assert.equal(entries.length, 400);
  assert.equal(structureEntries.length, structures.length);
  assert.equal(resourceEntries.length, 400 - structures.length);
  for (const expected of structures) {
    assert.ok(
      structureEntries.some((entry) =>
        entry.position.x === expected.position.x && entry.position.y === expected.position.y
      ),
      `expected contact-shadow budget to retain structure at ${expected.position.x},${expected.position.y}`,
    );
  }
});
