"""Opens the app in a real (headless) Chrome and checks that it works end to end.

It serves the app on one address and the small test terrain tiles on another.
Because the two addresses differ, the browser applies the same cross-site
rules it applies to the real ArcticDEM storage, so this also proves the
"read part of a file from another site" mechanism works.

Run:  python3 test/ui/check.py            (needs: pip install playwright, and Chrome)
Screenshots are written to test/ui/out/.
"""
import functools
import http.server
import json
import os
import sys
import threading
import time

from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TILES = os.path.join(ROOT, "test", "tiles")
OUT = os.path.join(ROOT, "test", "ui", "out")

# The page's fonts come from Google Fonts, which a test machine may not reach; then the browser
# falls back to Arial and widths are slightly off. Point SIGHTLINE_FONTS at a folder holding
# node_modules/@fontsource-variable/dm-sans and node_modules/@fontsource/ibm-plex-mono
# (npm install them there) and the real fonts are used instead.
FONTS = os.environ.get("SIGHTLINE_FONTS")
FONT_FILES = {
    "dm-sans.woff2": "node_modules/@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2",
    "plex-400.woff2": "node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2",
    "plex-500.woff2": "node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2",
}
FAKE_LAYERS = """
export async function openTerrain() {
  return {
    sight: async ({ to }) => ({
      distanceMetres: 31000, bearingDegrees: 200, worstAtMetres: 12000, angleDegrees: 1,
      clearanceMetres: Math.abs(to.lat - 63.97639) < 0.001 ? 120 : Math.abs(to.lat - 64.129) < 0.001 ? -20 : -500,
    }),
  };
}
"""
FONT_CSS = """
@font-face { font-family: 'DM Sans'; font-weight: 100 1000; src: url(https://fonts.test/dm-sans.woff2) format('woff2'); }
@font-face { font-family: 'IBM Plex Mono'; font-weight: 400; src: url(https://fonts.test/plex-400.woff2) format('woff2'); }
@font-face { font-family: 'IBM Plex Mono'; font-weight: 500; src: url(https://fonts.test/plex-500.woff2) format('woff2'); }
"""


def use_real_fonts(page):
    if not FONTS:
        return
    cors = {"Access-Control-Allow-Origin": "*"}
    page.route("https://fonts.googleapis.com/**", lambda route: route.fulfill(content_type="text/css", body=FONT_CSS, headers=cors))
    page.route(
        "https://fonts.test/**",
        lambda route: route.fulfill(path=os.path.join(FONTS, FONT_FILES[route.request.url.rsplit("/", 1)[1]]), content_type="font/woff2", headers=cors),
    )


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class TileHandler(Quiet):
    """Serves the test tiles the way the real storage does: byte ranges, cross-site allowed, 403 when absent."""

    slow_2m = 0.0  # seconds to wait before answering a 2 m request (to imitate a slow connection)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Range")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        if TileHandler.slow_2m and "/2m/" in self.path:
            time.sleep(TileHandler.slow_2m)
        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            self.send_response(403)
            self.end_headers()
            return
        size = os.path.getsize(path)
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        if rng and rng.startswith("bytes="):
            a, _, b = rng[6:].partition("-")
            start = int(a)
            end = min(int(b), size - 1) if b else size - 1
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", "image/tiff")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        with open(path, "rb") as fh:
            fh.seek(start)
            self.wfile.write(fh.read(end - start + 1))


def serve(handler, directory):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(handler, directory=directory))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def main():
    os.makedirs(OUT, exist_ok=True)
    meta = json.load(open(os.path.join(TILES, "meta.json")))
    a, b = meta["hole_path"]["a"], meta["hole_path"]["b"]
    app_server, app = serve(Quiet, ROOT)
    tile_server, tiles = serve(TileHandler, TILES)
    failures = []

    def check(ok, what):
        print(("PASS  " if ok else "FAIL  ") + what)
        if not ok:
            failures.append(what)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=True)
        for name, viewport in [("desktop", {"width": 1200, "height": 900}), ("phone", {"width": 390, "height": 844})]:
            phone = name == "phone"
            page = browser.new_page(viewport=viewport, has_touch=phone, is_mobile=phone)
            use_real_fonts(page)
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            # Real script errors only. Missing terrain tiles (403 from the tile server) are normal:
            # that is how the app learns there is no data somewhere. Map pictures and fonts come
            # from the internet, which this test machine may not reach.
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
            page.on("response", lambda r: errors.append(f"{r.status} {r.url}") if r.status >= 400 and r.url.startswith(app) else None)

            # The terrain layers for "which stations are in sight" come from another site. Here a
            # stand-in answers instead: Bláfjöll is in sight, Perlan is marginal, the rest are blocked.
            page.route("**/tf5nn.github.io/terrain/**", lambda route: route.fulfill(
                content_type="text/javascript", headers={"access-control-allow-origin": "*"}, body=FAKE_LAYERS))

            url = f"{app}/index.html?terrain={tiles}#a={a['lat']:.5f},{a['lon']:.5f}&b={b['lat']:.5f},{b['lon']:.5f}"
            status_is = lambda pattern: f"/{pattern}/.test(document.getElementById('status').textContent)"
            page.goto(url)
            page.wait_for_function(status_is("^Done\\."), timeout=30000)
            status = page.inner_text("#status")
            check("2 m data on" in status, f"{name}: 2 m detail loads from a link ({status})")
            check("filled from coarser data" in status, f"{name}: the hole is reported as filled")
            check(page.is_visible("#chart .main-svg"), f"{name}: the chart is drawn")

            # The opening view is bare: profile and line of sight, no verdict, no Fresnel zone.
            traces = "document.getElementById('chart').data.length"
            bare_traces = page.evaluate(traces)
            check(page.is_hidden("#link-panel") and page.is_hidden("#r-verdict"), f"{name}: no link verdict in the opening view")
            check(page.is_hidden("#legend-fresnel"), f"{name}: no Fresnel zone in the opening view")
            amber_lines = "Object.keys(sightline.map._layers).filter((k) => sightline.map._layers[k].options?.color === '#d98a00').length"
            check(page.evaluate(amber_lines) == 0 and page.is_hidden("#legend-grazing"), f"{name}: no amber in the opening view")
            check(page.is_visible("#height-a") and page.is_visible("#link-toggle"), f"{name}: antenna heights and the link button are there")
            check("link=1" not in page.url, f"{name}: the bare view is what a shared link opens too")
            blocked_lines = "Object.keys(sightline.map._layers).filter((k) => sightline.map._layers[k].options?.color === '#c0392b').length"
            check(page.evaluate(blocked_lines) > 0, f"{name}: the blocked stretch is drawn red on the map")
            page.screenshot(path=os.path.join(OUT, f"{name}-bare.png"), full_page=True)

            # Hovering the chart shows the real ground height and where the ground is against the line of sight.
            page.locator("#chart").scroll_into_view_if_needed()
            box = page.locator("#chart .nsewdrag").bounding_box()
            page.mouse.move(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.5)
            page.wait_for_function("document.getElementById('readout').textContent.includes('· ground')", timeout=5000)
            readout = page.inner_text("#readout")
            ground = float(readout.split("ground ")[1].split(" m")[0])
            check(150 < ground < 400, f"{name}: hover readout, ground above sea level not above the ellipsoid ({readout})")
            check("above the line of sight" in readout and "Fresnel" not in readout, f"{name}: the hill is above the line of sight, no Fresnel talk")
            page.mouse.move(5, 5)

            # The page must never be wider than the screen (no sideways scrolling), banner included.
            wider = "document.documentElement.scrollWidth - document.documentElement.clientWidth"
            check(page.evaluate(wider) <= 0, f"{name}: nothing sticks out sideways ({page.evaluate(wider)} px)")
            check(page.is_visible(".brand-icon svg") and "SIGHTLINE" in page.inner_text(".brand h1"), f"{name}: the family banner is there")
            gap = page.evaluate("document.querySelector('.header-right').getBoundingClientRect().left - document.querySelector('.brand').getBoundingClientRect().right")
            check(gap >= 4, f"{name}: the banner name and links do not collide ({gap:.0f} px apart)")
            if phone:
                # A finger: tap the profile and the reading appears and stays after the finger lifts.
                page.locator("#chart").scroll_into_view_if_needed()
                box = page.locator("#chart .nsewdrag").bounding_box()
                page.touchscreen.tap(box["x"] + box["width"] * 0.25, box["y"] + box["height"] * 0.5)
                page.wait_for_function("document.getElementById('readout').textContent.includes('· ground')", timeout=5000)
                page.wait_for_timeout(300)
                reading = page.inner_text("#readout")
                check("· ground" in reading and page.is_visible("#chart .chart-cursor"), f"{name}: a tap reads the profile and the reading stays ({reading})")
                for width in (360, 320):
                    page.set_viewport_size({"width": width, "height": 740})
                    page.wait_for_timeout(400)
                    check(page.evaluate(wider) <= 0, f"{name}: fits a {width} px wide screen ({page.evaluate(wider)} px over)")
                    gap = page.evaluate("document.querySelector('.header-right').getBoundingClientRect().left - document.querySelector('.brand').getBoundingClientRect().right")
                    check(gap >= 4, f"{name}: the banner name and links do not collide at {width} px ({gap:.0f} px apart)")
                    page.screenshot(path=os.path.join(OUT, f"phone-{width}.png"), clip={"x": 0, "y": 0, "width": width, "height": 90})
                page.set_viewport_size(viewport)
                page.wait_for_timeout(400)

            # Satellite background: chosen in the corner of the map, kept in the address, and there again after a reload.
            sat_on = "sightline.map.hasLayer(Object.values(sightline.map._layers).find((l) => l._url && l._url.includes('eox')) ?? {})"
            check(not page.evaluate(sat_on), f"{name}: the map opens on the ordinary map")
            page.evaluate("document.querySelectorAll('.leaflet-control-layers-base input')[1].click()")
            page.wait_for_function(sat_on, timeout=5000)
            check("bg=sat" in page.url, f"{name}: the satellite choice is kept in the page address")
            if not phone:
                # Share copies a link that holds everything.
                page.context.grant_permissions(["clipboard-read", "clipboard-write"])
                page.click("#share")
                page.wait_for_function("document.getElementById('share').textContent === 'Link copied'", timeout=5000)
                copied = page.evaluate("navigator.clipboard.readText()")
                check(copied == page.url and "bg=sat" in copied and "a=" in copied and "band=2m" in copied, f"{name}: Share copies the full link")
                page.goto("about:blank")
                page.goto(copied)
                page.wait_for_function(status_is("^Done\\."), timeout=30000)
                check(page.evaluate(sat_on) and page.is_visible("#chart .main-svg"), f"{name}: the shared link opens the same path on the satellite picture")
            page.screenshot(path=os.path.join(OUT, f"{name}-sat.png"))
            page.evaluate("document.querySelectorAll('.leaflet-control-layers-base input')[0].click()")
            page.wait_for_function(f"!({sat_on})", timeout=5000)
            check("bg=sat" not in page.url, f"{name}: back on the ordinary map")

            # "Estimate radio link" opens the radio part, on the 2 m band with a 5 W handheld and rubber duck.
            page.click("#link-toggle")
            page.wait_for_selector("#link-panel", state="visible")
            check(page.input_value("#band") == "2m" and page.input_value("#radio-a") == "ht5w" and page.input_value("#antenna-a") == "duck",
                  f"{name}: opens on 2 m, 5 W handheld, rubber duck")
            check(page.is_hidden("#radio-b") and page.is_hidden("#antenna-b"), f"{name}: one station choice while both ends are the same")
            distance = page.inner_text("#r-distance")
            check(distance.endswith("km") and 1.1 < float(distance.split()[0]) < 1.4, f"{name}: distance shown ({distance})")
            check(page.inner_text("#r-diffraction") != "none", f"{name}: terrain loss is reported ({page.inner_text('#r-diffraction')})")
            check(page.inner_text("#r-verdict") in ("Solid", "Good", "Marginal", "Unlikely"), f"{name}: a verdict is shown ({page.inner_text('#r-verdict')}, margin {page.inner_text('#r-margin')})")
            check("link=1" in page.url and "band=2m" in page.url, f"{name}: the open panel and the band are kept in the page address")
            check(page.inner_text("#link-toggle") == "Hide radio link", f"{name}: the button now hides the panel")

            # With the radio part open the Fresnel zone is drawn and grazing stretches turn amber, on the chart and the map.
            link_traces = page.evaluate(traces)
            check(link_traces > bare_traces and page.is_visible("#legend-fresnel") and page.is_checked("#fresnel"),
                  f"{name}: opening the radio part shows the Fresnel zone")
            check(page.evaluate(amber_lines) > 0 and page.is_visible("#legend-grazing"), f"{name}: grazing stretches are amber on the map")
            key_gap = page.evaluate("(() => { const e = document.getElementById('legend-grazing'); const k = e.querySelector('.key').getBoundingClientRect(); const r = document.createRange(); r.selectNodeContents(e.lastChild); return r.getBoundingClientRect().left - k.right; })()")
            check(key_gap >= 4, f"{name}: legend keys stand clear of their labels ({key_gap:.0f} px)")
            page.screenshot(path=os.path.join(OUT, f"{name}-link.png"), full_page=True)
            page.uncheck("#fresnel")
            page.wait_for_function(f"{traces} < {link_traces}", timeout=5000)
            check(page.is_hidden("#legend-fresnel") and "fz=0" in page.url, f"{name}: the Fresnel zone can be switched off, and that is kept in the address")
            page.check("#fresnel")
            page.wait_for_function(f"{traces} === {link_traces}", timeout=5000)
            page.click("#link-toggle")
            check(page.evaluate(amber_lines) == 0 and page.is_hidden("#legend-fresnel"), f"{name}: hiding the radio part takes the amber and the Fresnel zone away again")
            page.click("#link-toggle")

            # Raising both masts clears the hill; the terrain loss goes away.
            margin_before = page.inner_text("#r-margin")
            page.fill("#height-a", "80")
            page.fill("#height-b", "80")
            page.wait_for_function("document.getElementById('r-diffraction').textContent === 'none'", timeout=15000)
            check(page.evaluate(blocked_lines) == 0, f"{name}: 80 m masts clear the hill (margin {margin_before} -> {page.inner_text('#r-margin')})")
            page.screenshot(path=os.path.join(OUT, f"{name}-clear.png"), full_page=True)

            # The band decides which radios and antennas are on offer.
            options = lambda sel: page.eval_on_selector_all(f"{sel} option", "nodes => nodes.map((n) => n.value)")
            check("meshcore" not in options("#radio-a") and "yagi3" in options("#antenna-a") and "yagi7" not in options("#antenna-a"),
                  f"{name}: 2 m band offers 2 m radios and antennas only")
            fsl_vhf = float(page.inner_text("#r-fsl").split()[0])
            page.select_option("#band", "lora868")
            page.wait_for_function(f"parseFloat(document.getElementById('r-fsl').textContent) > {fsl_vhf + 10}", timeout=15000)
            fsl_lora = float(page.inner_text("#r-fsl").split()[0])
            check(abs((fsl_lora - fsl_vhf) - 15.5) < 0.3, f"{name}: switching to 868 MHz adds 15.5 dB of free-space loss ({fsl_vhf} -> {fsl_lora} dB)")
            check(options("#radio-a") == ["meshcore", "meshtastic"] and "duck" not in options("#antenna-a"),
                  f"{name}: 868 MHz offers the mesh radios and 868 antennas only")
            check(page.input_value("#height-a") == "80", f"{name}: the antenna heights survive a band change")

            # Advanced: the numbers behind the lists.
            page.click("#advanced summary")
            check(page.is_visible("#sf") and page.is_disabled("#sens-a"), f"{name}: LoRa boxes show for a LoRa radio")
            check(page.input_value("#sens-a") == "-130", f"{name}: MeshCore narrow sensitivity is -130 dBm ({page.input_value('#sens-a')})")
            page.select_option("#sf", "12")
            page.wait_for_function("document.getElementById('sens-a').value === '-140'", timeout=5000)
            check(True, f"{name}: spreading factor 12 moves the sensitivity to -140 dBm")
            page.select_option("#radio-a", "meshtastic")
            page.wait_for_function("document.getElementById('sf').value === '11'", timeout=5000)
            check(page.input_value("#freq") == "869.525", f"{name}: picking a radio from the list puts its own figures back")
            page.select_option("#band", "2m")
            page.wait_for_function("document.getElementById('freq').value === '145.5'", timeout=5000)
            check(page.is_hidden("#sf") and page.is_enabled("#sens-a"), f"{name}: LoRa boxes are hidden for an FM radio")
            page.select_option("#power-unit", "dBm")
            check(abs(float(page.input_value("#power-a")) - 37.0) < 0.05, f"{name}: 5 W shows as 37 dBm ({page.input_value('#power-a')})")
            page.select_option("#power-unit", "W")
            page.fill("#freq", "-5")
            check("invalid" in (page.get_attribute("#freq", "class") or ""), f"{name}: an impossible frequency is flagged, not used")
            page.fill("#freq", "145.5")
            page.wait_for_function(f"document.getElementById('r-fsl').textContent === '{fsl_vhf} dB'", timeout=15000)

            # A different station at each end: a yagi at B only helps, and the weaker direction is the one judged.
            margin_same = float(page.inner_text("#r-margin").split()[0].replace("−", "-"))
            page.check("#split")
            page.wait_for_selector("#radio-b", state="visible")
            check(page.input_value("#antenna-b") == "duck" and page.text_content("#radio-a-label") == "Radio at A",
                  f"{name}: the split starts as a copy of A")
            page.select_option("#antenna-b", "yagi3")
            page.wait_for_function(f"parseFloat(document.getElementById('r-margin').textContent.replace('−', '-')) > {margin_same + 5}", timeout=15000)
            margin_yagi = float(page.inner_text("#r-margin").split()[0].replace("−", "-"))
            check(abs((margin_yagi - margin_same) - 9.5) < 0.2, f"{name}: a 3-element yagi at B is worth 9.5 dB over the duck ({margin_same} -> {margin_yagi})")
            check("split=1" in page.url and "ab=yagi3" in page.url, f"{name}: the two stations are kept in the page address")
            page.select_option("#radio-b", "mobile50w")
            page.wait_for_function("document.getElementById('link-note').textContent.includes('weaker direction')", timeout=15000)
            check("A to B" in page.inner_text("#link-note"), f"{name}: 5 W into 50 W is judged on the 5 W direction ({page.inner_text('#link-note')})")
            page.click("#swap")
            page.wait_for_function(status_is("^Done\\."), timeout=30000)
            check(page.input_value("#radio-a") == "mobile50w" and page.input_value("#antenna-a") == "yagi3" and page.input_value("#antenna-b") == "duck",
                  f"{name}: Swap takes each station with its point")
            page.uncheck("#split")
            page.wait_for_selector("#radio-b", state="hidden")
            check(True, f"{name}: switching the split off ties both ends together again")
            page.wait_for_function("!document.getElementById('link-note').textContent.includes('weaker direction')", timeout=15000)

            # A band outside amateur radio: FM broadcast starts with a transmitter at A and a receiver at B, one way.
            page.select_option("#band", "fmbc")
            page.wait_for_function("document.getElementById('link-note').textContent.includes('One way only, A to B')", timeout=15000)
            check(page.is_checked("#split") and page.input_value("#radio-a") == "bctx1k" and page.input_value("#radio-b") == "fmrx",
                  f"{name}: FM broadcast starts as transmitter and receiver")
            check(page.inner_text("#r-verdict") in ("Solid", "Good", "Marginal", "Unlikely") and "Infinity" not in page.inner_text("#results"),
                  f"{name}: a one-way link still gets a verdict ({page.inner_text('#r-verdict')}, {page.inner_text('#r-margin')})")
            check(len(options("#band")) == 10, f"{name}: ten bands on offer")
            page.select_option("#band", "2m")
            page.wait_for_function("!document.getElementById('link-note').textContent.includes('One way only')", timeout=15000)
            check(not page.is_checked("#split") and page.input_value("#radio-a") == "ht5w", f"{name}: back on 2 m both ends are one station again")

            # Links shared from the earlier version still open, with the same numbers and the panel showing.
            old = f"{app}/index.html?terrain={tiles}#a={a['lat']:.5f},{a['lon']:.5f}&b={b['lat']:.5f},{b['lon']:.5f}&preset=meshcore&f=869.618&p=0.158&ha=2&hb=2&ga=2&gb=2&ca=0&cb=0&sf=8&bw=62.5"
            page.goto(old)
            page.reload()
            page.wait_for_function(status_is("^Done\\."), timeout=30000)
            check(page.is_visible("#link-panel") and page.is_visible("#legend-fresnel"), f"{name}: an old shared link opens with the link panel and Fresnel zone")
            check(page.input_value("#band") == "lora868" and page.input_value("#radio-a") == "meshcore" and page.input_value("#freq") == "869.618"
                  and page.input_value("#gain-a") == "2" and page.input_value("#sens-a") == "-130",
                  f"{name}: an old shared link keeps its numbers")

            # The 2 m detail must still load when the pointer is resting on the draft chart.
            # (A real bug: while redrawing, the chart re-sent a "hover" to a listener that
            # still held the shorter draft profile, and the load was reported as failed.)
            TileHandler.slow_2m = 0.5
            page.goto(url)
            page.reload()
            page.wait_for_function(status_is("^Loading 2 m"), timeout=15000)
            page.locator("#chart").scroll_into_view_if_needed()
            box = page.locator("#chart .nsewdrag").bounding_box()
            page.mouse.move(box["x"] + box["width"] * 0.90, box["y"] + box["height"] * 0.5)
            page.mouse.move(box["x"] + box["width"] * 0.95, box["y"] + box["height"] * 0.5)
            page.wait_for_function(status_is("^Done\\.|went wrong"), timeout=30000)
            TileHandler.slow_2m = 0.0
            status = page.inner_text("#status")
            check(status.startswith("Done."), f"{name}: detail loads with the pointer on the draft chart ({status})")

            # Terrain detail choices under Advanced.
            page.click("#link-toggle")
            page.click("#advanced summary")
            page.select_option("#detail", "10m")
            page.wait_for_function(status_is("^Done, on 10 m data only"), timeout=15000)
            check("detail=10m" in page.url, f"{name}: 10 m only works and is kept in the page address")
            page.select_option("#detail", "full")
            page.wait_for_function(status_is("^Done\\. .*2 m data on"), timeout=15000)
            check(True, f"{name}: full 2 m works ({page.inner_text('#status')})")
            page.select_option("#detail", "smart")
            page.wait_for_function(status_is("^Done\\."), timeout=15000)

            # Clear, then place two points by clicking the map (out at sea: no data).
            page.click("#clear")
            check(page.is_hidden("#chart"), f"{name}: Clear removes the profile")
            page.evaluate("sightline.map.setView([62, -30], 9, { animate: false })")  # open ocean
            page.locator("#map").scroll_into_view_if_needed()
            mbox = page.locator("#map").bounding_box()
            page.mouse.click(mbox["x"] + mbox["width"] * 0.3, mbox["y"] + mbox["height"] * 0.4)
            page.mouse.click(mbox["x"] + mbox["width"] * 0.7, mbox["y"] + mbox["height"] * 0.6)
            page.wait_for_function(status_is("No terrain|^Done|Could not|went wrong"), timeout=20000)
            status = page.inner_text("#status")
            check("No terrain data" in status, f"{name}: a path with no data says so ({status})")
            check("#a=" in page.url and "&b=" in page.url, f"{name}: clicked points are written to the page address")

            # The batch check page works a small made-up list through the same sums.
            if not phone:
                mid = {"lat": (a["lat"] + b["lat"]) / 2, "lon": (a["lon"] + b["lon"]) / 2}
                listing = {"nodes": [{"id": "a", "name": "North", **a}, {"id": "m", "name": "Middle", **mid}, {"id": "b", "name": "South", **b}],
                           "links": [{"a": "a", "b": "m", "snr": 4.5, "count": 12}]}
                page.goto(f"{app}/batch.html?terrain={tiles}")
                page.fill("#input", json.dumps(listing))
                page.click("#run")
                page.wait_for_function("document.getElementById('log').textContent.includes('RESULT: DONE')", timeout=60000)
                report = page.inner_text("#log")
                check("3 pairs" in report and "LINKS THAT WERE MEASURED (1)" in report and "PAIRS WITH NO MEASURED LINK (2)" in report,
                      f"{name}: the batch check works through every pair")
                check("failed" not in report and "blocked" in report, f"{name}: the batch check finds the hill between the far ends")
                open(os.path.join(OUT, "batch-report.txt"), "w").write(report)

            # Station layers: off until switched on; a tap shows how to work the repeater; "Use as" fills in that end.
            page.goto(f"{app}/index.html?terrain={tiles}")
            page.reload()
            page.wait_for_function("sightline.state.stations.length > 0", timeout=10000)
            dots = "document.querySelectorAll('.station-dot').length"
            check(page.evaluate(dots) == 0, f"{name}: no stations on the map until a layer is switched on")
            overlay = "document.querySelector('.leaflet-control-layers-overlays input')"
            check("ÍRA repeaters" in page.evaluate("document.querySelector('.leaflet-control-layers-overlays').textContent"), f"{name}: the ÍRA layer is offered")
            page.evaluate(f"{overlay}.click()")
            page.wait_for_function(f"{dots} === 8", timeout=5000)
            check("layers=ira" in page.url and page.evaluate("sightline.state.stations.length") == 9,
                  f"{name}: nine ÍRA repeaters show at eight sites, and the layer is kept in the address")
            page.evaluate("sightline.map.setView([63.97639, -21.635], 11)")
            page.wait_for_timeout(400)
            page.locator("#map").scroll_into_view_if_needed()
            page.locator(".leaflet-marker-icon[title*='TF3RPB']").click()
            page.wait_for_selector(".station-popup")
            check(page.locator(".station-card").count() == 2 and "TF3RPI Bláfjöll" in page.inner_text(".station-popup"),
                  f"{name}: two repeaters on one mast share a marker and both are listed")
            page.wait_for_timeout(500)  # the map slides to make room for the popup
            card = page.locator(".station-card").first
            popup = card.inner_text()
            flat = " ".join(popup.split()).lower()
            check("tf3rpb bláfjöll" in flat and "listen 145.650 mhz" in flat and "transmit 145.050 mhz (−0.6)" in flat and "tone 88.5" in flat,
                  f"{name}: the popup says how to work the repeater")
            fits = page.evaluate("(() => { const p = document.querySelector('.leaflet-popup').getBoundingClientRect(); const m = document.getElementById('map').getBoundingClientRect(); return p.left >= m.left && p.right <= m.right; })()")
            check(fits, f"{name}: the popup fits inside the map")
            check("10 m above ground (assumed)" in " ".join(popup.split()) and "25 W" in popup, f"{name}: assumed figures are marked as assumed")
            check(card.locator(".use button").count() == 1, f"{name}: with no points yet the station can only become A")
            card.locator(".use button[data-end='a']").click()
            page.wait_for_function("sightline.state.waypoints.length === 1", timeout=5000)
            check("a=63.97639,-21.63500" in page.url and "sa=TF3RPB" in page.url, f"{name}: A sits on the repeater and the link says which")
            check("A: TF3RPB Bláfjöll · 2 m FM. Listen 145.650 MHz" in page.inner_text("#stations-line"), f"{name}: the station and its frequencies are named under the map")
            # (No terrain under these real places in the test tiles, so the settings are read directly.)
            st = page.evaluate("sightline.state.settings")
            check(st["split"] and st["a"]["radio"] == "repeater" and st["a"]["antenna"] == "collinear" and st["a"]["height"] == 10
                  and st["b"]["radio"] == "ht5w" and st["b"]["antenna"] == "duck" and st["b"]["height"] == 1.5,
                  f"{name}: the repeater end is filled in, the other end stays the handheld")
            # A 70 cm repeater as B switches the band and brings its own antenna.
            page.evaluate("sightline.map.setView([64.129, -21.9187], 12)")
            page.wait_for_timeout(400)
            page.locator("#map").scroll_into_view_if_needed()
            page.locator(".leaflet-marker-icon[title*='TF3RVK']").click()
            page.wait_for_selector(".station-popup")
            check(page.locator(".station-popup .use button").count() == 2, f"{name}: with A placed the station can become A or B")
            page.click(".station-popup .use button[data-end='b']")
            page.wait_for_function("sightline.state.waypoints.length === 2", timeout=5000)
            st = page.evaluate("sightline.state.settings")
            check(st["band"] == "70cm" and st["b"]["radio"] == "repeater" and st["b"]["antenna"] == "quarter" and "gainB" not in st["overrides"],
                  f"{name}: Perlan as B switches to 70 cm with its quarter-wave antenna")
            check("sb=TF3RVK" in page.url and "B: TF3RVK Perlan · 70 cm FM" in page.inner_text("#stations-line"), f"{name}: both stations are named")
            shared = page.url
            page.goto("about:blank")
            page.goto(shared)
            page.wait_for_function(f"{dots} === 8 && !document.getElementById('stations-line').hidden", timeout=10000)
            check("A: TF3RPB Bláfjöll" in page.inner_text("#stations-line") and page.evaluate("sightline.state.settings.b.antenna") == "quarter",
                  f"{name}: a shared link brings back the stations, the layer and the settings")
            page.screenshot(path=os.path.join(OUT, f"{name}-stations.png"), full_page=True)

            # Stations seen from A: coloured once A is placed and a layer shows, explained on the card, gone with A.
            page.goto("about:blank")
            page.goto(f"{app}/index.html?terrain={tiles}#layers=ira")
            page.wait_for_function(f"{dots} === 8", timeout=10000)
            check(page.is_hidden("#sight-line") and page.evaluate("document.querySelectorAll('.station-dot[class*=sight-]').length") == 0,
                  f"{name}: stations keep their plain look until point A is placed")
            page.evaluate("sightline.map.setView([64.2, -21.7], 9, { animate: false })")
            page.wait_for_timeout(400)
            page.locator("#map").scroll_into_view_if_needed()
            spot = page.evaluate("(() => { const q = sightline.map.latLngToContainerPoint([64.25, -21.6]); const r = document.getElementById('map').getBoundingClientRect(); return [r.x + q.x, r.y + q.y]; })()")
            page.mouse.click(*spot)
            page.wait_for_function("sightline.sightFromA.results.size === 8", timeout=10000)
            count = lambda kind: page.evaluate(f"document.querySelectorAll('.station-dot.sight-{kind}').length")
            check((count("clear"), count("marginal"), count("blocked")) == (1, 1, 6) and page.is_visible("#sight-line"),
                  f"{name}: with A placed, stations are coloured in sight, marginal or blocked, with a key under the map")
            page.evaluate("sightline.map.setView([63.97639, -21.635], 11, { animate: false })")
            page.wait_for_timeout(400)
            page.locator(".station-dot.sight-clear").click()
            page.wait_for_selector(".station-popup")
            check("In sight from A, 31 km away. The line clears the terrain by at least 120 m." in page.inner_text(".station-popup .sight-clear"),
                  f"{name}: the station's card says what was found")
            page.screenshot(path=os.path.join(OUT, f"{name}-sight.png"), full_page=True)
            page.evaluate("sightline.map.closePopup()")
            page.click("#clear")
            check(page.is_hidden("#sight-line") and page.evaluate("document.querySelectorAll('.station-dot[class*=sight-]').length") == 0,
                  f"{name}: Clear takes the colours away again")

            # The "how it works" page opens from the app and fits the screen.
            page.goto(url)
            page.wait_for_function(status_is("^Done\\."), timeout=30000)
            page.click("#about-open")
            page.click("#about a[href='how.html']")
            page.wait_for_selector("main.doc h2")
            check("how far to trust it" in page.inner_text("main.doc h2"), f"{name}: the how-it-works page opens from About")
            check(page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth") <= 0,
                  f"{name}: the how-it-works page fits the screen")
            page.screenshot(path=os.path.join(OUT, f"{name}-how.png"))

            # The test page runs against the same tiles.
            page.goto(f"{app}/step0.html?terrain={tiles}")
            page.wait_for_function("document.getElementById('log').textContent.includes('RESULT:')", timeout=30000)
            log = page.inner_text("#log")
            check("RESULT: PASS" in log, f"{name}: the data connection test passes against the test tiles")
            if name == "desktop":
                open(os.path.join(OUT, "step0-log.txt"), "w").write(log)
                page.screenshot(path=os.path.join(OUT, "step0.png"), full_page=True)
            check(not errors, f"{name}: no script errors {errors[:3] if errors else ''}")
            page.close()
        browser.close()

    app_server.shutdown()
    tile_server.shutdown()
    print()
    print("ALL PASSED" if not failures else f"{len(failures)} FAILED")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
