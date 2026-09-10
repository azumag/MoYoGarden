import assert from 'node:assert/strict';
import test from 'node:test';
import { groundCoverBlockedByStructure } from '../public/client/ground-cover.js';

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
