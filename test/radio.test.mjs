import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS_BLOCKED,
  STATUS_CLEAR,
  STATUS_GRAZING,
  analysePath,
  dbmToWatts,
  detailStretches,
  diffractionLoss,
  diffractionParameter,
  earthBulge,
  freeSpaceLoss,
  fresnelRadius,
  knifeEdgeLoss,
  linkEstimate,
  loraSensitivity,
  mergeStretches,
  subtractStretches,
  verdictFor,
  wattsToDbm,
} from '../js/radio.js';

const near = (actual, expected, tolerance, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} expected ${expected} ± ${tolerance}, got ${actual}`);

/** A straight, evenly sampled path over flat ground at a given height. */
function flatPath(total, step, height = 0) {
  const n = Math.round(total / step) + 1;
  const distances = Float64Array.from({ length: n }, (_, i) => (i * total) / (n - 1));
  const ground = new Float32Array(n).fill(height);
  return { distances, ground };
}

test('Fresnel radius: textbook values on a 20 km path', () => {
  near(fresnelRadius(868, 10000, 10000), 41.6, 0.1, '868 MHz mid-path');
  near(fresnelRadius(145, 10000, 10000), 101.7, 0.1, '145 MHz mid-path');
  near(fresnelRadius(433, 1000, 19000), 25.6, 0.1, '433 MHz 1 km from an end');
  assert.equal(fresnelRadius(868, 0, 20000), 0);
});

test('Earth bulge: about 5.9 m in the middle of 20 km, zero at the ends', () => {
  near(earthBulge(10000, 10000), 5.886, 0.01);
  assert.equal(earthBulge(0, 20000), 0);
  near(earthBulge(10000, 10000, 1), 7.848, 0.01, 'without atmospheric bending');
});

test('free-space loss: 868 MHz over 20 km is 117.2 dB', () => {
  near(freeSpaceLoss(868, 20000), 117.2, 0.05);
  near(freeSpaceLoss(145, 20000), 101.7, 0.05);
  near(freeSpaceLoss(868, 40000) - freeSpaceLoss(868, 20000), 6.02, 0.01, 'doubling the distance');
});

test('knife-edge loss: none well below the line, 6 dB when touching it, rising above', () => {
  assert.equal(knifeEdgeLoss(-1), 0);
  assert.equal(knifeEdgeLoss(-0.78), 0);
  near(knifeEdgeLoss(0), 6.03, 0.02);
  near(knifeEdgeLoss(1), 13.9, 0.1);
  near(knifeEdgeLoss(2.4), 20.6, 0.2);
  assert.ok(knifeEdgeLoss(-0.5) > 0 && knifeEdgeLoss(-0.5) < 3);
});

test('diffraction parameter: hand calculation', () => {
  // 868 MHz, ridge 20 m above the line, 5 km and 15 km from the ends.
  // lambda = 0.3454 m; v = 20 * sqrt(2 * 20000 / (0.3454 * 5000 * 15000)) = 0.786
  near(diffractionParameter(868, 20, 5000, 15000), 0.786, 0.002);
  assert.ok(diffractionParameter(868, -20, 5000, 15000) < 0);
});

test('power units convert both ways', () => {
  near(wattsToDbm(1), 30, 1e-9);
  near(wattsToDbm(0.158), 22, 0.02);
  near(wattsToDbm(5), 36.99, 0.01);
  near(dbmToWatts(22), 0.1585, 0.0005);
});

test('LoRa sensitivity matches the datasheet figures', () => {
  near(loraSensitivity(7, 125), -124.5, 0.1);
  near(loraSensitivity(12, 125), -137, 0.1);
  near(loraSensitivity(8, 62.5), -130, 0.1, 'MeshCore EU/UK narrow');
  near(loraSensitivity(11, 250), -131.5, 0.1, 'Meshtastic LongFast');
  near(loraSensitivity(8, 125) - loraSensitivity(7, 125), -2.5, 1e-9, 'one spreading-factor step');
  near(loraSensitivity(8, 62.5) - loraSensitivity(8, 125), -3.01, 0.01, 'halving the bandwidth');
});

test('flat ground, tall masts, short path: clear, and no diffraction loss', () => {
  const { distances, ground } = flatPath(5000, 10);
  const path = analysePath({ distances, ground, heightA: 40, heightB: 40, freqMHz: 868 });
  assert.equal(path.overall, STATUS_CLEAR);
  assert.ok(path.worstRatio > 0.6);
  near(path.los[250], 40, 1e-6);
  const diff = diffractionLoss({ distances, terrain: path.terrain, tipA: path.tipA, tipB: path.tipB, freqMHz: 868 });
  assert.equal(diff.total, 0);
  assert.equal(diff.edges.length, 0);
});

test('flat sea, handhelds 30 km apart: the Earth itself blocks the path', () => {
  const { distances, ground } = flatPath(30000, 30);
  const path = analysePath({ distances, ground, heightA: 2, heightB: 2, freqMHz: 145 });
  assert.equal(path.overall, STATUS_BLOCKED);
  const mid = Math.floor(distances.length / 2);
  near(path.terrain[mid], 13.24, 0.05, 'bulge mid-path');
  assert.equal(path.status[mid], STATUS_BLOCKED);
  // Without the Earth's curvature the same path would only be grazing.
  const flatEarth = analysePath({ distances, ground, heightA: 2, heightB: 2, freqMHz: 145, k: 1e9 });
  assert.equal(flatEarth.overall, STATUS_GRAZING);
});

test('one ridge: found, classed as blocked, and charged the hand-calculated loss', () => {
  const { distances, ground } = flatPath(20000, 10);
  const ridgeAt = 500; // sample index: 5 km from A
  ground[ridgeAt] = 60;
  const radio = { heightA: 30, heightB: 30, freqMHz: 868, k: 1e9 }; // curvature off, to match the hand sum
  const path = analysePath({ distances, ground, ...radio });
  assert.equal(path.status[ridgeAt], STATUS_BLOCKED);
  assert.equal(path.worstIndex, ridgeAt);
  const diff = diffractionLoss({ distances, terrain: path.terrain, tipA: path.tipA, tipB: path.tipB, freqMHz: 868 });
  assert.equal(diff.edges[0].index, ridgeAt);
  // Ridge is 30 m above the line: v = 30 * 0.0393 = 1.179 -> about 15.0 dB.
  near(diff.edges[0].v, 1.179, 0.003);
  near(diff.edges[0].loss, knifeEdgeLoss(1.179), 0.05);
  near(diff.edges[0].loss, 15.0, 0.2);
});

test('a rounded hill is not charged twice for its own shoulders', () => {
  const { distances, ground } = flatPath(20000, 10);
  for (let i = 0; i < distances.length; i++) {
    const x = (distances[i] - 10000) / 150; // a smooth hill about 600 m across
    ground[i] = 80 * Math.exp(-x * x);
  }
  const path = analysePath({ distances, ground, heightA: 20, heightB: 20, freqMHz: 868, k: 1e9 });
  const diff = diffractionLoss({ distances, terrain: path.terrain, tipA: path.tipA, tipB: path.tipB, freqMHz: 868 });
  near(diff.edges[0].distance, 10000, 20);
  for (const edge of diff.edges.slice(1)) {
    assert.ok(Math.abs(edge.distance - 10000) >= 200, `side edge too close to the top: ${edge.distance}`);
  }
  assert.ok(diff.total < diff.edges[0].loss + 14, `total ${diff.total} dB for main edge ${diff.edges[0].loss} dB`);
});

test('three separate ridges: three edges, main one first', () => {
  const { distances, ground } = flatPath(30000, 10);
  ground[500] = 50;
  ground[1500] = 90;
  ground[2500] = 55;
  const path = analysePath({ distances, ground, heightA: 10, heightB: 10, freqMHz: 433, k: 1e9 });
  const diff = diffractionLoss({ distances, terrain: path.terrain, tipA: path.tipA, tipB: path.tipB, freqMHz: 433 });
  assert.deepEqual(diff.edges.map((e) => e.index), [1500, 500, 2500]);
  assert.deepEqual(diff.edges.map((e) => e.role), ['main', 'before', 'after']);
  near(diff.total, diff.edges.reduce((s, e) => s + e.loss, 0), 1e-9);
});

test('link estimate: clear 20 km path adds up by hand', () => {
  const { distances, ground } = flatPath(20000, 20);
  const radio = {
    freqMHz: 868, powerW: 0.1, gainA: 3, gainB: 3, cableA: 1, cableB: 1,
    heightA: 200, heightB: 200, sensitivity: -130, k: 1e9,
  };
  const link = linkEstimate({ distances, ground, radio });
  assert.equal(link.diffraction.total, 0);
  // 20 dBm + 3 + 3 - 1 - 1 - 117.2 = -93.2 dBm; margin 36.8 dB.
  near(link.received, -93.2, 0.05);
  near(link.margin, 36.8, 0.05);
  assert.equal(link.verdict.word, 'Solid');
});

test('verdict bands', () => {
  assert.equal(verdictFor(25).word, 'Solid');
  assert.equal(verdictFor(20).word, 'Solid');
  assert.equal(verdictFor(12).word, 'Good');
  assert.equal(verdictFor(0).word, 'Marginal');
  assert.equal(verdictFor(-0.1).word, 'Unlikely');
});

test('holes in the terrain do not crash the analysis or count as obstacles', () => {
  const { distances, ground } = flatPath(10000, 10);
  for (let i = 300; i < 340; i++) ground[i] = NaN;
  const link = linkEstimate({
    distances, ground,
    radio: { freqMHz: 868, powerW: 0.1, gainA: 0, gainB: 0, cableA: 0, cableB: 0, heightA: 50, heightB: 50, sensitivity: -120 },
  });
  assert.ok(Number.isFinite(link.margin));
  assert.equal(link.path.status[320], STATUS_CLEAR);
});

test('stretch arithmetic: merging and subtracting', () => {
  assert.deepEqual(mergeStretches([[5, 9], [0, 2], [1, 3], [9, 12]]), [[0, 3], [5, 12]]);
  assert.deepEqual(subtractStretches([[0, 100]], [[20, 30], [60, 70]]), [[0, 20], [30, 60], [70, 100]]);
  assert.deepEqual(subtractStretches([[0, 100]], [[0, 100]]), []);
  assert.deepEqual(subtractStretches([[0, 100]], [[0, 98]]), [], 'a 2 m sliver is not worth fetching');
});

test('detail stretches: both ends, the near miss, and nothing over the deep valley', () => {
  const { distances, ground } = flatPath(40000, 10, 0);
  // A ridge at 25 km that just reaches the line of sight between two 300 m hilltops.
  ground[0] = 300;
  ground[distances.length - 1] = 300;
  for (let i = 1; i < distances.length - 1; i++) {
    const x = (distances[i] - 25000) / 400;
    ground[i] = 290 * Math.exp(-x * x);
  }
  const radio = { freqMHz: 868, powerW: 0.1, gainA: 0, gainB: 0, cableA: 0, cableB: 0, heightA: 5, heightB: 5, sensitivity: -130, k: 1e9 };
  const link = linkEstimate({ distances, ground, radio });
  const stretches = detailStretches({ distances, path: link.path, diffraction: link.diffraction });
  assert.deepEqual(stretches[0], [0, 2000]);
  assert.deepEqual(stretches[stretches.length - 1], [38000, 40000]);
  const middle = stretches.filter(([a, b]) => a > 2000 && b < 38000);
  assert.equal(middle.length, 1, JSON.stringify(stretches));
  assert.ok(middle[0][0] < 25000 && middle[0][1] > 25000);
  const covered = stretches.reduce((s, [a, b]) => s + (b - a), 0);
  assert.ok(covered < 8000, `only a small share of the 40 km path should need 2 m data, got ${covered} m`);
});

test('detail stretches: a short path is covered end to end', () => {
  const { distances, ground } = flatPath(3000, 10);
  const link = linkEstimate({
    distances, ground,
    radio: { freqMHz: 868, powerW: 0.1, gainA: 0, gainB: 0, cableA: 0, cableB: 0, heightA: 10, heightB: 10, sensitivity: -130 },
  });
  assert.deepEqual(detailStretches({ distances, path: link.path, diffraction: link.diffraction }), [[0, 3000]]);
});

test('Bullington: clear path costs nothing', async () => {
  const { bullingtonLoss } = await import('../js/radio.js');
  const { distances, ground } = flatPath(5000, 10);
  const path = analysePath({ distances, ground, heightA: 40, heightB: 40, freqMHz: 868 });
  assert.equal(bullingtonLoss({ distances, terrain: path.terrain, tipA: path.tipA, tipB: path.tipB, freqMHz: 868 }).total, 0);
});

test('Bullington: one sharp ridge is its knife-edge loss plus the ITU allowance', async () => {
  const { bullingtonLoss } = await import('../js/radio.js');
  const { distances, ground } = flatPath(20000, 10);
  ground[500] = 60; // 30 m above the line, 5 km from A
  const path = analysePath({ distances, ground, heightA: 30, heightB: 30, freqMHz: 868, k: 1e9 });
  const b = bullingtonLoss({ distances, terrain: path.terrain, tipA: path.tipA, tipB: path.tipB, freqMHz: 868 });
  near(b.distance, 5000, 1);
  near(b.knifeEdge, knifeEdgeLoss(1.179), 0.05);
  near(b.allowance, (1 - Math.exp(-b.knifeEdge / 6)) * (10 + 0.02 * 20), 1e-9);
  near(b.total, 15.0 + 9.55, 0.3);
});

test('real-world check: 143 km at 145.5 MHz over a mountain 635 m above the line', async () => {
  // Gunnar's first field report (16 Nov 2026): a 5 W handheld with a rubber duck opens the
  // repeater but is not readable; a yagi on the same radio gets through. The bare knife edge
  // (24 dB) called this link "good". With the ITU allowance the terrain costs about 37 dB.
  const { distances, ground } = flatPath(142550, 50);
  const peak = Math.round(106120 / 50);
  ground[0] = 650;
  ground[distances.length - 1] = 190;
  const radio = { freqMHz: 145.5, powerW: 5, gainA: 0, gainB: 0, cableA: 0, cableB: 0, heightA: 0, heightB: 0, sensitivity: -119, k: 1e9 };
  const lineAtPeak = 650 + ((190 - 650) * distances[peak]) / 142550;
  ground[peak] = lineAtPeak + 635;
  const link = linkEstimate({ distances, ground, radio });
  near(link.diffraction.total, 24.4, 0.2, 'bare knife edge');
  near(link.bullington.total, 37.0, 0.3, 'with the ITU allowance');
  assert.equal(link.terrainMethod, 'allowance');
  near(link.terrainLoss, link.bullington.total, 1e-9);
  near(link.freeSpaceLoss, 118.8, 0.1);
});

test('separate ridges: charging edge by edge still wins when it is the larger', () => {
  const { distances, ground } = flatPath(30000, 10);
  ground[500] = 50;
  ground[1500] = 90;
  ground[2500] = 55;
  const link = linkEstimate({
    distances, ground,
    radio: { freqMHz: 433, powerW: 1, gainA: 0, gainB: 0, cableA: 0, cableB: 0, heightA: 10, heightB: 10, sensitivity: -119, k: 1e9 },
  });
  assert.ok(link.terrainLoss >= link.diffraction.total && link.terrainLoss >= link.bullington.total);
  near(link.terrainLoss, Math.max(link.diffraction.total, link.bullington.total), 1e-9);
});

test('smart detail leaves wide Fresnel zones alone: a long VHF path only gets its two ends', () => {
  const { distances, ground } = flatPath(140000, 50, 0);
  ground[0] = 650;
  ground[distances.length - 1] = 190;
  // Ground that hugs the line of sight for 30 km in the middle (a near miss the whole way).
  for (let i = 1; i < distances.length - 1; i++) {
    const d = distances[i];
    const line = 650 + ((190 - 650) * d) / 140000;
    if (d > 60000 && d < 90000) ground[i] = line - 100;
  }
  const radio = { freqMHz: 145.5, powerW: 5, gainA: 0, gainB: 0, cableA: 0, cableB: 0, heightA: 2, heightB: 2, sensitivity: -119, k: 1e9 };
  const link = linkEstimate({ distances, ground, radio });
  assert.ok(link.path.fresnel[Math.round(75000 / 50)] > 200, 'the zone is hundreds of metres wide mid-path');
  const stretches = detailStretches({ distances, path: link.path, diffraction: link.diffraction });
  assert.deepEqual(stretches, [[0, 2000], [138000, 140000]]);
  // The same near miss on 868 MHz over a short path does get 2 m data.
  const short = flatPath(20000, 10, 0);
  short.ground[0] = 100;
  short.ground[short.distances.length - 1] = 100;
  for (let i = 1; i < short.distances.length - 1; i++) if (short.distances[i] > 9000 && short.distances[i] < 11000) short.ground[i] = 80;
  const lora = linkEstimate({ ...short, radio: { ...radio, freqMHz: 868 } });
  const loraStretches = detailStretches({ distances: short.distances, path: lora.path, diffraction: lora.diffraction });
  assert.ok(loraStretches.some(([a, b]) => a < 10000 && b > 10000), JSON.stringify(loraStretches));
});

test('two different stations: the link is judged by the weaker direction', () => {
  const { distances, ground } = flatPath(20000, 20);
  const radio = {
    freqMHz: 145.5, gainA: -3, gainB: 6, cableA: 0, cableB: 1.5, heightA: 200, heightB: 200, k: 1e9,
    powerA: 5, sensA: -119, // a handheld
    powerB: 50, sensB: -122, // a repeater that both shouts louder and hears better
  };
  const link = linkEstimate({ distances, ground, radio });
  // Path loss socket to socket: 101.7 + 3 - 6 + 1.5 = 100.2 dB.
  near(link.aToB.received, 36.99 - 100.2, 0.1);
  near(link.aToB.margin, 36.99 - 100.2 + 122, 0.1);
  near(link.bToA.received, 46.99 - 100.2, 0.1);
  near(link.bToA.margin, 46.99 - 100.2 + 119, 0.1);
  assert.equal(link.weaker, 'aToB'); // the handheld getting into the repeater is the hard part
  assert.equal(link.margin, link.aToB.margin);
  assert.equal(link.twoWayDiffers, true);
  // Same station both ends: both directions agree.
  const same = linkEstimate({ distances, ground, radio: { ...radio, powerB: 5, sensB: -119 } });
  assert.equal(same.twoWayDiffers, false);
});
