#!/usr/bin/env python3
"""Renders the README screenshots into screenshots/.

    python3 test/screenshots.py

Firefox goes through a local proxy that makes up every page, so the tabs look like real
browsing but nothing leaves the machine.
"""
import base64
import http.server
import os
import threading
import time
from urllib.parse import quote, urlsplit

from marionette import Firefox

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "screenshots")
WIDTH = 1000

# Each site gets a plain letter favicon.
SITES = {
    "developer.mozilla.org": ("M", "#1e66f5"),
    "news.ycombinator.com": ("Y", "#fe640b"),
    "github.com": ("G", "#8839ef"),
    "en.wikipedia.org": ("W", "#7c7f93"),
    "www.timeout.com": ("T", "#d20f39"),
    "www.booking.com": ("B", "#209fb5"),
    "www.seriouseats.com": ("S", "#df8e1d"),
}

STACKS = {"Docs": "blue", "Review": "purple", "Lisbon": "orange", "Recipes": "green"}

# (stack, url, title). Tabs marked "front" end up on top of their stack, "active" is selected.
TABS = [
    ("Docs", "developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/map", "Array.prototype.map() - JavaScript | MDN", ""),
    ("Docs", "developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled", "Promise.allSettled() - JavaScript | MDN", "active"),
    ("Docs", "developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/hide", "tabs.hide() - Mozilla | MDN", ""),
    ("Docs", "developer.mozilla.org/en-US/docs/Web/CSS/CSS_nesting", "CSS nesting - CSS | MDN", ""),
    (None, "news.ycombinator.com/", "Hacker News", ""),
    ("Review", "github.com/acme/storefront/pulls", "Pull requests · acme/storefront", ""),
    ("Review", "github.com/acme/storefront/pull/482", "Cache product images on the CDN by mira · Pull Request #482 · acme/storefront", "front"),
    ("Review", "github.com/acme/storefront/actions", "Actions · acme/storefront", ""),
    ("Lisbon", "en.wikipedia.org/wiki/Lisbon", "Lisbon - Wikipedia", "front"),
    ("Lisbon", "www.timeout.com/lisbon/things-to-do", "The 30 best things to do in Lisbon", ""),
    ("Lisbon", "www.booking.com/district/pt/lisbon/alfama.html", "Hotels in Alfama, Lisbon", ""),
    ("Lisbon", "en.wikipedia.org/wiki/Pastel_de_nata", "Pastel de nata - Wikipedia", ""),
    ("Recipes", "www.seriouseats.com/shakshuka", "Shakshuka (Eggs Poached in Spicy Tomato Sauce)", ""),
    ("Recipes", "www.seriouseats.com/no-knead-focaccia", "No-Knead Focaccia", "front"),
    ("Recipes", "www.seriouseats.com/miso-ramen", "Weeknight Miso Ramen", ""),
]

TITLES = {"http://" + url: title for _, url, title, _ in TABS}


def favicon(host):
    letter, color = SITES[host]
    svg = (
        "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'>"
        f"<rect width='16' height='16' rx='4' fill='{color}'/>"
        "<text x='8' y='12' text-anchor='middle' font-family='Helvetica, Arial, sans-serif' "
        f"font-size='10.5' font-weight='700' fill='#ffffff'>{letter}</text></svg>"
    )
    return "data:image/svg+xml," + quote(svg)


class Proxy(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        title = TITLES.get(self.path)
        if title is None:
            self.send_error(404)
            return
        host = urlsplit(self.path).hostname
        body = (
            f'<!doctype html><meta charset=utf-8><title>{title}</title>'
            f'<link rel=icon href="{favicon(host)}"><h1>{title}</h1>'
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


PRELUDE = r"""
const w = Services.wm.getMostRecentWindow("navigator:browser");
const g = w.gBrowser;
const P = Services.scriptSecurityManager.getSystemPrincipal();
const sleep = (ms) => new Promise((r) => w.setTimeout(r, ms));
const until = async (check, what) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
};
const snap = (win, { x = 0, y = 0, width, height }) => {
  const scale = 2;
  const canvas = w.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = width * scale;
  canvas.height = height * scale;
  const c = canvas.getContext("2d");
  c.scale(scale, scale);
  c.drawWindow(win, x, y, width, height, "rgba(0,0,0,0)");
  return canvas.toDataURL("image/png");
};
"""


def js(ff, script, *args):
    return ff.m.js(PRELUDE + script, *args)


def save(name, data):
    path = os.path.join(OUT, name)
    with open(path, "wb") as f:
        f.write(base64.b64decode(data.split(",", 1)[1]))
    print(f"wrote {os.path.relpath(path, ROOT)}")


def each_scheme(ff):
    for scheme, dark in (("light", 0), ("dark", 1)):
        js(ff, """
          Services.prefs.setIntPref("ui.systemUsesDarkTheme", args[0]);
          Services.prefs.setIntPref("layout.css.prefers-color-scheme.content-override", args[0] ? 0 : 1);
        """, dark)
        time.sleep(1)
        yield scheme


def tab_bar(ff):
    return js(ff, """
      return snap(w, w.document.getElementById("TabsToolbar").getBoundingClientRect());
    """)


def main():
    os.makedirs(OUT, exist_ok=True)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    ff = Firefox(prefs={
        "network.proxy.type": 1,
        "network.proxy.http": "127.0.0.1",
        "network.proxy.http_port": server.server_address[1],
        "network.proxy.no_proxies_on": "",
        "network.stricttransportsecurity.preloadlist": False,
        "network.captive-portal-service.enabled": False,
        "dom.security.https_first": False,
        "dom.security.https_first_schemeless": False,
        "browser.tabs.inTitlebar": 0,
    })
    try:
        js(ff, """
          const [tabs, colors, width] = args;
          w.resizeTo(width, 720);
          const blank = [...g.tabs];
          const opened = tabs.map(([stack, url, title, role]) => ({
            stack, role, href: "http://" + url,
            tab: g.addTab("http://" + url, { triggeringPrincipal: P, skipAnimation: true }),
          }));
          await until(() => opened.every(({ tab, href }) =>
            tab.linkedBrowser.currentURI.spec === href && !tab.hasAttribute("busy") && g.getIcon(tab)), "pages and icons");
          g.selectedTab = opened[0].tab;
          for (const t of blank) g.removeTab(t, { animate: false });
          for (const [name, color] of Object.entries(colors)) {
            const members = opened.filter((o) => o.stack === name).map((o) => o.tab);
            g.addTabGroup(members, { label: name, color, insertBefore: members[0] });
          }
          for (const role of ["front", "active"]) {
            for (const o of opened.filter((o) => o.role === role)) {
              g.selectedTab = o.tab;
              await sleep(100);
            }
          }
        """, TABS, STACKS, WIDTH)

        for scheme in each_scheme(ff):
            save(f"tabs-native-{scheme}.png", tab_bar(ff))

        addon = ff.install(ROOT)
        js(ff, """
          await until(() => g.tabGroups.every((grp) => grp.tabs.filter((t) => !t.hidden).length === 1), "stacks to fold");
          await sleep(500);
        """)
        for scheme in each_scheme(ff):
            save(f"tabs-stacked-{scheme}.png", tab_bar(ff))

        js(ff, """
          const t = g.addTab(WebExtensionPolicy.getByID(args[0]).getURL("popup/popup.html"), { triggeringPrincipal: P, skipAnimation: true });
          t.setAttribute("screenshot", "popup");
          await until(() => t.linkedBrowser.contentWindow?.document.querySelector(".tab"), "popup");
        """, addon)
        for scheme in each_scheme(ff):
            save(f"popup-{scheme}.png", js(ff, """
              const win = g.tabs.find((t) => t.getAttribute("screenshot") === "popup").linkedBrowser.contentWindow;
              return snap(win, win.document.body.getBoundingClientRect());
            """))
    finally:
        ff.close()
        server.shutdown()


if __name__ == "__main__":
    main()
