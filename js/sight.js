// A first look at which stations can be seen from a point, without loading a
// full profile for each. It uses the small terrain layers for Iceland that
// Northbound's terrain check also uses (github.com/TF5NN/terrain): "highest
// ground per cell" grids, a few kilobytes per path. They are loaded only when
// a station layer is showing and point A is placed.
//
// Because every cell holds its highest ground, the layers never read lower
// than the real terrain: a line they call clear is clear. A line they call
// blocked by a little may in fact just clear, so that band is "marginal".

/** Where the terrain layers live. The page address can name another place with ?horizon=, for tests. */
export const LAYERS_URL = 'https://tf5nn.github.io/terrain/v1/';

/** The line must be this far below the layers' ground before it is called blocked, in metres. */
export const BLOCKED_BELOW = 40;

/** Closer than this, a station is taken to be where the point itself is, in metres. */
export const SAME_SPOT = 300;

/** @typedef {'clear' | 'marginal' | 'blocked'} Verdict */
/** @typedef {{ distanceMetres: number, clearanceMetres: number, worstAtMetres: number, angleDegrees: number, bearingDegrees: number }} Sight */

let opened = null;

/**
 * Open the terrain layers (once; later calls reuse them). Rejects when they cannot be reached.
 * @param {string} [baseUrl]
 * @returns {Promise<{ sight: (ends: { from: object, to: object }) => Promise<Sight | null> }>}
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
 * What a least clearance means.
 * @param {number} clearanceMetres least height of the line above the layers' ground
 * @returns {Verdict}
 */
export function judge(clearanceMetres) {
  if (clearanceMetres >= 0) return 'clear';
  return clearanceMetres < -BLOCKED_BELOW ? 'blocked' : 'marginal';
}

const km = (metres) => (metres < 9950 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres / 1000)} km`);
const round = (metres) => (metres < 100 ? Math.round(metres) : Math.round(metres / 10) * 10);

/**
 * One sentence for a station's card: "In sight from A, 26 km away. The line clears the terrain by 120 m."
 * @param {Sight} sight
 */
export function sightWords(sight) {
  const verdict = judge(sight.clearanceMetres);
  const away = `${km(sight.distanceMetres)} away`;
  const where = `${km(sight.worstAtMetres)} from A`;
  if (verdict === 'clear') return `In sight from A, ${away}. The line clears the terrain by at least ${round(sight.clearanceMetres)} m.`;
  if (verdict === 'marginal') return `Marginal from A, ${away}. The line is within ${BLOCKED_BELOW} m of the ground ${where}: it may just clear or just touch.`;
  return `Blocked from A, ${away}. The ground is about ${round(-sight.clearanceMetres)} m above the line ${where}.`;
}
