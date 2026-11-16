# Repeater sites

`repeaters.csv` lists Icelandic VHF/UHF repeater sites, one line per repeater:

- **F4x4**: Ferðaklúbburinn 4x4 repeaters (11)
- **Landsbjörg (SAR)**: search-and-rescue repeaters (43)
- **ÍRA**: amateur repeaters (12), plus ÍRA's APRS digipeaters (9)

Compiled November 2026.

## Sources

- ÍRA: <https://www.ira.is/endurvarpar/> and the ÍRA annual report 2026
  (section 13, repeaters as of 8 Feb 2026).
- 4x4 and SAR: repeater maps of the F4x4 communications committee, updated
  2025-10-08 (<https://www.f4x4.is/nefndir/fjarskiptanefnd/>). Red on the map
  means inactive.
- Coordinates for 4x4 and SAR sites: map dots matched to Landmælingar IS 50V
  place names and OpenStreetMap summit/mast nodes, then snapped to the highest
  Copernicus GLO-90 cell within about 1 km where no mast or summit node existed.

## Caveats

- **Antenna height above ground is not published anywhere.** The column is
  empty; fill in or use a default.
- `DEM elev.` is from the 90 m model and reads low on sharp peaks. Prefer the
  stated/OSM elevation, or read the 2 m / 10 m data at the point.
- Check `Coord confidence` and `Notes`. "Low" rows are estimated from the map
  (±10 km) or sit on a glacier/valley label.
- Gagnheiði and Oddsskarð: one of the two is marked inactive, but the map
  labels make it ambiguous which.
