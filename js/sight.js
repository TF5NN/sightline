// A first look at which stations can be worked from point A, without loading
// a full profile for each. It runs the app's own radio link estimate on a
// coarse terrain profile from the small terrain layers for Iceland that
// Northbound's terrain check also uses (github.com/TF5NN/terrain): "highest
// ground per cell" grids, a few kilobytes per path. They are loaded only when
// a station layer is showing and point A is placed, or for Look around.
//
// Every cell holds its highest ground, so the coarse profile reads a little
// high and the estimate errs slightly on the careful side. Against the same
// estimate on the full 10 m data it is typically within a decibel or two.

import { STANDARD_K, linkEstimate } from './radio.js';
import { resolveRadio } from './settings.js';
import { settingsWithStation } from './stations.js';

/** Where the terrain layers live. The page address can name another place with ?horizon=, for tests. */
export const LAYERS_URL = 'https://tf5nn.github.io/terrain/v1/';

/** Closer than this, a station is taken to be where the point itself is, in metres. */
export const SAME_SPOT = 300;

/** A margin of this many dB or more is shown as "should work"; from 0 up to it as "marginal". */
export const GOOD_FROM_DB = 10;

const EARTH_RADIUS = 6371008.8;

/** @typedef {'good' | 'marginal' | 'unlikely'} Kind */
/**
 * @typedef {{ distanceMetres: number, bearingDegrees: number, angleDegrees: number, marginDb: number,
 *   terrainLossDb: number, lineOfSight: boolean, kind: Kind }} Estimate
 */

let opened = null;

/**
 * Open the terrain layers (once; later calls reuse them). Rejects when they cannot be reached.
 * @param {string} [baseUrl]
 */
export function openLayers(baseUrl = LAYERS_URL) {
  if (!opened) {
    const attempt = import(`${baseUrl}horizon.js`).then((module) => module.openTerrain(baseUrl));
    attempt.catch(() => {
      if (opened === attempt) opened = null; // try again next time
    });
    opened = attempt;
  }
  return opened;
}

/**
 * What a link margin means for the colour of a station.
 * @param {number} marginDb
 * @returns {Kind}
 */
export function kindFor(marginDb) {
  if (marginDb >= GOOD_FROM_DB) return 'good';
  return marginDb >= 0 ? 'marginal' : 'unlikely';
}

/**
 * The link from point A to a station, estimated on a coarse profile.
 * The radio figures are the ones "Use as B" on that station would give: the
 * station's band, power, antenna and height at B, and at A the station chosen
 * in the app (or the usual one for that band, if the app is on another band).
 *
 * @param {{ distances: ArrayLike<number>, ground: ArrayLike<number>, distanceMetres: number, bearingDegrees: number }} profile
 *   from the terrain layers' profile(): A first, the station last
 * @param {object} station one station from readStations
 * @param {object} settings the app's settings
 * @returns {Estimate}
 */
export function estimateLink(profile, station, settings) {
  const radio = resolveRadio(settingsWithStation(settings, station, 1));
  const link = linkEstimate({ distances: profile.distances, ground: profile.ground, radio });
  const { clearance, tipA, tipB } = link.path;
  let lineOfSight = true;
  for (let i = 1; i < clearance.length - 1; i++) if (clearance[i] < 0) lineOfSight = false;
  const d = profile.distanceMetres;
  const k = radio.k ?? STANDARD_K;
  return {
    distanceMetres: d,
    bearingDegrees: profile.bearingDegrees,
    // How high the station's antenna stands above the level line, seen from A's antenna.
    angleDegrees: (Math.atan2(tipB - tipA - (d * d) / (2 * k * EARTH_RADIUS), d) * 180) / Math.PI,
    marginDb: link.margin,
    terrainLossDb: link.terrainLoss,
    lineOfSight,
    kind: kindFor(link.margin),
  };
}

/** The estimate with the most to spare (several stations can share one site). */
export const bestOf = (estimates) => estimates.reduce((best, e) => (e.marginDb > best.marginDb ? e : best));

const km = (metres) => (metres < 9950 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres / 1000)} km`);

/**
 * Two sentences for a station's card: "Should work from A: about 27 dB to spare over 54 km. No line of sight: …"
 * @param {Estimate} e
 */
export function estimateWords(e) {
  const margin = Math.round(Math.abs(e.marginDb));
  const over = `over ${km(e.distanceMetres)}`;
  const first =
    e.kind === 'good'
      ? `Should work from A: about ${margin} dB to spare ${over}.`
      : e.kind === 'marginal'
        ? `Marginal from A: only about ${margin} dB to spare ${over}.`
        : `Unlikely from A: about ${margin} dB short ${over}.`;
  const loss = Math.round(e.terrainLossDb);
  const second = !e.lineOfSight
    ? `No line of sight: the signal has to bend over the terrain, which costs about ${loss} dB.`
    : loss >= 1
      ? `Line of sight, but the ground comes close to it and costs about ${loss} dB.`
      : 'Clear line of sight.';
  return `${first} ${second}`;
}
