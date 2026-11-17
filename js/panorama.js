// The look-around view: the skyline as seen from a point, turned towards `yaw`
// (true bearing) and tilted up by `pitch`, both in degrees. A stereographic
// projection keeps shapes natural well away from the centre, so a wide view
// does not look stretched. Pure maths and SVG path text; the same as
// Northbound's src/lib/panorama.ts.

/** @typedef {{ yaw: number, pitch: number }} Camera */
/** @typedef {{ width: number, height: number, scale: number }} Frame */
/** @typedef {{ angles: ArrayLike<number>, stepDegrees: number }} Horizon */

const RAD = Math.PI / 180;
// Directions further than about 154 degrees from the view centre are far off screen and dropped.
const BEHIND = -0.9;

/**
 * A frame whose width shows `fieldDegrees` of the surroundings.
 * @returns {Frame}
 */
export const frame = (width, height, fieldDegrees = 110) => ({ width, height, scale: width / 2 / (2 * Math.tan((fieldDegrees / 4) * RAD)) });

/**
 * Where a direction lands in the frame, or null when it is behind the viewer.
 * @param {Camera} camera
 * @param {Frame} f
 * @param {number} az true bearing, degrees
 * @param {number} el degrees above the level line
 * @returns {[number, number] | null}
 */
export function project(camera, f, az, el) {
  const d = (az - camera.yaw) * RAD;
  const e = el * RAD;
  const p = camera.pitch * RAD;
  const x = Math.cos(e) * Math.sin(d);
  const up = Math.sin(e);
  const ahead = Math.cos(e) * Math.cos(d);
  const y = up * Math.cos(p) - ahead * Math.sin(p);
  const z = up * Math.sin(p) + ahead * Math.cos(p);
  if (z < BEHIND) return null;
  const k = (2 * f.scale) / (1 + z);
  return [f.width / 2 + x * k, f.height / 2 - y * k];
}

const pt = (p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;

/**
 * SVG path through a list of directions, lifted wherever a point is behind the viewer.
 * @param {Camera} camera
 * @param {Frame} f
 * @param {{ az: number, el: number }[]} points
 */
export function line(camera, f, points) {
  let d = '';
  let pen = false;
  for (const p of points) {
    const at = project(camera, f, p.az, p.el);
    if (at) d += `${pen ? 'L' : 'M'}${pt(at)}`;
    pen = !!at;
  }
  return d;
}

/**
 * The skyline's angle on any bearing, blended between the two nearest directions.
 * @param {Horizon} h
 * @param {number} bearing
 */
export function horizonAngle(h, bearing) {
  const n = h.angles.length;
  const f = (((bearing % 360) + 360) % 360) / h.stepDegrees;
  const i = Math.floor(f) % n;
  const t = f - Math.floor(f);
  return h.angles[i] * (1 - t) + h.angles[(i + 1) % n] * t;
}

/**
 * SVG path of the ground: everything below the skyline, all the way round.
 * Built from small four-cornered pieces, so that a piece partly behind the
 * viewer can simply be left out: such pieces are always far off screen. One
 * fine row follows the skyline; coarser rows fill in below it, overlapping
 * slightly so no gap shows.
 * @param {Camera} camera
 * @param {Frame} f
 * @param {Horizon} horizon
 */
export function ground(camera, f, horizon) {
  let d = '';
  const piece = (az, width, top, bottom) => {
    const corners = [project(camera, f, az, top(az)), project(camera, f, az + width, top(az + width)), project(camera, f, az + width, bottom), project(camera, f, az, bottom)];
    if (corners.every(Boolean)) d += `M${corners.map(pt).join('L')}Z`;
  };
  const skyline = (az) => Math.max(-8, horizonAngle(horizon, az));
  for (let step = -180; step < 180; step++) piece(camera.yaw + step, 1, skyline, -10);
  for (const [top, bottom] of [
    [-9, -25],
    [-24, -45],
    [-44, -70],
  ]) {
    for (let step = -180; step < 180; step += 5) piece(camera.yaw + step, 5, () => top, bottom);
  }
  return d;
}

const DIRECTIONS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** "NNE" for a bearing of 20 degrees. */
export const compass = (bearing) => DIRECTIONS[Math.round((((bearing % 360) + 360) % 360) / 22.5) % 16];
