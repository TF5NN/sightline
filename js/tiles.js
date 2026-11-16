// Where the terrain files live and how they are named.
//
// ArcticDEM is cut into a regular grid of 100 km squares ("supertiles"), named
// row_column, for example 14_52. The 10 m and 32 m layers have one file per
// supertile. The 2 m layer splits each supertile into four 50 km quarters,
// named with two more numbers, for example 14_52_2_1.
//
// IMPORTANT: this naming is the one thing in the app taken on trust rather
// than read from the data. step0.html checks it against the real files. If
// PGC ever changes the layout, this file is the only one that needs to change.

export const DEFAULT_BASE_URL =
  'https://pgc-opendata-dems.s3.us-west-2.amazonaws.com/arcticdem/mosaics/v4.1';

export const VERSION_TAG = 'v4.1';

// The grid's corner and square size, in metres on the polar map sheet.
const GRID_X0 = -4_000_000;
const GRID_Y0 = -4_000_000;
const SUPERTILE_SIZE = 100_000;

export const LAYERS = {
  '2m': { id: '2m', resolution: 2, quartered: true },
  '10m': { id: '10m', resolution: 10, quartered: false },
  '32m': { id: '32m', resolution: 32, quartered: false },
};

const pad2 = (n) => String(n).padStart(2, '0');

/** Which 100 km square a grid position falls in. */
export function supertileAt(x, y) {
  const col = Math.floor((x - GRID_X0) / SUPERTILE_SIZE) + 1;
  const row = Math.floor((y - GRID_Y0) / SUPERTILE_SIZE) + 1;
  return {
    row,
    col,
    name: `${pad2(row)}_${pad2(col)}`,
    minX: GRID_X0 + (col - 1) * SUPERTILE_SIZE,
    minY: GRID_Y0 + (row - 1) * SUPERTILE_SIZE,
  };
}

/** Which quarter of its supertile a position falls in: each number is 1 or 2. */
export function quarterAt(x, y, supertile) {
  const half = SUPERTILE_SIZE / 2;
  return {
    qx: x - supertile.minX >= half ? 2 : 1,
    qy: y - supertile.minY >= half ? 2 : 1,
  };
}

/**
 * The file (or files) that could hold a position, most likely first.
 *
 * For the 2 m layer two spellings are offered, because the order of the two
 * quarter numbers is not something we could confirm ahead of time. The
 * terrain reader opens the first, checks from the file's own header that the
 * position really is inside it, and tries the second only if not.
 */
export function tileCandidates(layerId, x, y, baseUrl = DEFAULT_BASE_URL) {
  const layer = LAYERS[layerId];
  if (!layer) throw new Error(`Unknown terrain layer: ${layerId}`);
  const st = supertileAt(x, y);
  const folder = `${baseUrl}/${layer.id}/${st.name}`;
  if (!layer.quartered) {
    return [
      {
        key: `${layer.id}/${st.name}`,
        url: `${folder}/${st.name}_${layer.id}_${VERSION_TAG}_dem.tif`,
      },
    ];
  }
  const { qx, qy } = quarterAt(x, y, st);
  const spellings = qx === qy ? [`${qy}_${qx}`] : [`${qy}_${qx}`, `${qx}_${qy}`];
  return spellings.map((q) => ({
    key: `${layer.id}/${st.name}_${q}`,
    url: `${folder}/${st.name}_${q}_${layer.id}_${VERSION_TAG}_dem.tif`,
  }));
}

/** A short label for the quarter a position is in, used to remember lookups. */
export function areaKey(layerId, x, y) {
  const st = supertileAt(x, y);
  if (!LAYERS[layerId].quartered) return `${layerId}/${st.name}`;
  const { qx, qy } = quarterAt(x, y, st);
  return `${layerId}/${st.name}/${qy}${qx}`;
}
