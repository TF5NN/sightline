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

from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TILES = os.path.join(ROOT, "test", "tiles")
OUT = os.path.join(ROOT, "test", "ui", "out")


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


class TileHandler(Quiet):
    """Serves the test tiles the way the real storage does: byte ranges, cross-site allowed, 403 when absent."""

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Range")
        self.send_header("Access-Control-Expose-Headers", "Content-Range, Content-Length")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
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
            page.goto(url)
            page.wait_for_function("document.getElementById('status').textContent.startsWith('Done.')", timeout=30000)
            status = page.inner_text("#status")
            check("2 m data" in status, f"{name}: 2 m detail loads from a link ({status})")
            check(page.is_visible("#chart .main-svg"), f"{name}: the chart is drawn")
            distance = page.inner_text("#r-distance")
            check(distance.endswith("km") and 1.1 < float(distance.split()[0]) < 1.4, f"{name}: distance shown ({distance})")
            data = page.inner_text("#r-data")
            check("filled" in data, f"{name}: the hole is reported as filled ({data})")
            ground = page.inner_text("#r-a")
            check(ground.endswith(" m") and 150 < float(ground.split()[0]) < 400, f"{name}: ground height is above sea level, not above the ellipsoid ({ground})")
            page.screenshot(path=os.path.join(OUT, f"{name}-profile.png"), full_page=True)

            # Hovering the chart shows a readout and a dot on the map.
            box = page.locator("#chart .nsewdrag").bounding_box()
            page.mouse.move(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.5)
            page.wait_for_function("document.getElementById('readout').textContent.includes('from A')", timeout=5000)
            check(True, f"{name}: hover readout ({page.inner_text('#readout')})")

            # Stay-on-10-m switch.
            page.check("#fast")
            page.wait_for_function("document.getElementById('status').textContent.startsWith('Showing 10 m data')", timeout=15000)
            check("10 m draft" in page.inner_text("#r-data"), f"{name}: the 10 m switch works")
            check("fast=1" in page.url, f"{name}: the switch is kept in the page address")

            # Clear, then place two points by clicking the map (outside the test tiles: no data).
            page.click("#clear")
            check(page.is_hidden("#chart"), f"{name}: Clear removes the profile")
            page.uncheck("#fast")
            page.evaluate("sightline.map.setView([62, -30], 9, { animate: false })")  # open ocean
            mbox = page.locator("#map").bounding_box()
            page.mouse.click(mbox["x"] + mbox["width"] * 0.3, mbox["y"] + mbox["height"] * 0.4)
            page.mouse.click(mbox["x"] + mbox["width"] * 0.7, mbox["y"] + mbox["height"] * 0.6)
            page.wait_for_function("/No terrain|Done\\.|Could not|Showing/.test(document.getElementById('status').textContent)", timeout=20000)
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
