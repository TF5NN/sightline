# How close is Sightline? Checks against real links

Sightline's verdict is an estimate from a simple model. This page records every
time the model has been compared with what actually happened on the air, what
was found, and what was changed because of it. Newest first.

Short version, as of 16 November 2026:

- **Terrain (does a mountain block the path?): good.** In the one large check,
  every pair the model said could not work was indeed never heard.
- **Link margin on blocked paths in town at 868 MHz: too optimistic**, by very
  roughly 16 dB in the one check so far. Part of that is radio noise in town,
  which the model does not know about; part is that the stations' antennas and
  heights were guessed.
- Two checks is not many. The verdict bands (20 / 10 / 0 dB) are still a
  starting proposal.

---

## Check 2: fourteen MeshCore repeaters, 91 pairs, 868 MHz (16 November 2026)

**Purpose:** a look at whether the model is in the right neighbourhood. Nothing
in the model was changed because of it.

### What was compared

The Icelandic MeshCore community runs a public
[CoreScope](https://github.com/Kpa-clawbot/corescope) analyser at
`mc.flatuslifir.is`. It lists the repeaters with their positions and, for each
repeater, the neighbours it has a direct radio link with, the average
signal-to-noise ratio (SNR) on that link and how many times it was seen.

On 16 November 2026 this was read once: 21 repeaters, of which 14 had a usable
position, all in south-west Iceland (Reykjavík area, Skálafell, Esja and
Vestmannaeyjar). Between those 14 there were 41 measured links. As a check on
the copying, every distance the server reported was recomputed from the
positions; all 41 matched.

Fourteen stations make 91 pairs. Every pair was run through Sightline's own
terrain and radio sums with the batch check page (`batch.html`, see below):
41 pairs with a measured link, 50 without.

The station list itself is not kept in this repository. It is other people's
stations, some of them at home addresses.

### What had to be assumed

Nothing was known about the individual stations, so every one was given the
same figures:

| | |
|---|---|
| Radio | MeshCore EU/UK narrow: 869.618 MHz, SF8, 62.5 kHz, 22 dBm |
| Antenna | 3 dBi |
| Height | 3 m above the surface in the terrain data (the surface includes roofs) |
| Noise at the receiver | -120 dBm (a quiet receiver), so a link needs an SNR of -10 dB or better |
| Terrain | smart detail: 10 m everywhere, 2 m near the antennas and where it matters |

**These assumptions are known to be wrong for some stations.** At least the
Kambshorn repeater runs a high-gain collinear antenna, and other hilltop sites
probably do too. Real antennas, heights and cable losses will be asked for and
the check run again with them.

The run was made from `tf5nn.github.io` at commit `af1970b`: 575 terrain blocks,
96 seconds.

### What came out

**1. When the model says "no link", it was right every time.**
28 pairs were predicted below the -10 dB limit. None of them has ever been
measured as a link.

**2. Links that exist come out as workable: 40 of 41.**
The one miss is a 108 km pair predicted far below the limit and seen exactly
once. A single sighting like that is most likely a hop attributed to the wrong
station.

**3. Clear line-of-sight links are predicted strong and measured strong.**
Links to the hilltop repeaters with nothing in the way were predicted at +26 to
+39 dB and measured at +6.6 to +10.8 dB. That agrees as far as it can: a LoRa
receiver's SNR figure stops rising at around +8 to +12 dB however strong the
signal is, so these links cannot show how accurate the margin is.

**4. On blocked links in town the model is too optimistic.**
The useful comparison is the links measured clearly below that ceiling: SNR
under +4 dB, seen five times or more. There are 15.

| Predicted minus measured SNR | |
|---|---|
| Median | +16 dB (model too optimistic) |
| Mean | +16 dB |
| Range | -11 dB to +50 dB |

- The worst are very short links between stations in town, 1 to 2 km apart:
  30 to 50 dB too optimistic.
- Where the model sees more than about 45 dB of terrain loss it is 5 to 11 dB
  too *pessimistic*. That is expected: only packets that got through are
  averaged, so a link on the edge looks better than it is.

**5. One long sea path is predicted too weak.**
Vestmannaeyjar to Esja, 118 km: predicted right at the edge (blocked, 15 dB of
terrain loss), measured strong on eight sightings. High-gain antennas at both
hilltop sites would explain most of that; so could the guessed 3 m height, a
rounded position, or radio waves bending more than usual over the sea.

**6. Pairs never measured: 22 of 50 "should work" by the model.**
Most of those are predicted between -10 and +5 dB, which the optimism in point
4 would push under the limit. A pair can also be silent simply because the
mesh never routed that way.

### Why the model is probably too optimistic in town

These cannot be told apart with this data.

- **Radio noise.** The analyser's own observers report a noise floor of about
  -115 dBm and -112 dBm in the Reykjavík area (24-hour averages), against the
  model's quiet -120 dBm. That alone is 5 to 8 dB. One observer in
  Vestmannaeyjar reports about -83 dBm.
- **Guessed stations.** A node in a window or an attic is easily 10 to 20 dB
  worse than an antenna 3 m above the roof, which is where the model put all
  of them.
- **Rows of rooftops.** The model counts at most three obstacles on a path.

Taking the noise off leaves roughly 8 to 10 dB, inside the "give or take
10 dB" the app already states, but it leans one way.

### What to take from it

- Trust a "blocked, unlikely" verdict.
- On a blocked path in town at 868 MHz, read Marginal or Good as "probably
  not".
- On clear paths the model and reality agree as far as this data can show.

### Limits of this check

- Station antennas, heights and cable losses were guessed, and the guess is
  known to be wrong for at least one site.
- How the analyser works out the average SNR for a pair was not confirmed.
- Positions may be rounded or deliberately imprecise.
- One network, one band, one afternoon.

### Still to do

- Ask the community for the real antenna, height and cable loss per repeater,
  and run it again.
- Consider a noise-floor setting for LoRa. Not decided.

### Running it yourself

Open `batch.html` on the site, paste a list like this, and press "Run the
check":

```json
{
  "title": "optional description",
  "nodes": [
    { "id": "a", "name": "Hill", "lat": 64.1, "lon": -21.9 },
    { "id": "b", "name": "Town", "lat": 64.0, "lon": -21.8 }
  ],
  "links": [
    { "a": "a", "b": "b", "snr": 5.2, "count": 40 }
  ]
}
```

It prints predicted against measured SNR for every pair and a short summary.
Everything happens in the browser.

---

## Check 1: one 143 km path on the 2 m band (16 November 2026)

**Outcome: matches, after a change to the model.**

A path from the Bláfjöll 2 m repeater (output 145.650 MHz, input 145.050 MHz)
to a spot on the south coast, 142.55 km away, over a mountain that stands
635 m above the line of sight.

**On the air:** with a 5 W handheld and a rubber duck the repeater opens but
the signal is not readable. With a 3-element yagi on the same radio it gets
through.

**Before:** the model said Good, +12.8 dB, with 24.4 dB of terrain loss from a
single knife edge. About 10 to 15 dB too kind.

**Changed (commit `451c2fe`):**

- Terrain loss is now the larger of two methods: knife-edge diffraction over at
  most three ridges, and the ITU-R P.526 single-ridge (Bullington) method with
  its allowance for broad, real terrain,
  `(1 - exp(-L/6)) * (10 + 0.02 * d_km)`. On this path: 24.4 + 12.6 = 37.0 dB.
  A unit test reproduces these numbers.
- A stock rubber duck is taken as -3 dBi.

**After:** Marginal with the rubber duck, Good with the yagi, which is what is
heard.

**Limits:** one path. The repeater's antenna (6 dBi), mast (10 m) and cable
loss (1.5 dB) were guessed, and the yagi's gain (6.5 dBi) is an estimate.
