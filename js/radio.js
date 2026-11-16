// The radio maths: Earth curvature, the Fresnel zone, how much terrain gets
// in the way, and the link budget.
//
// Pure functions. Nothing in here knows about maps, files or the page: it is
// handed distances, heights and settings, and hands back numbers. That keeps
// every formula checkable against a hand calculation (see test/radio.test.mjs).
//
// Units throughout: metres, MHz, dB, dBm, watts.

import { MEAN_EARTH_RADIUS } from './geo.js';

const SPEED_OF_LIGHT = 299_792_458; // metres per second

/** Radio waves bend slightly towards the ground, as if the Earth were 4/3 its real size. */
export const STANDARD_K = 4 / 3;

/** Terrain closer to the line of sight than this share of the Fresnel radius starts to cost signal. */
export const CLEARANCE_RULE = 0.6;

/**
 * 2 m data is only worth fetching where the Fresnel zone is narrower than this
 * many metres. Finer data sharpens heights by a few metres at most, which only
 * matters when the zone itself is small.
 */
export const DETAIL_FRESNEL_LIMIT = 75;

export const STATUS_CLEAR = 0;
export const STATUS_GRAZING = 1; // terrain inside 60% of the Fresnel zone
export const STATUS_BLOCKED = 2; // terrain above the line of sight

export function wavelength(freqMHz) {
  return SPEED_OF_LIGHT / (freqMHz * 1e6);
}

/** Radius of the first Fresnel zone at a point d1 from one end and d2 from the other. */
export function fresnelRadius(freqMHz, d1, d2) {
  const total = d1 + d2;
  if (total <= 0 || d1 <= 0 || d2 <= 0) return 0;
  return Math.sqrt((wavelength(freqMHz) * d1 * d2) / total);
}

/** How far the curved Earth rises into a straight path, d1 from one end and d2 from the other. */
export function earthBulge(d1, d2, k = STANDARD_K) {
  return (d1 * d2) / (2 * k * MEAN_EARTH_RADIUS);
}

/** Loss with nothing in the way, in dB. */
export function freeSpaceLoss(freqMHz, distance) {
  if (distance <= 0) return 0;
  return 32.45 + 20 * Math.log10(freqMHz) + 20 * Math.log10(distance / 1000);
}

/**
 * The "v" number that knife-edge diffraction is worked out from.
 * h is how far the obstacle's top is above the line of sight (negative = below).
 */
export function diffractionParameter(freqMHz, h, d1, d2) {
  if (d1 <= 0 || d2 <= 0) return -Infinity;
  return h * Math.sqrt((2 * (d1 + d2)) / (wavelength(freqMHz) * d1 * d2));
}

/**
 * Loss over a single sharp ridge, in dB (the standard ITU-R P.526 approximation).
 * Zero when the ridge is well below the line of sight; 6 dB when it just touches it.
 */
export function knifeEdgeLoss(v) {
  if (!(v > -0.78)) return 0;
  return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
}

export const wattsToDbm = (watts) => 10 * Math.log10(watts * 1000);
export const dbmToWatts = (dbm) => 10 ** (dbm / 10) / 1000;

// Signal-to-noise ratio a LoRa receiver needs at each spreading factor, in dB
// (from the Semtech SX126x datasheet).
const LORA_REQUIRED_SNR = { 5: -2.5, 6: -5, 7: -7.5, 8: -10, 9: -12.5, 10: -15, 11: -17.5, 12: -20 };

/**
 * The weakest signal a LoRa receiver can decode, in dBm.
 * Thermal noise in the bandwidth, plus the receiver's own noise, plus the
 * signal-to-noise ratio the spreading factor needs.
 */
export function loraSensitivity(spreadingFactor, bandwidthKHz, noiseFigure = 6) {
  const snr = LORA_REQUIRED_SNR[spreadingFactor];
  if (snr === undefined) throw new Error(`Unsupported spreading factor: ${spreadingFactor}`);
  return -174 + 10 * Math.log10(bandwidthKHz * 1000) + noiseFigure + snr;
}

/**
 * Compare a terrain profile with the radio path above it.
 *
 * distances: metres from A for each sample (rising; need not be evenly spaced)
 * ground:    real ground height at each sample (NaN where there is no data)
 * Returns, for each sample:
 *   terrain   - ground with the Earth's bulge added (what the radio path "sees")
 *   los       - height of the straight line between the antenna tips
 *   fresnel   - radius of the first Fresnel zone
 *   clearance - los minus terrain (negative = blocked)
 *   status    - clear, grazing or blocked
 */
export function analysePath({ distances, ground, heightA, heightB, freqMHz, k = STANDARD_K }) {
  const n = distances.length;
  const total = distances[n - 1];
  const terrain = new Float64Array(n);
  const los = new Float64Array(n);
  const fresnel = new Float64Array(n);
  const clearance = new Float64Array(n);
  const status = new Uint8Array(n);

  const tipA = ground[0] + heightA;
  const tipB = ground[n - 1] + heightB;

  let worstRatio = Infinity; // smallest clearance as a share of the Fresnel radius
  let worstIndex = -1;
  const counts = [0, 0, 0];

  for (let i = 0; i < n; i++) {
    const d1 = distances[i];
    const d2 = total - d1;
    terrain[i] = ground[i] + earthBulge(d1, d2, k);
    los[i] = tipA + ((tipB - tipA) * d1) / total;
    fresnel[i] = fresnelRadius(freqMHz, d1, d2);
    clearance[i] = los[i] - terrain[i];
    if (Number.isNaN(ground[i]) || i === 0 || i === n - 1) {
      status[i] = STATUS_CLEAR; // the ends are the antennas themselves; holes can't be judged
      continue;
    }
    if (clearance[i] < 0) status[i] = STATUS_BLOCKED;
    else if (clearance[i] < CLEARANCE_RULE * fresnel[i]) status[i] = STATUS_GRAZING;
    else status[i] = STATUS_CLEAR;
    counts[status[i]] += 1;
    const ratio = fresnel[i] > 0 ? clearance[i] / fresnel[i] : Infinity;
    if (ratio < worstRatio) {
      worstRatio = ratio;
      worstIndex = i;
    }
  }

  const overall = counts[STATUS_BLOCKED] > 0 ? STATUS_BLOCKED : counts[STATUS_GRAZING] > 0 ? STATUS_GRAZING : STATUS_CLEAR;
  return { total, tipA, tipB, terrain, los, fresnel, clearance, status, overall, worstRatio, worstIndex };
}

/**
 * The sample that obstructs a straight line the most, between two samples.
 * The line runs from height hFrom at index `from` to height hTo at index `to`.
 * Samples inside the two "keep out" stretches next to the ends are skipped.
 */
function worstEdge(distances, terrain, freqMHz, from, to, hFrom, hTo, guard) {
  const dFrom = distances[from];
  const span = distances[to] - dFrom;
  let best = null;
  for (let i = from + 1; i < to; i++) {
    const d1 = distances[i] - dFrom;
    const d2 = span - d1;
    if (d1 < guard || d2 < guard || Number.isNaN(terrain[i])) continue;
    const line = hFrom + ((hTo - hFrom) * d1) / span;
    const v = diffractionParameter(freqMHz, terrain[i] - line, d1, d2);
    if (!best || v > best.v) best = { index: i, v };
  }
  if (!best) return null;
  return { ...best, loss: knifeEdgeLoss(best.v), distance: distances[best.index], height: terrain[best.index] };
}

/**
 * Diffraction loss over the terrain, by the Deygout method limited to three
 * edges: the worst obstacle on the whole path, then the worst one on each
 * side of it, each treated as a sharp ridge.
 *
 * A real hill is rounder than a knife edge, and its shoulders sit right next
 * to its top. Counting those shoulders as extra ridges would charge for the
 * same hill twice, so side edges must be at least `guard` metres from the
 * main one (by default 1% of the path, and never less than 100 m).
 *
 * Returns the edges that cost signal, most important first, and the total.
 *
 * @param {{ distances: ArrayLike<number>, terrain: ArrayLike<number>, tipA: number, tipB: number, freqMHz: number, guard?: number }} options
 */
export function diffractionLoss({ distances, terrain, tipA, tipB, freqMHz, guard }) {
  const last = distances.length - 1;
  const total = distances[last];
  const keepOut = guard ?? Math.max(100, total * 0.01);

  const main = worstEdge(distances, terrain, freqMHz, 0, last, tipA, tipB, 0);
  if (!main || main.loss <= 0) return { total: 0, edges: [] };

  const edges = [{ ...main, role: 'main' }];
  const before = worstEdge(distances, terrain, freqMHz, 0, main.index, tipA, main.height, keepOut);
  if (before && before.loss > 0) edges.push({ ...before, role: 'before' });
  const after = worstEdge(distances, terrain, freqMHz, main.index, last, main.height, tipB, keepOut);
  if (after && after.loss > 0) edges.push({ ...after, role: 'after' });

  return { total: edges.reduce((sum, e) => sum + e.loss, 0), edges };
}

/**
 * Terrain loss by the Bullington method of ITU-R P.526: the whole profile is
 * replaced by one equivalent ridge, standing where the horizon rays from the
 * two antennas cross. The recommendation then adds an allowance, because real
 * hills are broad and rough and cost more than a perfect knife edge would:
 *
 *     loss = knifeEdge + (1 - exp(-knifeEdge / 6)) * (10 + 0.02 * distance in km)
 *
 * `terrain` must already include the Earth's bulge (as analysePath returns it).
 *
 * @param {{ distances: ArrayLike<number>, terrain: ArrayLike<number>, tipA: number, tipB: number, freqMHz: number }} options
 */
export function bullingtonLoss({ distances, terrain, tipA, tipB, freqMHz }) {
  const last = distances.length - 1;
  const total = distances[last];
  const none = { knifeEdge: 0, allowance: 0, total: 0, distance: null };
  if (!(total > 0) || last < 2) return none;

  // Steepest ray from A that still touches the ground somewhere.
  let slopeA = -Infinity;
  for (let i = 1; i < last; i++) {
    if (Number.isNaN(terrain[i])) continue;
    slopeA = Math.max(slopeA, (terrain[i] - tipA) / distances[i]);
  }
  if (slopeA === -Infinity) return none;
  const slopeDirect = (tipB - tipA) / total;

  let v;
  let where;
  if (slopeA < slopeDirect) {
    // B is visible from A: take the point that intrudes most into the path.
    v = -Infinity;
    for (let i = 1; i < last; i++) {
      if (Number.isNaN(terrain[i])) continue;
      const d1 = distances[i];
      const line = tipA + slopeDirect * d1;
      const vi = diffractionParameter(freqMHz, terrain[i] - line, d1, total - d1);
      if (vi > v) {
        v = vi;
        where = d1;
      }
    }
  } else {
    // B is hidden: find the ray from B the same way, and the point where the two rays cross.
    let slopeB = -Infinity;
    for (let i = 1; i < last; i++) {
      if (Number.isNaN(terrain[i])) continue;
      slopeB = Math.max(slopeB, (terrain[i] - tipB) / (total - distances[i]));
    }
    where = (tipB - tipA + slopeB * total) / (slopeA + slopeB);
    const height = tipA + slopeA * where;
    const line = tipA + slopeDirect * where;
    v = diffractionParameter(freqMHz, height - line, where, total - where);
  }

  const knifeEdge = knifeEdgeLoss(v);
  if (knifeEdge <= 0) return none;
  const allowance = (1 - Math.exp(-knifeEdge / 6)) * (10 + 0.02 * (total / 1000));
  return { knifeEdge, allowance, total: knifeEdge + allowance, distance: where };
}

export const VERDICTS = [
  { min: 20, word: 'Solid', key: 'solid' },
  { min: 10, word: 'Good', key: 'good' },
  { min: 0, word: 'Marginal', key: 'marginal' },
  { min: -Infinity, word: 'Unlikely', key: 'unlikely' },
];

/** The plain word for a link margin in dB. */
export function verdictFor(marginDb) {
  return VERDICTS.find((v) => marginDb >= v.min);
}

/**
 * The whole link estimate for one hop.
 *
 * radio = {
 *   freqMHz, gainA, gainB (dBi), cableA, cableB (dB),
 *   heightA, heightB (antenna height above ground, m), k,
 *   powerA, powerB (W) and sensA, sensB (dBm) for the two ends,
 *   or just powerW and sensitivity when both ends are the same
 * }
 */
export function linkEstimate({ distances, ground, radio }) {
  const path = analysePath({
    distances,
    ground,
    heightA: radio.heightA,
    heightB: radio.heightB,
    freqMHz: radio.freqMHz,
    k: radio.k ?? STANDARD_K,
  });
  const diffraction = diffractionLoss({
    distances,
    terrain: path.terrain,
    tipA: path.tipA,
    tipB: path.tipB,
    freqMHz: radio.freqMHz,
  });
  const bullington = bullingtonLoss({
    distances,
    terrain: path.terrain,
    tipA: path.tipA,
    tipB: path.tipB,
    freqMHz: radio.freqMHz,
  });
  // Two ways of charging for terrain. Separate ridges are charged best one by
  // one (the edges above); one broad mountain is charged best by the single
  // equivalent ridge plus the ITU allowance. Neither should be undercut, so
  // the larger of the two is used.
  const terrainLoss = Math.max(diffraction.total, bullington.total);
  const fsl = freeSpaceLoss(radio.freqMHz, path.total);

  // Everything between the two radios' sockets: the same in both directions.
  const pathLoss = fsl + terrainLoss - radio.gainA - radio.gainB + radio.cableA + radio.cableB;
  // A two-way contact needs both directions to work, and the two ends may have
  // different transmit power and different receivers. Work out each direction
  // and judge the link by the weaker one.
  const powerA = radio.powerA ?? radio.powerW;
  const powerB = radio.powerB ?? radio.powerW;
  const sensA = radio.sensA ?? radio.sensitivity;
  const sensB = radio.sensB ?? radio.sensitivity;
  const direction = (powerW, sensitivity) => {
    const received = wattsToDbm(powerW) - pathLoss;
    return { received, margin: received - sensitivity };
  };
  const aToB = direction(powerA, sensB);
  const bToA = direction(powerB, sensA);
  // An end with no transmitter (a broadcast receiver) makes the link one-way:
  // only the direction that exists is judged.
  const oneWay = powerA > 0 && !(powerB > 0) ? 'aToB' : powerB > 0 && !(powerA > 0) ? 'bToA' : null;
  const weaker = oneWay ?? (bToA.margin < aToB.margin ? 'bToA' : 'aToB');
  const { received, margin } = weaker === 'bToA' ? bToA : aToB;
  return {
    path,
    diffraction,
    bullington,
    terrainLoss,
    terrainMethod: terrainLoss === 0 ? 'none' : bullington.total > diffraction.total ? 'allowance' : 'edges',
    freeSpaceLoss: fsl,
    aToB,
    bToA,
    weaker,
    oneWay,
    twoWayDiffers: !oneWay && Math.abs(aToB.margin - bToA.margin) > 0.05,
    received,
    margin,
    verdict: verdictFor(margin),
  };
}

/**
 * Where along the path the 2 m data is worth fetching, as a list of
 * [from, to] stretches in metres:
 *   - the first and last `endLength` metres (the Fresnel zone is narrow there,
 *     so small features decide whether the antenna clears them),
 *   - anywhere the terrain is within one Fresnel radius of the line of sight,
 *     above or below it (a near miss either way),
 *   - around each diffraction edge.
 * Stretches buried deep under the line of sight are left alone: finer data
 * there would not change the answer. So are stretches where the Fresnel zone
 * is wide (long paths on low frequencies): a few metres of extra precision
 * means nothing against a zone hundreds of metres across.
 */
export function detailStretches({ distances, path, diffraction, endLength = 2000, pad = 200, fresnelLimit = DETAIL_FRESNEL_LIMIT }) {
  const total = path.total;
  const raw = [];
  const ends = Math.min(endLength, total / 2);
  raw.push([0, ends], [total - ends, total]);

  let start = null;
  for (let i = 0; i < distances.length; i++) {
    const r = path.fresnel[i];
    const near = r > 0 && r <= fresnelLimit && Math.abs(path.clearance[i]) < r;
    if (near && start === null) start = distances[i];
    if (!near && start !== null) {
      raw.push([start - pad, distances[i - 1] + pad]);
      start = null;
    }
  }
  if (start !== null) raw.push([start - pad, total]);

  for (const edge of diffraction.edges) {
    if (path.fresnel[edge.index] <= fresnelLimit) raw.push([edge.distance - 1.5 * pad, edge.distance + 1.5 * pad]);
  }

  return mergeStretches(raw.map(([a, b]) => [Math.max(0, a), Math.min(total, b)]));
}

/** Sort stretches and join the ones that touch or overlap. */
export function mergeStretches(stretches) {
  const sorted = stretches.filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  const merged = [];
  for (const [a, b] of sorted) {
    const lastOne = merged[merged.length - 1];
    if (lastOne && a <= lastOne[1]) lastOne[1] = Math.max(lastOne[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

/** The parts of `wanted` that are not already covered by `have`. */
export function subtractStretches(wanted, have) {
  const result = [];
  for (const [a, b] of mergeStretches(wanted)) {
    let cursor = a;
    for (const [ha, hb] of mergeStretches(have)) {
      if (hb <= cursor || ha >= b) continue;
      if (ha > cursor) result.push([cursor, ha]);
      cursor = Math.max(cursor, hb);
    }
    if (cursor < b) result.push([cursor, b]);
  }
  // Slivers shorter than a few metres are not worth a download.
  return result.filter(([a, b]) => b - a > 4);
}
