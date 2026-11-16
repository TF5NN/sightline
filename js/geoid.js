// Turns the heights stored in the terrain files into heights above sea level.
//
// ArcticDEM measures height from the WGS84 ellipsoid, a smooth mathematical
// shape. Maps measure from mean sea level. The gap between the two changes
// slowly from place to place (about 65 m in Iceland), so a coarse table is
// enough. See tools/make_geoid.mjs for where the table comes from.

import { GEOID } from './geoid-data.js';

/**
 * How far mean sea level sits above the ellipsoid at a place, in metres.
 * Returns 0 south of the table's edge, where the app has no terrain anyway.
 */
export function seaLevelOffset(lat, lon) {
  const { south, west, step, rows, cols, decimetres } = GEOID;
  if (lat < south) return 0;
  const wrappedLon = ((((lon - west) % 360) + 360) % 360) + west;
  const fr = Math.min(rows - 1, (lat - south) / step);
  const fc = (wrappedLon - west) / step;
  const r = Math.min(rows - 2, Math.floor(fr));
  const c = Math.min(cols - 2, Math.floor(fc));
  const tr = fr - r;
  const tc = fc - c;
  const at = (rr, cc) => decimetres[rr * cols + cc] / 10;
  return (
    at(r, c) * (1 - tr) * (1 - tc) +
    at(r, c + 1) * (1 - tr) * tc +
    at(r + 1, c) * tr * (1 - tc) +
    at(r + 1, c + 1) * tr * tc
  );
}

/** Height above sea level, given a height above the ellipsoid. */
export function aboveSeaLevel(ellipsoidHeight, lat, lon) {
  return ellipsoidHeight - seaLevelOffset(lat, lon);
}
