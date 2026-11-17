import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BLOCKED_BELOW, judge, sightWords } from '../js/sight.js';

test('a clearance is judged clear, marginal or blocked', () => {
  assert.equal(judge(120), 'clear');
  assert.equal(judge(0), 'clear');
  assert.equal(judge(-0.1), 'marginal');
  assert.equal(judge(-BLOCKED_BELOW), 'marginal');
  assert.equal(judge(-BLOCKED_BELOW - 1), 'blocked');
});

test('what was found is put in one plain sentence', () => {
  const sight = { distanceMetres: 26040, worstAtMetres: 900, clearanceMetres: 123, angleDegrees: 1.4, bearingDegrees: 172 };
  assert.equal(sightWords(sight), 'In sight from A, 26 km away. The line clears the terrain by at least 120 m.');
  assert.equal(
    sightWords({ ...sight, clearanceMetres: -12 }),
    'Marginal from A, 26 km away. The line is within 40 m of the ground 0.9 km from A: it may just clear or just touch.',
  );
  assert.equal(sightWords({ ...sight, distanceMetres: 4300, clearanceMetres: -857, worstAtMetres: 2100 }), 'Blocked from A, 4.3 km away. The ground is about 860 m above the line 2.1 km from A.');
});
