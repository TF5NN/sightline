import assert from 'node:assert/strict';
import { test } from 'node:test';

import { seaLevelOffset } from '../js/geoid.js';
import { ownDraft } from '../js/owndraft.js';
import { toGrid } from '../js/projection.js';

const a = { lat: 64.208, lon: -21.712 };
const b = { lat: 64.129, lon: -21.9187 };
// Stand-in terrain layers: a box around south-west Iceland, ground 100 m above sea level, with a hole.
function fakeLayers({ hasDetail = true, hole = -1 } = {}) {
  const g = toGrid(a.lat, a.lon);
  const stats = { requests: 0 };
  return {
    hasDetail,
    stats,
    manifest: { x0: g.x - 60000, y0: g.y - 60000, widthMetres: 120000, heightMetres: 120000, layers: { detail: { cellMetres: 10 } } },
    detail: async (xs) => {
      stats.requests += 3;
      return Float32Array.from(xs, (_, i) => (i === hole ? NaN : 100));
    },
  };
}

test('the draft from the terrain layers is shaped like one from ArcticDEM', async () => {
  const draft = await ownDraft({ layers: fakeLayers(), a, b, maxSamples: 4000 });
  assert.equal(draft.layerId, '10m');
  assert.equal(draft.heights.length, draft.points.length);
  assert.ok(Math.abs(draft.spacing - 10) < 0.5 && Math.abs(draft.total - 13370) < 30, `${draft.spacing} m apart over ${draft.total} m`);
  assert.equal(draft.coverage, 1);
  assert.equal(draft.blocks, 3);
  // The layers give heights above sea level; the draft holds them above the ellipsoid, like ArcticDEM's files.
  const mid = Math.floor(draft.points.length / 2);
  assert.ok(Math.abs(draft.heights[mid] - (100 + seaLevelOffset(draft.points[mid].lat, draft.points[mid].lon))) < 1e-3);
  assert.ok(draft.heights[mid] > 150, 'sea level is some 65 m above the ellipsoid in Iceland');
});

test('a hole in the layers is a hole in the draft, never sea level', async () => {
  const draft = await ownDraft({ layers: fakeLayers({ hole: 7 }), a, b, maxSamples: 4000 });
  assert.ok(Number.isNaN(draft.heights[7]));
  assert.equal(draft.source[7], 0);
  assert.ok(draft.coverage < 1 && draft.coverage > 0.99);
});

test('no draft when the layers cannot give it', async () => {
  assert.equal(await ownDraft({ layers: fakeLayers({ hasDetail: false }), a, b, maxSamples: 4000 }), null);
  assert.equal(await ownDraft({ layers: null, a, b, maxSamples: 4000 }), null);
  // A path that leaves the layers (here: on to London) is read from ArcticDEM instead.
  assert.equal(await ownDraft({ layers: fakeLayers(), a, b: { lat: 51.5, lon: -0.12 }, maxSamples: 4000 }), null);
});
