// The first draft of a profile, read from the shared terrain layers
// (github.com/TF5NN/terrain) instead of from ArcticDEM's own files.
//
// Those layers hold a copy of ArcticDEM's 10 m data for Iceland, cell for cell
// on the same grid, to the nearest metre, cut into small tiles. A draft read
// from it is the same profile as one read from ArcticDEM, for a twentieth of
// the download. Outside Iceland, or when the layers cannot be reached, the
// app reads ArcticDEM as before.

import { seaLevelOffset } from './geoid.js';
import { SOURCE_NONE, SOURCE_OWN, pathSamples } from './profile.js';

/**
 * The 10 m draft for a path, shaped like buildProfile()'s result, or null when
 * the layers do not hold it (no detail layer, or part of the path lies outside them).
 *
 * @param {{ layers: any, a: {lat: number, lon: number}, b: {lat: number, lon: number}, maxSamples: number }} options
 *   layers: the opened terrain layers (see sight.js openLayers)
 */
export async function ownDraft({ layers, a, b, maxSamples }) {
  if (!layers?.hasDetail) return null;
  const { total, count, spacing, points, grid } = pathSamples(a, b, '10m', maxSamples);
  const { x0, y0, widthMetres, heightMetres } = layers.manifest;
  // Keep a cell's width clear of the edge, so every point has its four cells inside the layer.
  const edge = 2 * layers.manifest.layers.detail.cellMetres;
  const inside = (p) => p.x >= x0 + edge && p.y >= y0 + edge && p.x < x0 + widthMetres - edge && p.y < y0 + heightMetres - edge;
  if (!grid.every(inside)) return null;

  const before = layers.stats.requests;
  const aboveSea = await layers.detail(
    Float64Array.from(grid, (p) => p.x),
    Float64Array.from(grid, (p) => p.y),
  );
  // The rest of the app works in heights above the ellipsoid, as ArcticDEM's files have them,
  // and takes sea level off when it draws. Put it back on here so the two sources are alike.
  const heights = new Float32Array(count);
  const source = new Uint8Array(count);
  let valid = 0;
  for (let i = 0; i < count; i++) {
    if (Number.isNaN(aboveSea[i])) {
      heights[i] = NaN;
      source[i] = SOURCE_NONE;
    } else {
      heights[i] = aboveSea[i] + seaLevelOffset(points[i].lat, points[i].lon);
      source[i] = SOURCE_OWN;
      valid += 1;
    }
  }
  return {
    layerId: '10m',
    total,
    spacing,
    points,
    heights,
    source,
    coverage: count ? valid / count : 0,
    blocks: layers.stats.requests - before,
    problems: { missing: 0, blocked: 0, unreadable: 0 },
    fromLayers: true,
  };
}
