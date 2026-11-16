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
            page = browser.new_page(viewport=viewport)
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            # Real script errors only. Missing terrain tiles (403 from the tile server) are normal:
            # that is how the app learns there is no data somewhere. Map pictures and fonts come
            # from the internet, which this test machine may not reach.
            page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
            page.on("response", lambda r: errors.append(f"{r.status} {r.url}") if r.status >= 400 and r.url.startswith(app) else None)

            url = f"{app}/index.html?terrain={tiles}#a={a['lat']:.5f},{a['lon']:.5f}&b={b['lat']:.5f},{b['lon']:.5f}"
            status_is = lambda pattern: f"/{pattern}/.test(document.getElementById('status').textContent)"
            page.goto(url)
            page.wait_for_function(status_is("^Done\\."), timeout=30000)
            status = page.inner_text("#status")
            check("2 m data on" in status, f"{name}: 2 m detail loads from a link ({status})")
            check("filled from coarser data" in status, f"{name}: the hole is reported as filled")
            check(page.is_visible("#chart .main-svg"), f"{name}: the chart is drawn")
            distance = page.inner_text("#r-distance")
            check(distance.endswith("km") and 1.1 < float(distance.split()[0]) < 1.4, f"{name}: distance shown ({distance})")

            # The link: a hill stands between the two points, so 2 m masts are blocked.
            check(page.inner_text("#r-path") == "Blocked", f"{name}: default 2 m masts are blocked by the hill ({page.inner_text('#r-path')})")
            check("edge" in page.inner_text("#r-diffraction"), f"{name}: terrain loss is reported ({page.inner_text('#r-diffraction')})")
            check(page.inner_text("#r-verdict") in ("Solid", "Good", "Marginal", "Unlikely"), f"{name}: a verdict is shown ({page.inner_text('#r-verdict')}, margin {page.inner_text('#r-margin')})")
            check("above the line of sight" in page.inner_text("#readout"), f"{name}: worst spot is described ({page.inner_text('#readout')})")
            check("preset=meshcore" in page.url and "f=869.618" in page.url, f"{name}: radio settings are kept in the page address")
            page.screenshot(path=os.path.join(OUT, f"{name}-blocked.png"), full_page=True)

            # Hovering the chart shows the real ground height and the clearance.
            page.locator("#chart").scroll_into_view_if_needed()
            box = page.locator("#chart .nsewdrag").bounding_box()
            page.mouse.move(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.5)
            page.wait_for_function("document.getElementById('readout').textContent.includes('· ground')", timeout=5000)
            readout = page.inner_text("#readout")
            ground = float(readout.split("ground ")[1].split(" m")[0])
            check(150 < ground < 400, f"{name}: hover readout, ground above sea level not above the ellipsoid ({readout})")
            page.mouse.move(5, 5)

            # Raising both masts clears the hill; the terrain loss goes away.
            margin_before = page.inner_text("#r-margin")
            page.fill("#height-a", "80")
            page.fill("#height-b", "80")
            page.wait_for_function("document.getElementById('r-path').textContent === 'Clear'", timeout=15000)
            check(page.inner_text("#r-diffraction") == "none", f"{name}: 80 m masts clear the hill (margin {margin_before} -> {page.inner_text('#r-margin')})")
            page.screenshot(path=os.path.join(OUT, f"{name}-clear.png"), full_page=True)

            # Changing the setup changes the sums: 2 m band has about 15.5 dB less free-space loss.
            fsl_lora = float(page.inner_text("#r-fsl").split()[0])
            page.select_option("#preset", "fm2m")
            page.wait_for_function(f"parseFloat(document.getElementById('r-fsl').textContent) < {fsl_lora - 10}", timeout=15000)
            fsl_vhf = float(page.inner_text("#r-fsl").split()[0])
            check(abs((fsl_lora - fsl_vhf) - 15.5) < 0.3, f"{name}: switching to the 2 m band preset ({fsl_lora} -> {fsl_vhf} dB)")
            check(page.is_hidden("#sf") and page.is_enabled("#sens"), f"{name}: LoRa boxes are hidden for an FM setup")
            page.select_option("#power-unit", "dBm")
            check(abs(float(page.input_value("#power")) - 37.0) < 0.05, f"{name}: 5 W shows as 37 dBm ({page.input_value('#power')})")
            page.select_option("#preset", "meshcore")
            page.wait_for_function("document.getElementById('sens').value === '-130'", timeout=5000)
            page.select_option("#sf", "12")
            page.wait_for_function("document.getElementById('sens').value === '-140'", timeout=5000)
            check(True, f"{name}: spreading factor 12 moves the sensitivity to -140 dBm")
            page.fill("#freq", "-5")
            check("invalid" in (page.get_attribute("#freq", "class") or ""), f"{name}: an impossible frequency is flagged, not used")
            page.fill("#freq", "869.618")

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
            mbox = page.locator("#map").bounding_box()
            page.mouse.click(mbox["x"] + mbox["width"] * 0.3, mbox["y"] + mbox["height"] * 0.4)
            page.mouse.click(mbox["x"] + mbox["width"] * 0.7, mbox["y"] + mbox["height"] * 0.6)
            page.wait_for_function(status_is("No terrain|^Done|Could not|went wrong"), timeout=20000)
            status = page.inner_text("#status")
            check("No terrain data" in status, f"{name}: a path with no data says so ({status})")
            check("#a=" in page.url and "&b=" in page.url, f"{name}: clicked points are written to the page address")

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
