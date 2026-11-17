import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { defaultSettings, settingsForBand } from '../js/settings.js';
import { GOOD_FROM_DB, bestOf, estimateLink, estimateWords, kindFor } from '../js/sight.js';
import { readStations, settingsWithStation } from '../js/stations.js';

const { stations } = readStations(readFileSync(new URL('../data/stations.csv', import.meta.url), 'utf8'));
const blafjoll = stations.find((s) => s.callsign === 'TF3RPB');
const dstar = stations.find((s) => s.callsign === 'TF3RPI');
// Made-up coarse profiles, 31 km long, both ends on 500 m hills: open ground between, or a wall.
const open = { distances: [0, 15500, 31000], ground: [500, 0, 500], distanceMetres: 31000, bearingDegrees: 200 };
const wall = { ...open, ground: [500, 6000, 500] };
const ridge = { ...open, ground: [500, 800, 500] };

test('a margin is sorted into should work, marginal or unlikely', () => {
  assert.equal(kindFor(GOOD_FROM_DB), 'good');
  assert.equal(kindFor(GOOD_FROM_DB - 0.1), 'marginal');
  assert.equal(kindFor(0), 'marginal');
  assert.equal(kindFor(-0.1), 'unlikely');
});

test('putting an end on a station leaves the settings it was given alone', () => {
  const settings = defaultSettings();
  const before = JSON.stringify(settings);
  const s = settingsWithStation(settings, blafjoll, 1);
  assert.equal(JSON.stringify(settings), before);
  assert.equal(s.split, true);
  assert.equal(s.b.radio, 'repeater');
  assert.equal(s.b.height, blafjoll.heightM);
  assert.equal(s.a.radio, settings.a.radio, 'point A keeps its own station');
  // From another band, the link is worked out on the station's band.
  assert.equal(settingsWithStation(settingsForBand('lora868'), blafjoll, 1).band, '2m');
});

test('the link to a station is estimated on the coarse profile', () => {
  const settings = defaultSettings();
  const clear = estimateLink(open, blafjoll, settings);
  assert.equal(clear.kind, 'good');
  assert.equal(clear.lineOfSight, true);
  assert.ok(clear.terrainLossDb < 1 && clear.marginDb > 20, JSON.stringify(clear));
  assert.equal(clear.distanceMetres, 31000);
  assert.ok(Math.abs(clear.angleDegrees) < 0.2, 'two equal hills 31 km apart: the far one is a touch below level');

  const bent = estimateLink(ridge, blafjoll, settings);
  assert.equal(bent.lineOfSight, false);
  assert.ok(bent.terrainLossDb > 10 && bent.marginDb < clear.marginDb);

  const blocked = estimateLink(wall, blafjoll, settings);
  assert.equal(blocked.kind, 'unlikely');
  // 70 cm loses more than 2 m over the same ridge; the site is judged by its best station.
  const uhf = estimateLink(ridge, dstar, settings);
  assert.ok(uhf.marginDb < bent.marginDb);
  assert.equal(bestOf([uhf, bent]), bent);
});

test('what was found is put in plain sentences', () => {
  const e = { distanceMetres: 53990, bearingDegrees: 172, angleDegrees: 0.7, marginDb: 26.7, terrainLossDb: 21.9, lineOfSight: false, kind: 'good' };
  assert.equal(estimateWords(e), 'Should work from A: about 27 dB to spare over 54 km. No line of sight: the signal has to bend over the terrain, which costs about 22 dB.');
  assert.equal(
    estimateWords({ ...e, marginDb: 4.2, terrainLossDb: 3.1, lineOfSight: true, kind: 'marginal' }),
    'Marginal from A: only about 4 dB to spare over 54 km. Line of sight, but the ground comes close to it and costs about 3 dB.',
  );
  assert.equal(estimateWords({ ...e, distanceMetres: 4300, marginDb: -18.4, kind: 'unlikely' }), 'Unlikely from A: about 18 dB short over 4.3 km. No line of sight: the signal has to bend over the terrain, which costs about 22 dB.');
  assert.equal(estimateWords({ ...e, terrainLossDb: 0, lineOfSight: true }), 'Should work from A: about 27 dB to spare over 54 km. Clear line of sight.');
});
