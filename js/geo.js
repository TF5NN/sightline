// Geometry on the Earth: distances, bearings, and points along a path.
// Pure maths. Nothing in here knows about maps, files or the page.

export const MEAN_EARTH_RADIUS = 6371008.8; // metres
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/** Great-circle distance in metres on a round Earth. Good to about 0.3%. */
export function haversineDistance(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * MEAN_EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Distance in metres on the real (slightly flattened) Earth, by Vincenty's
 * method. Accurate to millimetres. Falls back to the round-Earth answer in
 * the rare cases where the method does not settle (nearly opposite points).
 */
export function geodesicDistance(a, b) {
  const U1 = Math.atan((1 - WGS84_F) * Math.tan(toRad(a.lat)));
  const U2 = Math.atan((1 - WGS84_F) * Math.tan(toRad(b.lat)));
  const L = toRad(b.lon - a.lon);
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);

  let lambda = L;
  for (let i = 0; i < 100; i++) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    const sinSigma = Math.hypot(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda);
    if (sinSigma === 0) return 0; // same point
    const cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    const sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    const cosSqAlpha = 1 - sinAlpha * sinAlpha;
    const cos2SigmaM = cosSqAlpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha;
    const C = (WGS84_F / 16) * cosSqAlpha * (4 + WGS84_F * (4 - 3 * cosSqAlpha));
    const next =
      L +
      (1 - C) *
        WGS84_F *
        sinAlpha *
        (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    if (Math.abs(next - lambda) < 1e-12) {
      const uSq = (cosSqAlpha * (WGS84_A * WGS84_A - WGS84_B * WGS84_B)) / (WGS84_B * WGS84_B);
      const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
      const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
      const deltaSigma =
        B *
        sinSigma *
        (cos2SigmaM +
          (B / 4) *
            (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
              (B / 6) *
                cos2SigmaM *
                (-3 + 4 * sinSigma * sinSigma) *
                (-3 + 4 * cos2SigmaM * cos2SigmaM)));
      return WGS84_B * A * (sigma - deltaSigma);
    }
    lambda = next;
  }
  return haversineDistance(a, b);
}

/** Compass bearing in degrees (0 = north, 90 = east) when leaving a towards b. */
export function initialBearing(a, b) {
  const phi1 = toRad(a.lat);
  const phi2 = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** The point a fraction f (0 to 1) of the way from a to b along the great circle. */
export function pointAlong(a, b, f) {
  const phi1 = toRad(a.lat);
  const lam1 = toRad(a.lon);
  const phi2 = toRad(b.lat);
  const lam2 = toRad(b.lon);
  const v1 = [Math.cos(phi1) * Math.cos(lam1), Math.cos(phi1) * Math.sin(lam1), Math.sin(phi1)];
  const v2 = [Math.cos(phi2) * Math.cos(lam2), Math.cos(phi2) * Math.sin(lam2), Math.sin(phi2)];
  const dot = Math.max(-1, Math.min(1, v1[0] * v2[0] + v1[1] * v2[1] + v1[2] * v2[2]));
  const omega = Math.acos(dot);
  if (omega < 1e-12) return { lat: a.lat, lon: a.lon };
  const s1 = Math.sin((1 - f) * omega) / Math.sin(omega);
  const s2 = Math.sin(f * omega) / Math.sin(omega);
  const x = s1 * v1[0] + s2 * v2[0];
  const y = s1 * v1[1] + s2 * v2[1];
  const z = s1 * v1[2] + s2 * v2[2];
  return { lat: toDeg(Math.atan2(z, Math.hypot(x, y))), lon: toDeg(Math.atan2(y, x)) };
}

/**
 * Evenly spaced points from a to b, both ends included.
 * Each point carries its distance from a in metres.
 */
export function samplePath(a, b, count) {
  const n = Math.max(2, Math.floor(count));
  const total = geodesicDistance(a, b);
  const points = new Array(n);
  for (let i = 0; i < n; i++) {
    const f = i / (n - 1);
    const p = pointAlong(a, b, f);
    points[i] = { lat: p.lat, lon: p.lon, distance: f * total };
  }
  return points;
}
