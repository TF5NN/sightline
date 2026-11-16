# Sightline

Click two points on a map and see the terrain between them, read straight from
2 m [ArcticDEM](https://www.pgc.umn.edu/data/arcticdem/) elevation data. For
hams, MeshCore and Meshtastic builders, and anyone placing an antenna north of
about 60°N.

Sightline is a plain web page. There is no server and no build step: the
browser fetches only the small pieces of the terrain files that lie under your
path.

**Status: step 1 of the build.** It draws the ground profile. Line of sight,
the Fresnel zone and a link estimate are next.

## How it works

1. You place point A and point B.
2. A draft profile is drawn from the 10 m layer (a small download).
3. The app works out how big the 2 m download would be. Under 15 MB it loads
   by itself; above that it asks first.
4. Holes in the 2 m data are filled from the draft and drawn dotted.

Heights are shown above sea level. The data itself is measured from the WGS84
ellipsoid, so the app corrects it with a coarse EGM96 table (`js/geoid-data.js`).

## Files

| File | Job |
| --- | --- |
| `index.html`, `css/style.css` | The page and its look (same palette as Northbound) |
| `js/app.js` | Map, waypoints, the order things happen in |
| `js/terrain.js` | Opens terrain files, fetches and remembers blocks, returns heights |
| `js/tiles.js` | Where the files live and how they are named. The one place to change if PGC changes its layout |
| `js/profile.js` | Samples a path, fills holes |
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
npm test                       # maths and terrain reader, a second or two
python3 test/ui/check.py       # the whole app in headless Chrome (needs: pip install playwright)
```

The checks read small made-up terrain tiles in `test/tiles/` whose true height
is known everywhere, so the reader can be compared with the right answer.
`python3 tools/make_test_tiles.py test/tiles` rebuilds them.

## Things taken on trust

The file naming in `js/tiles.js` (for example `2m/14_52/14_52_2_1_2m_v4.1_dem.tif`)
could not be checked against the real storage while this was written. Open
`step0.html` on the published site: it tests exactly that and prints a report.

## Credits

DEMs provided by the Polar Geospatial Center under NSF-OPP awards 1043681,
1559691, 1542736, 1810976, and 2129685.

Porter, Claire, et al., 2023, "ArcticDEM, Version 4.1",
https://doi.org/10.7910/DVN/3VDC4W, Harvard Dataverse, V1.

Map tiles © OpenStreetMap contributors. Sea-level model: EGM96, via the
egm96-universal package. Made by TF5NN.
