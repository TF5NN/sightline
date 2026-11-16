import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { geodesicDistance, haversineDistance, initialBearing, pointAlong, samplePath } from '../js/geo.js';
import { toGrid } from '../js/projection.js';
import { supertileAt, quarterAt, tileCandidates } from '../js/tiles.js';
import { seaLevelOffset } from '../js/geoid.js';

const meta = JSON.parse(readFileSync(new URL('./tiles/meta.json', import.meta.url)));

test('distance: one degree of latitude at the equator is 110.574 km', () => {
  const d = geodesicDistance({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
  assert.ok(Math.abs(d - 110574.4) < 1, `got ${d}`);
});

test('distance: Reykjavik to Akureyri is about 249 km', () => {
  const rvk = { lat: 64.1466, lon: -21.9426 };
  const aku = { lat: 65.6835, lon: -18.1105 };
  const d = geodesicDistance(rvk, aku);
  assert.ok(d > 247000 && d < 251000, `got ${d}`);
  // The round-Earth shortcut agrees to within half a percent.
  assert.ok(Math.abs(haversineDistance(rvk, aku) - d) / d < 0.005);
});

test('distance: same point is zero', () => {
  assert.equal(geodesicDistance({ lat: 64, lon: -20 }, { lat: 64, lon: -20 }), 0);
});

test('bearing: due north is 0, due east at the equator is 90', () => {
  assert.ok(Math.abs(initialBearing({ lat: 64, lon: -20 }, { lat: 65, lon: -20 })) < 1e-9);
  assert.ok(Math.abs(initialBearing({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }) - 90) < 1e-9);
});

test('path: ends are exact and the middle is halfway', () => {
  const a = { lat: 64.2, lon: -21.7 };
  const b = { lat: 64.4, lon: -21.2 };
  const pts = samplePath(a, b, 101);
  assert.equal(pts.length, 101);
  assert.ok(Math.abs(pts[0].lat - a.lat) < 1e-9 && Math.abs(pts[100].lon - b.lon) < 1e-9);
  const mid = pointAlong(a, b, 0.5);
  const d1 = haversineDistance(a, mid);
  const d2 = haversineDistance(mid, b);
  assert.ok(Math.abs(d1 - d2) < 0.01, `halves differ by ${d1 - d2}`);
  assert.ok(Math.abs(pts[100].distance - geodesicDistance(a, b)) < 1e-6);
});

test('projection: matches the PROJ reference library to a millimetre', () => {
  for (const c of meta.projection_checks) {
    const g = toGrid(c.lat, c.lon);
    assert.ok(Math.abs(g.x - c.x) < 0.001 && Math.abs(g.y - c.y) < 0.001, `${c.lat},${c.lon}: ${g.x},${g.y} vs ${c.x},${c.y}`);
  }
});

test('tile names: same answer as the independent Python version', () => {
  for (const c of meta.projection_checks) {
    const st = supertileAt(c.x, c.y);
    assert.equal(st.name, c.super);
    const q = quarterAt(c.x, c.y, st);
    assert.equal(`${q.qy}_${q.qx}`, c.sub);
  }
});

test('tile names: file addresses are spelled as expected', () => {
  const c = meta.centre;
  assert.deepEqual(
    tileCandidates('2m', c.x, c.y, 'https://example.test/v4.1').map((t) => t.url),
    [
      'https://example.test/v4.1/2m/14_52/14_52_2_1_2m_v4.1_dem.tif',
      'https://example.test/v4.1/2m/14_52/14_52_1_2_2m_v4.1_dem.tif',
    ],
  );
  assert.equal(
    tileCandidates('10m', c.x, c.y, 'https://example.test/v4.1')[0].url,
    'https://example.test/v4.1/10m/14_52/14_52_10m_v4.1_dem.tif',
  );
});

test('sea level: about 66 m above the ellipsoid near Reykjavik', () => {
  const n = seaLevelOffset(64.24, -21.65);
  assert.ok(n > 64 && n < 69, `got ${n}`);
  assert.equal(seaLevelOffset(45, 10), 0); // south of the table
  assert.ok(Number.isFinite(seaLevelOffset(89.9, 179.9)));
  assert.ok(Math.abs(seaLevelOffset(70, 180) - seaLevelOffset(70, -180)) < 1e-9);
});
