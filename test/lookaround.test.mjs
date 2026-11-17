import assert from 'node:assert/strict';
import { test } from 'node:test';

import { facingWords, picture } from '../js/lookaround.js';
import { compass, frame, ground, horizonAngle, line, project } from '../js/panorama.js';

// A made-up skyline: a 10 degree wall to the north, flat elsewhere, one value per 90 degrees.
const wall = { angles: [10, 0, 0, 0], stepDegrees: 90 };

test('the view puts directions where they belong', () => {
  const f = frame(400, 300);
  const north = { yaw: 0, pitch: 0 };
  assert.deepEqual(project(north, f, 0, 0), [200, 150], 'straight ahead is the centre');
  assert.ok(project(north, f, 30, 0)[0] > 200, 'east of north is to the right');
  assert.ok(project(north, f, 0, 30)[1] < 150, 'higher is further up');
  assert.ok(Math.abs(project(north, f, 55, 0)[0] - 400) < 0.01, 'the frame is 110 degrees wide');
  assert.equal(project(north, f, 180, 0), null, 'directly behind is not drawn');
  const all = Array.from({ length: 73 }, (_, i) => ({ az: i * 5, el: 0 }));
  assert.ok((line(north, f, all).match(/M/g) ?? []).length >= 2, 'a line passing behind the viewer is drawn in pieces');
});

test('the skyline is blended between directions and named by compass point', () => {
  assert.equal(horizonAngle(wall, 0), 10);
  assert.equal(horizonAngle(wall, 45), 5);
  assert.equal(horizonAngle(wall, -45), 5);
  assert.equal(compass(20), 'NNE');
  assert.equal(compass(359), 'N');
  const d = ground({ yaw: 0, pitch: 20 }, frame(400, 300), wall);
  assert.ok(d.startsWith('M') && d.endsWith('Z') && !d.includes('NaN'));
});

test('the picture marks stations and point B, and keeps close names apart', () => {
  const marks = [
    { az: 10, el: 1, label: 'TF3RPA', kind: 'good' },
    { az: 12, el: 0.5, label: 'TF1RPE <x>', kind: 'unlikely' },
    { az: 200, el: 0, label: 'BEHIND', kind: 'marginal' },
    { az: 30, el: 0.2, label: 'B', kind: 'b' },
  ];
  const svg = picture({ yaw: 15, pitch: 12 }, wall, marks);
  assert.ok(svg.includes('look-good') && svg.includes('look-unlikely') && svg.includes('look-b'));
  assert.ok(!svg.includes('BEHIND'), 'a station behind the viewer is not drawn');
  assert.ok(svg.includes('TF1RPE &lt;x&gt;'), 'names from the sheet are written as text, not markup');
  const heights = [...svg.matchAll(/<text x="[\d.]+" y="([\d.]+)" text-anchor="middle">TF/g)].map((m) => Number(m[1]));
  assert.equal(heights.length, 2);
  assert.ok(Math.abs(heights[0] - heights[1]) >= 8, 'two names side by side are on different lines');
  assert.equal(facingWords({ yaw: 68.2, pitch: 12 }), 'Looking ENE · 68° · 12° up');
});
