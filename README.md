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
2. A draft is drawn from the 10 m data and the link is worked out (quietly,
   on the default station, until you open the radio side). In Iceland the
   draft is read from a copy of that data in the
   [terrain](https://github.com/TF5NN/terrain) repository, cut into small
   tiles: the same heights, to the nearest metre, for about a tenth of the
   download (see "The draft in Iceland" below). Elsewhere, or if that cannot
   be reached, it is read from ArcticDEM itself.
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
In Iceland the first draft of a profile is fetched from `tf5nn.github.io/terrain`
instead. With a station layer showing and point A placed in Iceland, or when Look around
is pressed, a few small terrain files are also fetched from `tf5nn.github.io/terrain` to colour the stations by
whether A can work them (see "Stations seen from A" below).
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
| `js/panorama.js`, `js/lookaround.js` | The look-around view: where each direction lands in the picture, and the drawing |
| `js/owndraft.js` | The first draft of a profile from the shared terrain layers, where they cover the path |
| `js/sight.js` | Which stations point A can work: opens the shared terrain layers, runs the link estimate on a coarse profile, words the answer |
| `js/settings.js` | Bands, radios and antennas, and how the choices are kept in the page address (links from before the lists still open) |
| `js/profile.js` | Samples a path, fills holes, stitches 10 m and 2 m data into one profile |
| `js/geo.js`, `js/projection.js`, `js/geoid.js` | Distances and bearings, map-grid conversion, sea-level correction. Pure maths |
| `js/chart.js` | The profile chart |
| `js/theme.js` | Light or dark: applies the theme before the first paint, and runs the header button |
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

## The draft in Iceland

ArcticDEM's 10 m files are made for reading large areas: a path draws on big
blocks, about 110 KB for every kilometre. The terrain repository holds the
same 10 m data for Iceland in 2 km tiles of about 9 KB, and `js/owndraft.js`
reads the draft from those: roughly 8–10 KB a kilometre.

On five real paths, 6 to 99 km long, the draft download fell from 1.1–10.3 MB
to 0.1–0.8 MB, and the final link margin, after the 2 m detail, was the same
to 0.01 dB. The 2 m detail still comes from ArcticDEM (2–3 MB a path) and is
now the larger part. A hole in ArcticDEM is a hole in the copy too, and is
filled from ArcticDEM's 32 m layer as before.

To compare the two sources, add `?draft=arcticdem` to the page address: the
draft is then read from ArcticDEM even in Iceland.

The measurements behind this and behind the station colours, including the
alternatives that were measured and not built, are in
[`docs/terrain-layers.md`](docs/terrain-layers.md).

## Stations seen from A

With a station layer showing, placing point A colours each station by a first
estimate of the radio link to it: green should work (10 dB or more to spare),
amber marginal (0 to 10 dB), red unlikely. The station's card gives the figure
and says whether there is a line of sight or the signal has to bend over the
terrain.

It is the app's own link estimate (`js/radio.js`), with the figures "Use as B"
on that station would give, run on a quick profile from the layers in the
[terrain](https://github.com/TF5NN/terrain) repository instead of the full
ArcticDEM data. Iceland only.

> On the branch `detail-near` only, and only together with the terrain
> repository's branch of the same name. On `main` the quick profile reads the
> 40 m layer near the ends and leaves out the nearest 100 m. See the note at the
> top of `docs/terrain-layers.md`.

The quick profile is the 10 m data itself within 2 km of each end, counting
the ground from 10 m out, and a 100 m "highest ground per cell" layer between.
The ends matter most: on a summit, the plateau around the antenna is what gets
in the way. From five spots (a summit, two hilltops and slopes, a valley floor,
a street) to five repeaters, against the same estimate on 10 m data all the
way: 0.1 dB off in the middle case, 3.6 dB at worst, the same colour on all 25.
Before the ends were read from the 10 m data it was 2.0 dB and 14.9 dB.

It costs about 400–470 KB for the nine ÍRA repeaters from a new spot (plus
155 KB once), against megabytes for one full profile. Tap a station and use it
as B for the real profile, which also reads 2 m data. The measurements are in
[`docs/terrain-layers.md`](docs/terrain-layers.md).
`js/sight.js` holds the thresholds and the wording.

## Look around

"Look around", beside Clear, opens the view from point A: the terrain's
skyline at A's antenna height, with compass bearings along the horizon. Drag
it, or use the arrow keys, to turn and tilt. Stations on the layers that are
showing, and point B, are marked where they stand, in the same colours as on
the map; one with no line of sight is drawn behind the ground, so the direction
to it is still shown. It is drawn from the same small terrain layers as "Stations seen
from A" (Iceland only, about 40 KB), and leaves out buildings, trees and ground
closer than 100 m. `js/panorama.js` is the maths (shared with Northbound's
look-around view), `js/lookaround.js` the drawing.

## Light and dark

The page follows the device's light or dark setting. The sun or moon button at
the end of the header switches it; that choice is remembered in the browser
(as `tf5nn-theme`, shared with Northbound and Feedpoint, so it carries between
the apps) and from then on wins over the device. `js/theme.js` does this, loaded
in the head of every page so the theme is set before the first paint.

Dark mode is made by giving each named shade at the top of `css/style.css` a
second value, a copy of Northbound's (its `docs/STYLE.md` is the style guide for
all three apps), plus dark values for Sightline's own seven. The chart reads
its colours from those shades each time it is drawn, and the lines on the map
take theirs from the stylesheet. The map pictures are dimmed, not replaced.

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
