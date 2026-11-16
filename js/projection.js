// Converts latitude and longitude into the flat map grid the ArcticDEM tiles
// use. That grid is "NSIDC Sea Ice Polar Stereographic North" (EPSG:3413):
// a flat sheet touching the Earth around the North Pole, measured in metres.
//
// Written out by hand (about ten lines of maths) so the app does not need a
// whole projection library for one conversion. The tests compare it with the
// reference library PROJ to within a millimetre.

const A = 6378137.0; // WGS84 equatorial radius, metres
const F = 1 / 298.257223563; // WGS84 flattening
const E2 = 2 * F - F * F;
const E = Math.sqrt(E2);
const TRUE_SCALE_LAT = (70 * Math.PI) / 180; // the grid is exact at 70 degrees north
const CENTRAL_MERIDIAN = -45; // degrees; this meridian points straight "down" the sheet

function tFactor(phi) {
  const s = Math.sin(phi);
  return Math.tan(Math.PI / 4 - phi / 2) / Math.pow((1 - E * s) / (1 + E * s), E / 2);
}

const M_C = Math.cos(TRUE_SCALE_LAT) / Math.sqrt(1 - E2 * Math.sin(TRUE_SCALE_LAT) ** 2);
const T_C = tFactor(TRUE_SCALE_LAT);

/** Latitude and longitude in degrees to grid x and y in metres. */
export function toGrid(lat, lon) {
  const rho = (A * M_C * tFactor((lat * Math.PI) / 180)) / T_C;
  const lam = ((lon - CENTRAL_MERIDIAN) * Math.PI) / 180;
  return { x: rho * Math.sin(lam), y: -rho * Math.cos(lam) };
}
