# Sightline

Click two points on a map and see the terrain between them, read straight from
2 m [ArcticDEM](https://www.pgc.umn.edu/data/arcticdem/) elevation data. For
hams, MeshCore and Meshtastic builders, and anyone placing an antenna north of
about 60°N.

Sightline is a plain web page. There is no server and no build step: the
browser fetches only the small pieces of the terrain files that lie under your
path.

**Status: step 2 of the build, with the simpler interface.** The opening view
is deliberately bare: the map, the terrain profile and the line of sight, with
ground above the line drawn in red. "Estimate radio link" opens the radio side:
pick a band, then a radio, then an antenna (it starts on 2 m, a 5 W handheld
and a rubber duck) and get free-space loss, terrain loss, received signal,
margin and a verdict, with the Fresnel zone drawn on the profile (a tick box
switches it off). Both ends use the same station unless you tick "Different
station at each end".

On a phone, slide a finger along the profile to read the heights; the reading
stays when you lift it. The banner, colours and fonts are shared with
[Northbound](https://github.com/TF5NN/sat-track) and
[Feedpoint](https://github.com/TF5NN/HF-Antenna-Impedance-Visualizer).

## How it works

1. You place point A and point B.
2. A draft is drawn from the 10 m layer and the link is worked out (quietly,
   on the default station, until you open the radio side).
3. "Smart detail" then reads 2 m data only where it can change the answer:
   the first and last 2 km, and wherever the ground comes within one Fresnel
   radius of the line of sight. Under 15 MB it loads by itself; above that it
   asks first.
4. The link is worked out again on the mixed 10 m / 2 m profile.

Under Advanced (inside the radio side) you can type your own figures over the
ones the lists fill in, and ask for 2 m on the whole path, 10 m only, a
different sample limit, or a different Earth radius factor.

Heights are shown above sea level. The data itself is measured from the WGS84
ellipsoid, so the app corrects it with a coarse EGM96 table (`js/geoid-data.js`).

### The radio model, in short

- Earth curvature is added to the terrain (k = 4/3 by default), so the line of
  sight is straight.
- Blocked means the ground is above the line of sight; it is drawn red on
  the chart and the map, always. With the radio side open, grazing stretches
  (ground inside 60% of the first Fresnel zone) are drawn amber as well, and
  the chart shows the Fresnel zone, its 60% line, and the loss at each ridge
  the signal bends over.
- Terrain loss is worked out two ways and the larger is used: knife-edge
  diffraction (ITU-R P.526 approximation) on the worst obstacle and the worst
  one on each side of it; and the Bullington single-ridge method with the
  ITU allowance for broad, real terrain, `(1 - exp(-L/6)) * (10 + 0.02 d_km)`.
  The allowance was added after the first real-world check (a 143 km, 145 MHz
  path over a mountain, which the bare knife edge rated 13 dB too kindly).
- Margin = transmit power + gains - cable losses - free-space loss - terrain
  loss - receiver sensitivity. Verdict bands: 20 dB solid, 10 dB good, 0 dB
  marginal, below that unlikely. These bands are a starting proposal. With a
  different station at each end both directions are worked out and the weaker
  one is judged.
- LoRa sensitivity is worked out from spreading factor and bandwidth.

It does not model reflections, vegetation growth, snow or receiver noise.
Read the margin as give or take 10 dB.

## Data and privacy

Your points and settings stay in the browser and in the page address; the
terrain requests go straight from your browser to the public ArcticDEM archive.
The device's location is asked for only when "My location" is pressed and is
not sent anywhere.

Visits are counted anonymously with [GoatCounter](https://www.goatcounter.com/)
(site code `tf5nn`, private dashboard), the same as Northbound and Feedpoint:
page opens by country and referring site, plus two actions, the links
`main-site-from-sightline` and `github-from-sightline`. No cookies are set. The
counter is told a fixed path (`/sightline/`), so the points and settings in the
page address are never sent. It loads separately from the app, so Sightline
works the same if it is blocked. Local previews are not counted. To leave your
own visits out, open the app once with `#toggle-goatcounter` at the end of the
address in each browser you use. The stylesheet loads DM Sans and IBM Plex Mono
from Google Fonts, with local fallback fonts; the map pictures come from
OpenStreetMap, and the optional satellite pictures from EOX (EOxCloudless,
Sentinel-2, CC BY-NC-SA 4.0: free for non-commercial use with credit).

## Files

| File | Job |
| --- | --- |
| `index.html`, `css/style.css` | The page and its look (same palette as Northbound) |
| `js/app.js` | Map, waypoints, the order things happen in |
| `js/terrain.js` | Opens terrain files, fetches and remembers blocks, returns heights |
| `js/tiles.js` | Where the files live and how they are named. The one place to change if PGC changes its layout |
| `js/radio.js` | Curvature, Fresnel zone, diffraction, link budget, and where 2 m data is worth fetching. Pure maths |
| `js/stations.js` | Reads the stations sheet and names the layers |
| `js/settings.js` | Bands, radios and antennas, and how the choices are kept in the page address (links from before the lists still open) |
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

## Station layers

The layers button on the map can show fixed stations, starting with ÍRA's
repeaters. Tap one to see how to work it, and to use it as point A or B with
its power, antenna and height filled in. The stations live in one sheet,
[data/stations.csv](data/stations.csv), which is meant to be edited by hand;
[data/stations.md](data/stations.md) explains the columns and how to add a
layer. Where the sheet has no figure the app assumes 25 W, 6 dBi and a 10 m
mast, and says so.

## Checking the model against real links

What has been checked so far, and what was found, is written up in
[docs/validation.md](docs/validation.md). The short, plain version for users is
the app's own page, [how.html](https://tf5nn.github.io/sightline/how.html).

`batch.html` (not linked from the app) takes a pasted list of stations and the
links measured between them, runs every pair through the same terrain and radio
sums as the app, and prints predicted against measured SNR. It assumes the
MeshCore EU/UK narrow setup with one antenna gain and height for all stations,
so it shows which way the model leans, not whether one link is right. The lists
themselves are other people's stations and are not kept in this repository.

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
