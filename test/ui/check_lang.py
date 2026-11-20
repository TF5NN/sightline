"""Checks the two languages in a real (headless) Chrome: English and Icelandic.

It opens the app the way the TF5NN main site links to it (?lang=is), looks for
English left over on the Icelandic page, presses the EN / IS switch both ways,
and checks the banner still fits a phone. Uses the same small test tiles and
stand-ins as check.py.

Run:  python3 test/ui/check_lang.py        (needs: pip install playwright, and Chrome)
Screenshots are written to test/ui/out/.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
from check import FAKE_LAYERS, OUT, ROOT, TILES, Quiet, TileHandler, serve, use_real_fonts  # noqa: E402
from playwright.sync_api import sync_playwright  # noqa: E402

# Words that give away English on a page meant to be Icelandic ("of" is left out: in Icelandic
# it means "too", as in "of nærri"). Names (Sightline, ArcticDEM,
# OpenStreetMap, Polar Geospatial Center, GitHub) do not contain any of them.
ENGLISH = re.compile(
    r"\b(the|and|to|from|with|is|are|on|at|Map|Satellite|Done|Share|Clear|Antenna|Radio|Height|Margin|"
    r"Distance|Power|Band|ground|Loading|Reading|Look|Swap|About|samples|data|Use as)\b"
)

# Every bit of text a visitor can see, attributes for buttons included.
VISIBLE_TEXT = """() => {
  const seen = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.textContent.trim();
    const parent = node.parentElement;
    if (!text || !parent || parent.closest('script, style, svg.leaflet-zoom-animated, .leaflet-control-attribution')) continue;
    if (parent.closest('[lang="en"]')) continue; // marked as English on purpose (the credits, a note only in English)
    const box = parent.getBoundingClientRect();
    if (box.width === 0 || box.height === 0 || getComputedStyle(parent).visibility === 'hidden') continue;
    seen.push(text);
  }
  for (const node of document.querySelectorAll('[title], [aria-label]')) {
    const box = node.getBoundingClientRect();
    if (box.width === 0 || box.height === 0 || node.closest('.leaflet-control-zoom, .leaflet-control-attribution')) continue;
    for (const name of ['title', 'aria-label']) if (node.getAttribute(name)) seen.push(node.getAttribute(name));
  }
  return seen;
}"""


def text(page, selector):
    """The words in an element as written, before the style puts any of them in capitals."""
    return " ".join(page.evaluate(f"document.querySelector({json.dumps(selector)}).textContent").split())


def leftovers(page):
    return sorted({text for text in page.evaluate(VISIBLE_TEXT) if ENGLISH.search(text)})


def main():
    os.makedirs(OUT, exist_ok=True)
    meta = json.load(open(os.path.join(TILES, "meta.json")))
    a, b = meta["hole_path"]["a"], meta["hole_path"]["b"]
    _, app = serve(Quiet, ROOT)
    _, tiles = serve(TileHandler, TILES)
    failures = []

    def check(ok, what):
        print(("PASS  " if ok else "FAIL  ") + what)
        if not ok:
            failures.append(what)

    path = f"#a={a['lat']:.5f},{a['lon']:.5f}&b={b['lat']:.5f},{b['lon']:.5f}"
    status_is = lambda pattern: f"/{pattern}/.test(document.getElementById('status').textContent)"

    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=True)
        for name, viewport in [("desktop", {"width": 1200, "height": 900}), ("phone", {"width": 390, "height": 844})]:
            phone = name == "phone"
            context = browser.new_context(viewport=viewport, has_touch=phone, is_mobile=phone, locale="en-GB")
            page = context.new_page()
            use_real_fonts(page)
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("console", lambda m: errors.append(m.text) if m.type in ("error", "warning") and "Failed to load resource" not in m.text and "terrain layers" not in m.text else None)
            page.route("**/tf5nn.github.io/terrain/**", lambda route: route.fulfill(
                content_type="text/javascript", headers={"access-control-allow-origin": "*"}, body=FAKE_LAYERS))

            # --- arriving from the main site's Icelandic side --------------------------------------
            page.goto(f"{app}/index.html?lang=is&terrain={tiles}{path}")
            page.wait_for_function(status_is("^Lokið\\."), timeout=30000)
            check(page.evaluate("document.documentElement.lang") == "is", f"{name}: ?lang=is opens the app in Icelandic")
            check("lang=" not in page.url and "terrain=" in page.url and "#a=" in page.url,
                  f"{name}: ?lang is taken out of the address, the rest stays ({page.url.split('?')[1][:40]}…)")
            check(page.evaluate("localStorage.getItem('tf5nn-lang')") == "is", f"{name}: the choice is remembered")
            check(page.get_attribute(".lang-switch [data-lang='is']", "aria-pressed") == "true", f"{name}: IS shows as chosen")
            status = page.inner_text("#status")
            check("2 m gögn á" in status and "fylltir úr grófari gögnum" in status, f"{name}: the result line is in Icelandic ({status})")
            check(text(page, "#link-toggle") == "Meta radíósamband", f"{name}: the link button is in Icelandic")
            axis = page.evaluate("document.getElementById('chart').layout.xaxis.title.text")
            check(axis == "Fjarlægð frá A (km)", f"{name}: the chart is in Icelandic ({axis})")
            left = leftovers(page)
            check(not left, f"{name}: no English left in the opening view {left}")

            page.locator("#chart").scroll_into_view_if_needed()
            box = page.locator("#chart .nsewdrag").bounding_box()
            if phone:
                page.touchscreen.tap(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.5)
            else:
                page.mouse.move(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.5)
            page.wait_for_function("document.getElementById('readout').textContent.includes('landhæð')", timeout=5000)
            check("frá A · landhæð" in page.inner_text("#readout"), f"{name}: reading the profile is in Icelandic ({page.inner_text('#readout')})")
            if not phone:
                page.mouse.move(5, 5)

            # The radio side, with the two ends different and Advanced open.
            page.click("#link-toggle")
            page.check("#split")
            page.click("#advanced summary")
            page.wait_for_timeout(400)
            check(text(page, "#r-verdict") in ("Traust", "Gott", "Tæpt", "Ólíklegt"), f"{name}: the verdict is in Icelandic ({page.inner_text('#r-verdict')})")
            check(text(page, "#radio-a-label") == "Tæki í A", f"{name}: the ends are named in Icelandic")
            left = leftovers(page)
            check(not left, f"{name}: no English left with the radio side open {left}")
            page.screenshot(path=os.path.join(OUT, f"{name}-is.png"), full_page=True)

            # --- the switch ----------------------------------------------------------------------
            page.locator(".lang-switch").scroll_into_view_if_needed()
            page.click(".lang-switch [data-lang='en']")
            page.wait_for_timeout(300)
            check(page.evaluate("document.documentElement.lang") == "en", f"{name}: EN switches to English")
            check(page.inner_text("#status").startswith("Done."), f"{name}: the result line follows ({page.inner_text('#status')[:30]}…)")
            check(text(page, "#radio-a-label") == "Radio at A" and text(page, "#link-toggle") == "Hide radio link",
                  f"{name}: the radio side follows")
            check(page.evaluate("document.getElementById('chart').layout.xaxis.title.text") == "Distance from A (km)", f"{name}: the chart follows")
            check(page.evaluate("localStorage.getItem('tf5nn-lang')") == "en", f"{name}: the new choice is remembered")
            check("Satellite" in text(page, ".leaflet-control-layers"), f"{name}: the map's layer names follow")
            check(page.get_attribute(".callsign.home", "href") == "https://tf5nn.github.io/", f"{name}: the TF5NN link goes to the English site")
            page.click(".lang-switch [data-lang='is']")
            page.wait_for_timeout(300)
            check(page.get_attribute(".callsign.home", "href") == "https://tf5nn.github.io/is/", f"{name}: in Icelandic the TF5NN link goes to the Icelandic site")
            check(page.get_attribute(".theme-toggle", "aria-label").startswith("Skipta yfir í"), f"{name}: the theme button's label follows")
            left = leftovers(page)
            check(not left, f"{name}: and back in Icelandic, no English left {left}")

            # --- a repeater's card ---------------------------------------------------------------
            page.click("#clear")
            overlays = "document.querySelector('.leaflet-control-layers-overlays')"
            page.wait_for_function("sightline.state.stations.length > 0", timeout=10000)
            check("Endurvarpar ÍRA" in page.evaluate(f"{overlays}.textContent"), f"{name}: the station layer is named in Icelandic")
            page.evaluate(f"{overlays}.querySelector('input').click()")
            page.wait_for_function("document.querySelectorAll('.station-dot').length > 0", timeout=5000)
            page.evaluate("sightline.map.setView([63.97639, -21.635], 11)")
            page.wait_for_timeout(400)
            page.locator("#map").scroll_into_view_if_needed()
            page.locator(".leaflet-marker-icon[title*='TF3RPB']").click()
            page.wait_for_selector(".station-popup")
            page.wait_for_timeout(500)
            card = text(page, ".station-popup")
            check("Hlusta" in card and "Senda" in card and "yfir jörðu" in card and "Nota sem A" in card, f"{name}: a repeater's card is in Icelandic")
            check("Tengdur á 70 cm við TF2RPJ" in card or "ISAVIA-húsinu" in card, f"{name}: its notes are in Icelandic too")
            page.screenshot(path=os.path.join(OUT, f"{name}-is-station.png"))

            # --- how it works ------------------------------------------------------------------
            page.goto(f"{app}/how.html")
            page.wait_for_selector("html.i18n-ready")
            check(page.is_visible("main[data-only='is']") and page.is_hidden("main[data-only='en']"), f"{name}: How it works opens in Icelandic, from the remembered choice")
            check(text(page, ".header .callsign") == "Aftur í forritið", f"{name}: its banner is in Icelandic")
            left = leftovers(page)
            check(not left, f"{name}: no English on How it works {left}")
            page.screenshot(path=os.path.join(OUT, f"{name}-is-how.png"), full_page=True)
            page.click(".lang-switch [data-lang='en']")
            check(page.is_visible("main[data-only='en']") and page.title().startswith("Sightline: how it works"), f"{name}: and switches to English")
            page.click(".lang-switch [data-lang='is']")

            # --- the banner on narrow phones, in Icelandic -----------------------------------------
            if phone:
                for language in ("is", "en"):
                    page.goto(f"{app}/index.html?lang={language}")
                    page.wait_for_selector("html.i18n-ready")
                    for width in (520, 390, 360, 320):
                        page.set_viewport_size({"width": width, "height": 800})
                        page.wait_for_timeout(200)
                        wider = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
                        # Measured to the end of the text, which can run on past the name's box (the tagline does not wrap).
                        gap = page.evaluate("(() => { const b = document.querySelector('.brand'); return document.querySelector('.header-right').getBoundingClientRect().left - (b.getBoundingClientRect().left + b.scrollWidth); })()")
                        check(wider <= 0 and gap >= 4, f"{name}: in {language} at {width} px the banner fits ({gap:.0f} px between name and links, {wider} px sideways)")
                        page.screenshot(path=os.path.join(OUT, f"phone-{width}-{language}-banner.png"), clip={"x": 0, "y": 0, "width": width, "height": 90})

            check(not errors, f"{name}: no script errors {errors[:3]}")
            context.close()

        # --- first visit, nothing remembered: the browser's own language decides -------------------
        for locale, wanted in [("is-IS", "is"), ("en-GB", "en"), ("de-DE", "en")]:
            context = browser.new_context(locale=locale)
            page = context.new_page()
            page.goto(f"{app}/index.html")
            page.wait_for_selector("html.i18n-ready")
            got = page.evaluate("document.documentElement.lang")
            check(got == wanted, f"a browser set to {locale} opens in {wanted} ({got})")
            context.close()
        # ?lang=en wins over an Icelandic browser.
        context = browser.new_context(locale="is-IS")
        page = context.new_page()
        page.goto(f"{app}/index.html?lang=en")
        page.wait_for_selector("html.i18n-ready")
        check(page.evaluate("document.documentElement.lang") == "en", "?lang=en wins over an Icelandic browser")
        context.close()
        browser.close()

    print()
    if failures:
        print(f"{len(failures)} FAILED")
        sys.exit(1)
    print("ALL PASSED")


if __name__ == "__main__":
    main()
