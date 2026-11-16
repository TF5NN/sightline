"""Build small synthetic terrain tiles for the automated tests.

The real ArcticDEM tiles are far too big to keep in the repository, so the
tests read these stand-ins instead. Each one is a few kilometres wide, sits
where a real tile would sit, uses the same file naming, and holds a smooth
made-up surface whose exact height is known at every point. That lets the
tests check the terrain reader against the true answer.

Run:  python3 tools/make_test_tiles.py test/tiles
"""
import json
import math
import os
import sys

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.crs import CRS
from rasterio.transform import from_origin

GRID_X0 = -4_000_000
GRID_Y0 = -4_000_000
SUPER = 100_000
NODATA = -9999.0

# Centre of the test area (near Esja, Iceland).
LAT, LON = 64.24, -21.65


def surface(x, y, xc, yc):
    """The made-up terrain: a tilted plane with long gentle waves."""
    return (
        300.0
        + 0.010 * (x - xc)
        + 0.020 * (y - yc)
        + 40.0 * np.sin((x - xc) / 300.0)
        + 25.0 * np.cos((y - yc) / 450.0)
    )


def tile_names(x, y):
    col = math.floor((x - GRID_X0) / SUPER) + 1
    row = math.floor((y - GRID_Y0) / SUPER) + 1
    sup = f"{row:02d}_{col:02d}"
    min_x = GRID_X0 + (col - 1) * SUPER
    min_y = GRID_Y0 + (row - 1) * SUPER
    sx = 2 if x - min_x >= SUPER / 2 else 1
    sy = 2 if y - min_y >= SUPER / 2 else 1
    return sup, f"{sy}_{sx}"


def write(path, west, north, res, size, xc, yc, hole=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cols = west + (np.arange(size) + 0.5) * res
    rows = north - (np.arange(size) + 0.5) * res
    xx, yy = np.meshgrid(cols, rows)
    data = surface(xx, yy, xc, yc).astype("float32")
    if hole is not None:
        hx, hy, hr = hole
        data[(xx - hx) ** 2 + (yy - hy) ** 2 < hr**2] = NODATA
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        height=size,
        width=size,
        count=1,
        dtype="float32",
        crs=CRS.from_epsg(3413),
        transform=from_origin(west, north, res, res),
        nodata=NODATA,
        tiled=True,
        blockxsize=256,
        blockysize=256,
        compress="lzw",
        predictor=3,
    ) as dst:
        dst.write(data, 1)


def main(out):
    to_ps = Transformer.from_crs(4326, 3413, always_xy=True)
    xc, yc = to_ps.transform(LON, LAT)
    sup, sub = tile_names(xc, yc)

    # 2 m stand-in: about 2 km square, with a 60 m hole to test gap filling.
    half = 1024
    west = math.floor((xc - half) / 2) * 2
    north = math.ceil((yc + half) / 2) * 2
    hole = (xc + 400.0, yc - 300.0, 60.0)
    write(f"{out}/2m/{sup}/{sup}_{sub}_2m_v4.1_dem.tif", west, north, 2, 1024, xc, yc, hole)

    # 10 m stand-in: 4 km square, no hole.
    half = 2000
    west10 = math.floor((xc - half) / 10) * 10
    north10 = math.ceil((yc + half) / 10) * 10
    write(f"{out}/10m/{sup}/{sup}_10m_v4.1_dem.tif", west10, north10, 10, 400, xc, yc)

    # 32 m stand-in: about 6 km square, no hole.
    half = 3200
    west32 = math.floor((xc - half) / 32) * 32
    north32 = math.ceil((yc + half) / 32) * 32
    write(f"{out}/32m/{sup}/{sup}_32m_v4.1_dem.tif", west32, north32, 32, 200, xc, yc)

    # Reference numbers the JavaScript tests compare against.
    checks = []
    for lat, lon in [(64.24, -21.65), (65.68, -18.09), (60.0, -45.0), (78.22, 15.65), (64.18, -51.72), (70.0, 25.0)]:
        x, y = to_ps.transform(lon, lat)
        s, q = tile_names(x, y)
        checks.append({"lat": lat, "lon": lon, "x": x, "y": y, "super": s, "sub": q})
    # Two points whose straight path runs through the middle of the hole.
    to_ll = Transformer.from_crs(3413, 4326, always_xy=True)
    a_lon, a_lat = to_ll.transform(hole[0] - 600.0, hole[1] + 350.0)
    b_lon, b_lat = to_ll.transform(hole[0] + 480.0, hole[1] - 280.0)
    meta = {
        "centre": {"lat": LAT, "lon": LON, "x": xc, "y": yc},
        "hole_path": {"a": {"lat": a_lat, "lon": a_lon}, "b": {"lat": b_lat, "lon": b_lon}},
        "super": sup,
        "sub": sub,
        "hole": {"x": hole[0], "y": hole[1], "r": hole[2]},
        "projection_checks": checks,
    }
    with open(f"{out}/meta.json", "w") as fh:
        json.dump(meta, fh, indent=2)
    print(json.dumps(meta["centre"]), sup, sub)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "test/tiles")
