# Using the terrain layers in Sightline: what was measured

Sightline reads ArcticDEM directly. The [terrain](https://github.com/TF5NN/terrain)
repository holds small layers of the same data for Iceland, first made for
Northbound's horizon. This page records the measurements made on 17 and 18
November 2026 to decide how far Sightline should use them, what was found, and
what was built. It also records what went wrong on the way, because two of the
mistakes changed the conclusions.

Short version:

- **Station colours** come from the app's own link estimate run on a coarse
  profile from the layers. Against the same estimate on the 10 m data: the
  same colour on 338 of 343 paths, the other five one colour off.
- **The first draft of a profile** in Iceland is read from a copy of the 10 m
  data in the terrain repository. On five real paths the final answer was the
  same to 0.01 dB for about a tenth of the draft download.
- **Leaving coarse data in the profile** where the ground cannot matter also
  gave identical answers, but saved less and needed a new rule in the
  validated calculation. It was not built.
- **The 2 m detail** still comes from ArcticDEM, 1–3 MB a path, and is now the
  larger part of the download.

---

## The test paths

Most of the measurements below use one set of paths, made by
`tools/make_sight_reference.py` in the terrain repository:

- From 60 look-outs (8 chosen, 52 scattered at random over Iceland) to the
  eight ÍRA repeater sites: 479 paths.
- 136 of them start at sea, where the layers have no ground, and drop out.
  That leaves **343 paths**.
- For each, the ground was read straight from the ArcticDEM v4.1 10 m mosaic
  every 10 m. That is "the 10 m data" below.
- Antennas: 2 m at the look-out, 10 m at the site. Earth radius factor 4/3.

**The set is a hard case, not typical use.** 330 of the 343 paths are blocked
and only 13 have a line of sight; 281 are over 80 km. Read the percentages
below with that in mind.

---

## 1. Station colours: a first estimate from coarse data

**Question.** Can each station on the map be coloured by whether point A can
work it, without loading a profile for each?

**First attempt: bare line of sight.** The terrain repository's `sight()` gives
the least height of the line above the layers' ground. Compared with the 10 m
data, with "marginal" set at 40 m below the layers' ground:

| Truth (10 m data) | Called in sight | Marginal | Blocked |
| ----------------- | --------------- | -------- | ------- |
| 13 clear          | 10              | 3        | 0       |
| 330 blocked       | 0               | 20       | 310     |

No blocked path was called clear and no clear path was called blocked. But it
answered the wrong question: a repeater with no line of sight was shown red
although the full profile gave "Solid, +26.7 dB". Bare line of sight was
replaced.

**What is used: the link estimate on a coarse profile.** `profile()` in the
terrain repository gives the ground along the path from the 40 m layer within
2 km of either end and the 100 m layer between. Sightline runs its own
`linkEstimate` on it, with the figures "Use as B" on that station would give.
Compared with the same estimate on the 10 m data (5 W handheld with a −3 dBi
antenna to a 25 W repeater with 6 dBi, both receivers −119 dBm):

| Frequency | Same colour | One colour off | Middle difference | 90% of paths within |
| --------- | ----------- | -------------- | ----------------- | ------------------- |
| 145 MHz   | 338 of 343  | 5              | −0.6 dB           | −4 to +1 dB         |
| 435 MHz   | 337 of 343  | 6              | −0.6 dB           | −5 to +1.5 dB       |

The colours are: 10 dB or more to spare, 0 to 10 dB, below 0 dB.

**Its known weakness.** The estimate leaves out the ground within 100 m of
each end, and so did the comparison above, so the comparison could not see
this. On the live site, from the summit of Þverfellshorn to Bláfjöll with a
handheld at 1.5 m, the first estimate said +24 dB and the full profile +15 dB:
the same colour, but 9 dB too generous, because the plateau around the antenna
is what gets in the way and only the 2 m data sees it. On a hilltop or ridge
edge with a low antenna, treat the first estimate as generous.

**Cost, measured.** One path on its own fetches 10–85 KB depending on length.
The eight ÍRA sites from one new spot came to about 180 KB, plus 155 KB once
for the layers' index and 1 km layer. An earlier figure of "about 4 KB per
station" was wrong: it was an average over paths that shared tiles already
loaded.

---

## 2. What a profile cost before

Four paths on the live site, 18 November 2026, counting the bytes of every
request to ArcticDEM:

| Path                             | First chart | 10 m draft | 2 m detail |
| -------------------------------- | ----------- | ---------- | ---------- |
| Foot of Esja to Perlan, 13 km    | 4.8 s       | 1.4 MB     | 3.0 MB     |
| Reykjavík to Skálafell, 24 km    | 3.2 s       | 2.9 MB     | 2.8 MB     |
| Þverfellshorn to Bláfjöll, 30 km | 3.8 s       | 3.7 MB     | 2.1 MB     |
| Reykjavík to Búrfell, 99 km      | 6.0 s       | 10.3 MB    | 3.4 MB     |

The draft costs about 110 KB for every kilometre: ArcticDEM's files are cut
into large blocks, and a path draws on a whole block for each short stretch.
The 2 m detail is 2–3 MB whatever the length, because it is only read where it
can change the answer.

---

## 3. Coarse data inside the profile (measured, not built)

**Question.** Could the profile keep the coarse layers where the ground is far
from the line, and read the 10 m data only where it matters?

**Method.** For each of the 343 paths, a mixed profile was made: the 10 m data
inside the stretches a rule asked for, the coarse layers elsewhere, both ends
always in full detail. `linkEstimate` was run on it and on the plain 10 m
profile, and the margins compared. Two rules were tried:

- **Zone rule:** read the 10 m data wherever the coarse ground is inside the
  first Fresnel zone or above the line, with 200 m to spare each side, and for
  the first and last 2 km.
- **String rule:** read it only where the coarse ground comes within one
  Fresnel radius, plus a margin, of a string stretched over the terrain from
  one antenna to the other. Ground far below that string is in the shadow of
  higher ground on both sides and cannot bend the signal.

**Result.** Share of the total path length where the 10 m data was still read:

| Rule                      | 145 MHz | 868 MHz | Margin against plain 10 m    |
| ------------------------- | ------- | ------- | ---------------------------- |
| Zone                      | 91%     | 87%     | identical on all 343         |
| String, 60 m margin       | 54%     | 29%     | identical on all 343         |
| String, 150 m margin      | 67%     | 44%     | identical on all 343         |
| String, 15 m margin       | 47%     | 22%     | one path 10 dB out (868 MHz) |

"Identical" means within 0.05 dB. On the 13 line-of-sight paths the zone rule
alone left 30% (145 MHz) and 14% (868 MHz) to read.

Other findings:

- **The coarse layers never read low.** At the same points they were on
  average 15.4 m above the 10 m ground (the 100 m layer) or 3.2 m (the 40 m
  layer), and lower by more than 1 m at 0.0% and 0.2% of points. This is why
  skipping is safe: a stretch that clears on the coarse data clears in truth.
- **A finer middle layer buys nothing here.** Using the 40 m layer for the
  whole path gave the same shares as the 100 m layer (54% and 29%). The share
  is set by the Fresnel zone and the margin, not by the coarseness.
- **The margin matters.** At 15 m with the 100 m layer one path came out
  10 dB wrong. 60 m is the smallest margin that was safe on this set.

**Why it was not built.** It saves about half the draft where a 10 m layer of
our own saves about nine tenths (next section), and it would put a new rule
and mixed-resolution profiles into the calculation that `docs/validation.md`
stands behind.

---

## 4. Our own 10 m layer (built)

**Size, estimated first** from three sample 100 km squares, encoded the same
way as the other layers and scaled to Iceland by the size of today's 40 m
layer for the same squares:

| Layer                  | Whole of Iceland | Typical tile |
| ---------------------- | ---------------- | ------------ |
| 40 m (already there)   | 29 MB            | 4 KB         |
| 20 m, 2 m height steps | about 79 MB      | 3 KB         |
| 10 m, 2 m height steps | about 191 MB     | 7 KB         |
| 10 m, 1 m height steps | about 266 MB     | 10 KB        |

**As built:** 10 m cells, heights to the nearest metre, 2 km tiles. 30,424
tiles, **272 MB**. It is not "highest ground per cell" like the other layers:
it is ArcticDEM's 10 m mosaic cell for cell, on the same grid, with heights
above mean sea level.

**Checked against the mosaic.** 600 points at random in four squares (coast,
lowland, highland, the north), each blended from its four cells the way
Sightline blends ArcticDEM's files: no point differs by more than 0.8 m, and
the mean difference is under 0.1 m. This runs with the terrain repository's
tests.

**Holes.** ArcticDEM has no data over much of the open sea: a quarter of
one square on the north coast is holes, while the two inland squares checked
have none. A
hole in ArcticDEM is a hole in the copy and never reads as sea level, so
Sightline fills it from ArcticDEM's 32 m layer as before. 13,728 tiles are
nothing but holes; they are listed, not stored.

**Compared in Sightline**, each path loaded twice on a local copy of the app:
once with the draft from ArcticDEM (`?draft=arcticdem`) and once from the
layer. ArcticDEM was reached over the network both times; the layer was read
from this machine's disk.

| Path                                 | Draft, ArcticDEM | Draft, our layer | 2 m detail | Final margin, both |
| ------------------------------------ | ---------------- | ---------------- | ---------- | ------------------ |
| Akureyri to Vaðlaheiði, 6 km         | 1.1 MB           | 0.10 MB          | 1.2 MB     | +27.46 dB          |
| Foot of Esja to Perlan, 13 km        | 1.4 MB           | 0.13 MB          | 3.0 MB     | +30.50 dB          |
| Reykjavík to Skálafell, 24 km        | 2.9 MB           | 0.28 MB          | 2.8 MB     | +11.46 dB          |
| Þverfellshorn to Bláfjöll, 30 km     | 3.7 MB           | 0.30 MB          | 2.1 MB     | −14.94 dB          |
| Reykjavík to Búrfell, 99 km          | 10.3 MB          | 0.79 MB          | 3.4 MB     | −15.31 dB          |

- The final margin and terrain loss were the same to 0.01 dB on all five, and
  the 2 m detail asked for was the same to the byte.
- The draft download fell by about 90%: 8–10 KB a kilometre against 110 KB.
- The first chart came after about 1 s against 2–5 s. That flatters the layer,
  which was read from disk; see the live figures below.

**On the live site**, after publishing, the same five paths were loaded both
ways from `tf5nn.github.io`, everything over the network:

| Path                             | Draft, ArcticDEM | Draft, our layer   | First chart     | Finished        |
| -------------------------------- | ---------------- | ------------------ | --------------- | --------------- |
| Akureyri to Vaðlaheiði, 6 km     | 1.1 MB           | 62 KB in 9 files   | 3.7 s to 2.3 s  | 5.4 s to 4.1 s  |
| Foot of Esja to Perlan, 13 km    | 1.4 MB           | 91 KB in 14 files  | 3.1 s to 2.1 s  | 5.5 s to 4.2 s  |
| Reykjavík to Skálafell, 24 km    | 2.9 MB           | 246 KB in 22 files | 3.6 s to 2.3 s  | 5.5 s to 4.4 s  |
| Þverfellshorn to Bláfjöll, 30 km | 3.7 MB           | 262 KB in 26 files | 3.6 s to 2.6 s  | 5.3 s to 4.3 s  |
| Reykjavík to Búrfell, 99 km      | 10.3 MB          | 750 KB in 72 files | 6.0 s to 3.3 s  | 8.3 s to 5.6 s  |

- The margins, terrain losses and verdicts were again identical on all five,
  and no ArcticDEM 10 m data was read with the layer in use.
- The draft download fell by 92–94%.
- The time saved is real but smaller than the local run suggested: about one
  second on short paths and nearly three on the 99 km one. The first chart
  still takes two to three seconds, most of it the page and its libraries
  loading, not the terrain. One run each, on one connection.

---

## 5. What went wrong on the way

- **Misaligned profiles.** The first run of section 3 showed mixed profiles
  doing worse than coarse alone, with margins up to 30 dB out. The cause was
  the test: the terrain repository's `profile()` walks a path on a sphere,
  while the 10 m reference and Sightline use the WGS84 ellipsoid, and on long
  paths the two put the same distance a few hundred metres apart. Reading both
  at the same points made the answers identical. **Anything in Sightline that
  mixes sources must read the layers at Sightline's own points**, which is why
  `terrain.detail()` takes grid positions and does not walk the path itself.
- **A flattering download figure**, the "4 KB per station" in section 1.
- **Sea level for holes.** The first build of the layer stored open sea with
  no data as sea level. The test against the mosaic caught it.
- **The first estimate's blind spot** near the antenna, in section 1, was
  found by a user's test on the live site, not by the comparison.

---

## How to repeat this

In the terrain repository, with the ArcticDEM v4.1 10 m mosaics for the squares
in `v1/manifest.json` in a folder (about 2.9 GB):

```
python3 tools/build_layers.py /path/to/the/tifs
python3 tools/build_detail.py /path/to/the/tifs
python3 tools/make_reference.py /path/to/the/tifs
python3 tools/make_sight_reference.py /path/to/the/tifs
python3 tools/make_detail_reference.py /path/to/the/tifs
npm test
```

That rebuilds the layers and checks the horizon, `sight()`, `profile()` and
the detail layer against the mosaics. In Sightline, `?draft=arcticdem` reads
the draft from ArcticDEM so the two sources can be compared on any path.

The scripts for sections 1 (the link estimate comparison), 2 and 3, and for
the five-path comparison in section 4, were one-off and are not kept in either
repository. The method is as described above; the 10 m reference profiles they
used are the ones `make_sight_reference.py` samples.
