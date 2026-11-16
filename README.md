# Sightline

Click two points on a map and see the terrain between them, read straight from
2 m [ArcticDEM](https://www.pgc.umn.edu/data/arcticdem/) elevation data. For
hams, MeshCore and Meshtastic builders, and anyone placing an antenna north of
about 60°N.

Sightline is a plain web page. There is no server and no build step: the
browser fetches only the small pieces of the terrain files that lie under your
path.

**Status: step 2 of the build.** It draws the profile with the line of sight
and Fresnel zone, marks grazing and blocked stretches, and estimates the link
(free-space loss, terrain loss, received signal, margin, verdict).

## How it works

1. You place point A and point B and pick a radio setup.
2. A draft is drawn from the 10 m layer and the link is worked out.
3. "Smart detail" then reads 2 m data only where it can change the answer:
   the first and last 2 km, and wherever the ground comes within one Fresnel
   radius of the line of sight. Under 15 MB it loads by itself; above that it
   asks first.
4. The link is worked out again on the mixed 10 m / 2 m profile.

Under Advanced you can ask for 2 m on the whole path, 10 m only, a different
sample limit, or a different Earth radius factor.

Heights are shown above sea level. The data itself is measured from the WGS84
ellipsoid, so the app corrects it with a coarse EGM96 table (`js/geoid-data.js`).

### The radio model, in short

- Earth curvature is added to the terrain (k = 4/3 by default), so the line of
  sight is straight.
- Clear / grazing / blocked: grazing means the ground is inside 60% of the
  first Fresnel zone; blocked means it is above the line of sight.
- Terrain loss is worked out two ways and the larger is used: knife-edge
  diffraction (ITU-R P.526 approximation) on the worst obstacle and the worst
  one on each side of it; and the Bullington single-ridge method with the
  ITU allowance for broad, real terrain, `(1 - exp(-L/6)) * (10 + 0.02 d_km)`.
  The allowance was added after the first real-world check (a 143 km, 145 MHz
  path over a mountain, which the bare knife edge rated 13 dB too kindly).
- Margin = transmit power + gains - cable losses - free-space loss - terrain
  loss - receiver sensitivity. Verdict bands: 20 dB solid, 10 dB good, 0 dB
  marginal, below that unlikely. These bands are a starting proposal.
- LoRa sensitivity is worked out from spreading factor and bandwidth.

It does not model reflections, vegetation growth, snow or receiver noise.
Read the margin as give or take 10 dB.

## Files

| File | Job |
| --- | --- |
| `index.html`, `css/style.css` | The page and its look (same palette as Northbound) |
| `js/app.js` | Map, waypoints, the order things happen in |
| `js/terrain.js` | Opens terrain files, fetches and remembers blocks, returns heights |
| `js/tiles.js` | Where the files live and how they are named. The one place to change if PGC changes its layout |
| `js/radio.js` | Curvature, Fresnel zone, diffraction, link budget, and where 2 m data is worth fetching. Pure maths |
| `js/settings.js` | Radio presets and how settings are kept in the page address |
| `js/profile.js` | Samples a path, fills holes, stitches 10 m and 2 m data into one profile |
| `js/geo.js`, `js/projection.js`, `js/geoid.js` | Distances and bearings, map-grid conversion, sea-level correction. Pure maths |
| `js/chart.js` | The profile chart |
| `step0.html`, `js/step0.js` | Data connection test: can this browser read the real files, and how are they laid out? |
| `vendor/` | Copies of Leaflet 1.9.4, geotiff.js 3.0.5 and Plotly basic 4.3.0 |
| `tools/` | Scripts that generate the sea-level table and the test tiles |
| `test/` | Automatic checks |

## Running it on your own computer

```
python3 -m http.server 8080
```

Then open http://localhost:8080. (Opening `index.html` by double-clicking will
not work; browsers only load this kind of page from a web address.)

## Checks

```
npm install
npm run check                  # type check, then maths and terrain reader; a few seconds
python3 test/ui/check.py       # the whole app in headless Chrome (needs: pip install playwright)
```

The checks read small made-up terrain tiles in `test/tiles/` whose true height
is known everywhere, so the reader can be compared with the right answer.
`python3 tools/make_test_tiles.py test/tiles` rebuilds them.

## Checked against the real data

`step0.html` on the published site reads the real ArcticDEM files and prints a
report. It passed on 16 November 2026: partial reads work from GitHub Pages,
and the file naming in `js/tiles.js` matches the real storage.

## Credits

DEMs provided by the Polar Geospatial Center under NSF-OPP awards 1043681,
1559691, 1542736, 1810976, and 2129685.

Porter, Claire, et al., 2023, "ArcticDEM, Version 4.1",
https://doi.org/10.7910/DVN/3VDC4W, Harvard Dataverse, V1.

Map tiles © OpenStreetMap contributors. Sea-level model: EGM96, via the
egm96-universal package. Made by TF5NN.
