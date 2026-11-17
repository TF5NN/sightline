# Station layers

`stations.csv` is the list of stations Sightline can show on the map: one line
per station. It is the only place to edit. Open it in Excel, LibreOffice or on
GitHub, change it, save it as CSV, and the app picks it up.

Turn a layer on with the layers button in the corner of the map. Tap a station
to see its details and to use it as point A or B; the app then fills in that
end's power, antenna and height from this sheet.

## The columns

| Column | What goes in it | If left empty |
|---|---|---|
| `layer` | Which layer the station belongs to: a short word such as `ira`. Every different word becomes its own tick box on the map. | The line is skipped. |
| `show` | `yes` to show the station in the app. Anything else keeps it in the sheet but off the map. | Not shown. |
| `callsign` | Callsign or channel name, for example `TF3RPB`. Also used in share links, so keep it unique among shown stations. | The site name is used. |
| `name` | The site, for example `Bláfjöll`. | |
| `type` | `FM`, `D-STAR`, `DMR`, `APRS` ... Shown in the name, as "2 m FM". | |
| `output_mhz` | The frequency the station transmits on: what you listen to. | No frequencies are shown; the 2 m band is assumed. |
| `input_mhz` | The frequency the station listens on: what you transmit on. | Only the output is shown. |
| `tone` | Tone or colour code, for example `88.5` or `CC1`. | Not shown. |
| `lat`, `lon` | Position in decimal degrees, WGS84. West is negative. | The line is skipped and reported. |
| `power_w` | Transmit power in watts. | **25 W is assumed.** |
| `antenna` | A description, for example `Kathrein 2-dipole VHF`. For reading only. | |
| `gain_dbi` | Antenna gain in dBi. This is the figure the sums use. | **6 dBi is assumed** (a collinear). |
| `height_m` | Antenna height above the ground, in metres. | **10 m is assumed.** |
| `cable_db` | Loss in cable and filters, in dB. | 0 dB. |
| `status` | `active`, `off air` ... Shown in the details. | |
| `position_confidence` | `high`, `medium` or `low`: how sure the position is. Shown in the details. | |
| `source` | Where the information came from. | |
| `notes` | Anything worth knowing. Shown in the details. | |

Where a figure is assumed, the app says so next to it.

## Adding a layer

Add lines with a new word in the `layer` column, for example `sar`, and `yes`
under `show`. A new tick box appears by itself. The tick box is named after
the word unless a proper name is listed for it in `js/stations.js`
(`LAYER_NAMES`); `ira`, `ira-aprs`, `f4x4`, `sar` and `meshcore` already have
names.

## Good to know when editing

- Either commas or semicolons between columns work, and decimal commas
  (`64,23889`) are understood, so a file saved by an Icelandic Excel is fine.
- The first line with the column names must stay as it is. The order of the
  columns does not matter, and extra columns are ignored.
- An automatic check runs on every change: it fails if a shown station has no
  usable position or a frequency that is not a number.

## What is in it now

Layer `ira`: ÍRA's voice and digital repeaters, from
<https://www.ira.is/endurvarpar/> and the ÍRA annual report 2026. Nine are
shown. Antenna heights are not published anywhere, and antenna types for only
two, so most of those are the assumed figures above.
