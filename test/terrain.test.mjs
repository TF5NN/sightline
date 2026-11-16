import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as GeoTIFF from 'geotiff';
import { createTerrain } from '../js/terrain.js';
import { buildProfile, fillGaps, heightAt, heightRange, planSamples, SOURCE_FILLED, SOURCE_NONE, SOURCE_OWN } from '../js/profile.js';
import { toGrid } from '../js/projection.js';
import { startServer } from './serve.mjs';

const tilesDir = fileURLToPath(new URL('./tiles/', import.meta.url));
const meta = JSON.parse(readFileSync(new URL('./tiles/meta.json', import.meta.url)));
const { x: xc, y: yc } = meta.centre;

// The same made-up surface the Python tool wrote into the test tiles.
const truth = (x, y) =>
  300 + 0.01 * (x - xc) + 0.02 * (y - yc) + 40 * Math.sin((x - xc) / 300) + 25 * Math.cos((y - yc) / 450);

let server;
before(async () => {
  server = await startServer(tilesDir);
});
after(async () => {
  await server.close();
});

const near = (actual, expected, tolerance) => assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);
const newTerrain = (options = {}) => createTerrain({ GeoTIFF, baseUrl: server.url, ...options });

test('2 m layer: heights match the true surface to a centimetre', async () => {
  const terrain = newTerrain();
  const pts = [];
  for (let i = 0; i < 400; i++) pts.push({ x: xc - 900 + i * 3.7, y: yc + 700 - i * 2.9 });
  const clear = pts.filter((p) => Math.hypot(p.x - meta.hole.x, p.y - meta.hole.y) > meta.hole.r + 4);
  const { heights, coverage } = await terrain.sample('2m', clear);
  assert.equal(coverage, 1);
  let worst = 0;
  clear.forEach((p, i) => (worst = Math.max(worst, Math.abs(heights[i] - truth(p.x, p.y)))));
  assert.ok(worst < 0.01, `worst error ${worst} m`);
});

test('10 m and 32 m layers: close to the true surface', async () => {
  const terrain = newTerrain();
  const pts = [];
  for (let i = 0; i < 200; i++) pts.push({ x: xc - 1500 + i * 15, y: yc - 1200 + i * 11 });
  for (const [layer, limit] of [['10m', 0.05], ['32m', 0.5]]) {
    const { heights, coverage } = await terrain.sample(layer, pts);
    assert.equal(coverage, 1, layer);
    let worst = 0;
    pts.forEach((p, i) => (worst = Math.max(worst, Math.abs(heights[i] - truth(p.x, p.y)))));
    assert.ok(worst < limit, `${layer}: worst error ${worst} m`);
  }
});

test('a hole in the data comes back as "no data", never as a height', async () => {
  const terrain = newTerrain();
  const { heights } = await terrain.sample('2m', [
    { x: meta.hole.x, y: meta.hole.y },
    { x: meta.hole.x + 300, y: meta.hole.y },
  ]);
  assert.ok(Number.isNaN(heights[0]));
  assert.ok(Math.abs(heights[1] - truth(meta.hole.x + 300, meta.hole.y)) < 0.01);
});

test('places with no file come back as "no data" and are counted as missing', async () => {
  const terrain = newTerrain();
  const sea = toGrid(62.0, -30.0); // open ocean: no tile
  const outside = { x: xc + 20000, y: yc }; // same quarter as the test tile, but beyond its edge
  const res = await terrain.sample('2m', [sea, outside]);
  assert.ok(Number.isNaN(res.heights[0]) && Number.isNaN(res.heights[1]));
  assert.equal(res.coverage, 0);
  assert.equal(res.problems.missing, 2);
  assert.equal(res.problems.blocked, 0);
});

test('an unreachable server is reported as blocked, not as missing data', async () => {
  const terrain = createTerrain({ GeoTIFF, baseUrl: 'http://127.0.0.1:9' });
  const res = await terrain.sample('10m', [{ x: xc, y: yc }]);
  assert.ok(Number.isNaN(res.heights[0]));
  assert.equal(res.problems.blocked, 1);
});

test('only the blocks under the path are downloaded, and they are reused', async () => {
  const terrain = newTerrain();
  const pts = [];
  for (let i = 0; i < 100; i++) pts.push({ x: xc - 100 + i * 2, y: yc });
  const before = server.log.reduce((n, r) => n + (r.bytes ?? 0), 0);
  const first = await terrain.sample('2m', pts);
  const used = server.log.reduce((n, r) => n + (r.bytes ?? 0), 0) - before;
  assert.ok(first.blocks <= 2, `a 200 m line should touch 1 or 2 blocks, touched ${first.blocks}`);
  assert.ok(used < 700_000, `downloaded ${used} bytes of a 1.3 MB file`);
  const requests = server.log.length;
  await terrain.sample('2m', pts);
  assert.equal(server.log.length, requests, 'second read should need no new downloads');
});

test('estimate: says how much a path would cost before loading it', async () => {
  const terrain = newTerrain();
  const pts = [];
  for (let i = 0; i < 500; i++) pts.push({ x: xc - 900 + i * 3.6, y: yc + 600 - i * 2.4 });
  const est = await terrain.estimate('2m', pts);
  assert.ok(est.blocks >= 4 && est.blocksToFetch === est.blocks);
  assert.ok(est.bytesToFetch > 50_000, `bytes ${est.bytesToFetch}`);
  await terrain.sample('2m', pts);
  const again = await terrain.estimate('2m', pts);
  assert.equal(again.blocksToFetch, 0);
  assert.equal(again.bytesToFetch, 0);
});

test('profile: draft from 10 m, detail from 2 m, holes filled and marked', async () => {
  const terrain = newTerrain();
  // A path about 1.25 km long that runs straight through the hole in the 2 m tile.
  const { a, b } = meta.hole_path;
  const draft = await buildProfile({ terrain, a, b, layerId: '10m' });
  const detail = await buildProfile({ terrain, a, b, layerId: '2m' });
  assert.ok(Math.abs(draft.total - detail.total) < 1e-6);
  assert.ok(detail.heights.length > draft.heights.length * 4);
  assert.ok(Math.abs(detail.spacing - 2) < 0.01, `spacing ${detail.spacing}`);
  assert.equal(draft.coverage, 1);

  const holes = detail.source.filter((s) => s === SOURCE_NONE).length;
  assert.ok(holes > 10, `the path should cross the hole (found ${holes} empty samples)`);
  const filled = fillGaps(detail, draft);
  assert.equal(filled, holes);
  assert.equal(detail.source.filter((s) => s === SOURCE_NONE).length, 0);
  assert.equal(detail.source.filter((s) => s === SOURCE_FILLED).length, holes);
  assert.ok(detail.source.includes(SOURCE_OWN));

  // Every height, filled or not, is close to the true surface.
  let worst = 0;
  detail.points.forEach((p, i) => {
    const g = toGrid(p.lat, p.lon);
    worst = Math.max(worst, Math.abs(detail.heights[i] - truth(g.x, g.y)));
  });
  assert.ok(worst < 0.1, `worst error ${worst} m`);

  const range = heightRange(detail.heights);
  assert.ok(range.max > range.min);
  assert.ok(Math.abs(heightAt(draft, 0) - draft.heights[0]) < 1e-6);
});

test('sample planning: long paths are capped, short paths still get two points', () => {
  assert.deepEqual(planSamples(1000, '2m', 20000), { count: 501, spacing: 2 });
  const long = planSamples(100000, '2m', 20000);
  assert.equal(long.count, 20000);
  assert.ok(long.spacing > 5 && long.spacing < 5.01);
  assert.equal(planSamples(0.5, '10m', 20000).count, 2);
});

test('mixed profile: 2 m on chosen stretches, 10 m elsewhere, in order, holes filled', async () => {
  const { composeTrack, sampleStretch, detailSpacing, FROM_10M, FROM_2M, FROM_FILL } = await import('../js/profile.js');
  const terrain = newTerrain();
  const { a, b } = meta.hole_path;
  const draft = await buildProfile({ terrain, a, b, layerId: '10m' });
  const total = draft.total;
  // Detail on the first 300 m and on a stretch through the hole.
  const wanted = [[0, 300], [500, 800]];
  const spacing = detailSpacing(wanted, draft.heights.length, 20000);
  assert.equal(spacing, 2);
  const stretches = [];
  for (const [from, to] of wanted) stretches.push(await sampleStretch({ terrain, a, b, total, from, to, spacing }));
  const track = composeTrack(draft, stretches);

  for (let i = 1; i < track.distance.length; i++) assert.ok(track.distance[i] > track.distance[i - 1], 'distances must rise');
  assert.equal(track.distance[0], 0);
  near(track.distance[track.distance.length - 1], total, 1e-6);
  const count = (code) => track.source.filter((s) => s === code).length;
  assert.ok(count(FROM_2M) > 200, `2 m samples: ${count(FROM_2M)}`);
  assert.ok(count(FROM_10M) > 50, `10 m samples: ${count(FROM_10M)}`);
  assert.ok(count(FROM_FILL) > 10, `filled samples: ${count(FROM_FILL)}`);
  // Inside a detailed stretch every sample is 2 m (or a filled hole); outside, 10 m.
  for (let i = 0; i < track.distance.length; i++) {
    const d = track.distance[i];
    const inDetail = wanted.some(([from, to]) => d >= from && d <= to);
    if (inDetail) assert.ok(track.source[i] === FROM_2M || track.source[i] === FROM_FILL, `sample at ${d} m`);
    else assert.equal(track.source[i], FROM_10M, `sample at ${d} m`);
  }
  // And every height is still the true surface.
  let worst = 0;
  for (let i = 0; i < track.distance.length; i++) {
    const g = toGrid(track.lat[i], track.lon[i]);
    worst = Math.max(worst, Math.abs(track.height[i] - truth(g.x, g.y)));
  }
  assert.ok(worst < 0.1, `worst error ${worst} m`);
});

test('mixed profile: sample spacing widens to respect the sample limit', async () => {
  const { detailSpacing } = await import('../js/profile.js');
  assert.equal(detailSpacing([[0, 2000], [38000, 40000]], 4000, 20000), 2);
  const wide = detailSpacing([[0, 119000]], 4000, 20000);
  assert.ok(wide > 7.4 && wide < 7.5, `spacing ${wide}`);
});
