#!/usr/bin/env python3
"""End-to-end tests: a headless Firefox with the extension installed, driven over Marionette.

    python3 test/test_tabstacks.py [-k NAME]

Tab bars are asserted as strings: `start [Docs · 1/3: *A (B) (C)]` is a loose tab "start"
followed by a group labelled "Docs · 1/3" holding A (selected) and B, C (hidden).
"""
import argparse
import http.server
import json
import os
import sys
import threading
import time
import traceback

from marionette import Firefox

EXTENSION = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PRELUDE = r"""
const ctx = args.shift();
const w = Services.wm.getMostRecentWindow("navigator:browser");
const g = w.gBrowser;
const P = Services.scriptSecurityManager.getSystemPrincipal();
const sleep = (ms) => new Promise((r) => w.setTimeout(r, ms));
const url = (name, host = "127.0.0.1") => `http://${host}:${ctx.port}/${name}`;
const nameOf = (t) => {
  if (t.getAttribute("test-name")) return t.getAttribute("test-name");
  try {
    const u = new URL(t.linkedBrowser.currentURI.spec);
    return u.protocol.startsWith("http") ? u.pathname.slice(1) : u.href;
  } catch { return "?"; }
};
const tab = (name) => {
  const found = g.tabs.find((t) => nameOf(t) === name);
  if (!found) throw new Error(`no tab named ${name}`);
  return found;
};
const openUrl = (href, name, extra = {}) => {
  const t = g.addTab(href, { triggeringPrincipal: P, skipAnimation: true, ...extra });
  t.setAttribute("test-name", name);
  t.setAttribute("test-url", href);
  return t;
};
const open = (name, host, extra) => openUrl(url(name, host), name, extra);
const loaded = async () => {
  for (let i = 0; i < 100; i++) {
    if (g.tabs.every((t) => !t.hasAttribute("test-url") || t.linkedBrowser.currentURI.spec === t.getAttribute("test-url"))) return;
    await sleep(50);
  }
  throw new Error("tabs never loaded");
};
const ext = () => WebExtensionPolicy.getByID(ctx.addon);
const bgWindow = () => [...ext().extension.views].find((v) => v.viewType === "background").xulBrowser.contentWindow;
const bg = () => bgWindow().wrappedJSObject;
const clone = (value, win = bgWindow()) => Cu.cloneInto(value, win);
const command = (name) => {
  const want = { "next-in-stack": "VK_PERIOD", "prev-in-stack": "VK_COMMA", "stack-selected": "S", "toggle-expand": "E", "remove-from-stack": "X" }[name];
  const keyset = w.document.querySelector('keyset[id^="ext-keyset-id-tabstacks"]');
  const keyOf = (k) => (k.getAttribute("key") || k.getAttribute("keycode") || "").toUpperCase();
  const key = [...keyset.children].find((k) => keyOf(k) === want);
  if (!key) throw new Error(`no key for ${name}: ${[...keyset.children].map(keyOf).join(" ")}`);
  key.doCommand();
};
const layout = () => {
  const parts = [];
  let current = null;
  for (const t of g.tabs) {
    if (t.group !== current) {
      if (current) parts.push("]");
      if (t.group) parts.push(`[${t.group.label}${t.group.collapsed ? " (collapsed)" : ""}:`);
      current = t.group;
    }
    let s = nameOf(t);
    if (t.selected) s = "*" + s;
    if (t.hidden) s = `(${s})`;
    parts.push(s);
  }
  if (current) parts.push("]");
  return parts.join(" ").replace(/: /g, ": ").replace(/ \]/g, "]");
};
const page = (name) => g.tabs.find((t) => nameOf(t) === name).linkedBrowser.contentWindow;
const popupWindow = () => page("popup").wrappedJSObject;
const openPopup = async () => {
  openUrl(ext().getURL("popup/popup.html"), "popup");
  await loaded();
  for (let i = 0; i < 100 && !popupWindow().document.querySelector(".tab, .empty"); i++) await sleep(50);
};
const popupClick = (selector) => {
  const el = popupWindow().document.querySelector(selector);
  if (!el) throw new Error(`nothing in the popup matches ${selector}`);
  el.click();
};
"""


class Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        name = self.path.strip("/") or "index"
        body = f"<!doctype html><meta charset=utf-8><title>{name}</title><h1>{name}</h1>".encode()
        self.send_response(200 if name != "favicon.ico" else 404)
        self.send_header("Content-Type", "text/html")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class Session:
    def __init__(self, ff, ctx):
        self.ff = ff
        self.ctx = ctx

    def js(self, script, *args):
        return self.ff.m.js(PRELUDE + script, self.ctx, *args)

    def layout(self):
        return self.js("return layout();")

    def expect(self, want, timeout=5):
        deadline = time.time() + timeout
        while True:
            got = self.layout()
            if got == want:
                return
            if time.time() > deadline:
                raise AssertionError(f"tab bar\n  want: {want}\n  got:  {got}")
            time.sleep(0.1)

    def until(self, condition, what, timeout=5):
        deadline = time.time() + timeout
        while not self.js(f"return !!({condition});"):
            if time.time() > deadline:
                raise AssertionError(f"timed out waiting for {what}\n  tab bar: {self.layout()}")
            time.sleep(0.1)

    def settle(self):
        time.sleep(0.4)

    def reset(self):
        self.js("""
          bg().browser.storage.local.remove("settings");
          const keep = g.addTab("about:blank", { triggeringPrincipal: P, skipAnimation: true });
          keep.setAttribute("test-name", "start");
          g.selectedTab = keep;
          for (const t of [...g.tabs]) if (t !== keep) g.removeTab(t, { animate: false });
        """)
        self.expect("*start")

    def stack(self, names, label="Docs", select=None):
        self.js(
            """
            const [names, label, select] = args;
            for (const n of names) open(n);
            await loaded();
            if (select) g.selectedTab = tab(select);
            g.addTabGroup(names.map(tab), { label });
            """,
            names, label, select,
        )


TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


@test
def folds_a_new_group_down_to_the_active_tab(s):
    s.stack(["A", "B", "C"], select="A")
    s.expect("start [Docs · 1/3: *A (B) (C)]")


@test
def folds_a_background_group_down_to_one_tab(s):
    s.stack(["A", "B", "C"])
    s.until("g.tabs.filter((t) => t.group && !t.hidden).length === 1", "one visible member")
    s.until("/^Docs · \\d\\/3$/.test(tab('A').group.label)", "counter in label")


@test
def cycles_through_a_stack_with_shortcuts(s):
    s.stack(["A", "B", "C"], select="A")
    s.expect("start [Docs · 1/3: *A (B) (C)]")
    s.js('command("next-in-stack");')
    s.expect("start [Docs · 2/3: (A) *B (C)]")
    s.js('command("next-in-stack");')
    s.expect("start [Docs · 3/3: (A) (B) *C]")
    s.js('command("next-in-stack");')
    s.expect("start [Docs · 1/3: *A (B) (C)]")
    s.js('command("prev-in-stack");')
    s.expect("start [Docs · 3/3: (A) (B) *C]")


@test
def survives_rapid_cycling(s):
    s.stack(["A", "B", "C", "D"], select="A")
    s.expect("start [Docs · 1/4: *A (B) (C) (D)]")
    s.js('for (let i = 0; i < 9; i++) command("next-in-stack");')
    s.expect("start [Docs · 2/4: (A) *B (C) (D)]")
    s.settle()
    s.expect("start [Docs · 2/4: (A) *B (C) (D)]")


@test
def closing_a_hidden_member_keeps_the_front(s):
    s.stack(["A", "B", "C"], select="B")
    s.expect("start [Docs · 2/3: (A) *B (C)]")
    s.js('g.removeTab(tab("C"), { animate: false });')
    s.expect("start [Docs · 2/2: (A) *B]")


@test
def keeps_the_front_tab_when_you_leave_the_stack(s):
    s.stack(["A", "B", "C"], select="B")
    s.expect("start [Docs · 2/3: (A) *B (C)]")
    s.js('g.selectedTab = tab("start");')
    s.expect("*start [Docs · 2/3: (A) B (C)]")
    s.settle()
    s.expect("*start [Docs · 2/3: (A) B (C)]")


@test
def closing_the_front_tab_shows_the_next_one_in_the_stack(s):
    s.js('open("Z");')
    s.stack(["A", "B", "C"], select="B")
    s.expect("start Z [Docs · 2/3: (A) *B (C)]")
    s.js('g.removeTab(tab("B"), { animate: false });')
    s.expect("start Z [Docs · 2/2: (A) *C]")


@test
def a_stack_down_to_one_tab_dissolves(s):
    s.stack(["A", "B"], select="B")
    s.expect("start [Docs · 2/2: (A) *B]")
    s.js('g.removeTab(tab("B"), { animate: false });')
    s.expect("start *A")


@test
def a_single_tab_group_you_made_is_left_alone(s):
    s.stack(["A"], select="A")
    s.expect("start [Docs · 1/1: *A]")
    s.settle()
    s.expect("start [Docs · 1/1: *A]")


@test
def clicking_the_label_expands_and_folds_the_stack(s):
    s.stack(["A", "B", "C"], select="A")
    s.expect("start [Docs · 1/3: *A (B) (C)]")
    s.js('tab("A").group.collapsed = true;')
    s.expect("start [Docs · all 3: *A B C]")
    s.js('tab("A").group.collapsed = true;')
    s.expect("start [Docs · 1/3: *A (B) (C)]")


@test
def an_expanded_stack_folds_when_you_leave_it(s):
    s.stack(["A", "B", "C"], select="B")
    s.js('command("toggle-expand");')
    s.expect("start [Docs · all 3: A *B C]")
    s.js('g.selectedTab = tab("start");')
    s.expect("*start [Docs · 2/3: (A) B (C)]")


@test
def links_opened_from_a_stacked_tab_join_it(s):
    s.stack(["A", "B"], select="A")
    s.expect("start [Docs · 1/2: *A (B)]")
    s.js('open("R", undefined, { relatedToCurrent: true, openerBrowser: tab("A").linkedBrowser });')
    s.expect("start [Docs · 1/3: *A (B) (R)]")


@test
def links_can_open_beside_the_stack_instead(s):
    s.js('await bg().browser.storage.local.set(clone({ settings: { newTabs: "beside" } }));')
    s.stack(["A", "B"], select="A")
    s.expect("start [Docs · 1/2: *A (B)]")
    s.js('open("R", undefined, { relatedToCurrent: true, openerBrowser: tab("A").linkedBrowser });')
    s.until('!tab("R").group && !tab("R").hidden', "R outside the stack")
    s.expect("start [Docs · 1/2: *A (B)] R")


@test
def stacks_selected_tabs_with_a_shortcut(s):
    s.js('open("A"); open("B"); open("C"); await loaded(); g.selectedTab = tab("A"); g.addToMultiSelectedTabs(tab("C"));')
    s.js('command("stack-selected");')
    s.expect("start [127.0.0.1 · 1/2: *A (C)] B")


@test
def selected_tabs_join_a_stack_one_of_them_is_in(s):
    s.stack(["A", "B"], select="A")
    s.js('open("C"); await loaded(); g.selectedTab = tab("A"); g.addToMultiSelectedTabs(tab("C"));')
    s.js('command("stack-selected");')
    s.expect("start [Docs · 1/3: *A (B) (C)]")


@test
def removes_the_current_tab_from_its_stack(s):
    s.stack(["A", "B", "C"], select="B")
    s.js('command("remove-from-stack");')
    s.until('!tab("B").group && tab("B").selected && !tab("B").hidden', "B ejected")
    s.until('tab("A").group && tab("A").group.tabs.length === 2', "two left in stack")
    s.until("g.tabs.filter((t) => t.group && !t.hidden).length === 1", "stack still folded")


@test
def stacks_tabs_by_site(s):
    s.js("""
      open("A"); open("B"); open("C", "localhost"); open("D", "localhost"); open("E", "localhost");
      await openPopup();
      popupClick(".empty .primary");
    """)
    s.until('tab("A").group && tab("A").group === tab("B").group', "127.0.0.1 stack")
    s.until('tab("C").group && tab("C").group === tab("E").group && tab("C").group !== tab("A").group', "localhost stack")
    s.until("g.tabGroups.every((grp) => grp.tabs.filter((t) => !t.hidden).length === 1)", "both folded")
    s.until("g.tabGroups.map((grp) => grp.label.split(' · ')[0]).sort().join() === '127.0.0.1,localhost'", "named by site")


@test
def dissolving_a_stack_shows_all_its_tabs(s):
    s.stack(["A", "B", "C"], select="A")
    s.expect("start [Docs · 1/3: *A (B) (C)]")
    s.js("await openPopup();")
    s.js('popupClick(".stack .head button[title^=Dissolve]");')
    s.expect("start *A B C popup")


@test
def popup_lists_stacks_and_switches_tabs(s):
    s.stack(["A", "B", "C"], label="Docs", select="A")
    s.js('open("D", "localhost"); open("E", "localhost"); await loaded(); g.addTabGroup([tab("D"), tab("E")], { label: "Local" });')
    s.until("g.tabGroups.every((grp) => grp.tabs.filter((t) => !t.hidden).length === 1)", "both folded")
    s.js("await openPopup();")
    s.until('popupWindow().document.querySelectorAll(".tab").length === 5', "popup rows")
    names = s.js('return [...popupWindow().document.querySelectorAll(".name")].map((n) => n.value);')
    assert names == ["Docs", "Local"], names
    s.js("""
      const doc = popupWindow().document;
      const input = doc.getElementById("filter");
      input.value = "/c";
      input.dispatchEvent(new (popupWindow().Event)("input"));
    """)
    s.until('popupWindow().document.querySelectorAll(".tab").length === 1', "filtered to one row")
    s.js('popupWindow().document.querySelector(".tab").click();')
    s.until('tab("C").selected && !tab("C").hidden && tab("A").hidden', "switched to C")


@test
def popup_moves_renames_and_ejects(s):
    s.stack(["A", "B", "C"], select="A")
    s.js('open("D"); open("E"); await loaded(); g.addTabGroup([tab("D"), tab("E")], { label: "Other" });')
    s.js('await openPopup(); g.selectedTab = tab("A");')
    s.until('popupWindow().document.querySelectorAll(".tab").length === 5', "popup rows")
    # The popup's own messages: C to the top of Docs, D across from Other (which then
    # dissolves), a rename, and B out of the stack.
    s.js("""
      const send = (m) => popupWindow().browser.runtime.sendMessage(clone(m, page("popup")));
      const tabs = await popupWindow().browser.tabs.query(clone({}, page("popup")));
      const byUrl = (n) => tabs.find((t) => t.url.endsWith("/" + n));
      await send({ type: "move", tabId: byUrl("C").id, groupId: byUrl("A").groupId, beforeTabId: byUrl("A").id });
      await send({ type: "move", tabId: byUrl("D").id, groupId: byUrl("A").groupId, beforeTabId: byUrl("B").id });
      await send({ type: "rename", groupId: byUrl("A").groupId, name: "Reading" });
      await send({ type: "eject", tabId: byUrl("B").id });
    """)
    s.expect("start [Reading · 2/3: (C) *A (D)] B E popup")


@test
def options_page_saves_settings(s):
    s.js('openUrl(ext().getURL("options/options.html"), "options"); await loaded();')
    s.until('(() => { const d = page("options").document; return d.querySelectorAll("#shortcuts dt").length === 6 && d.forms[0].elements.showCounter.checked; })()', "options rendered")
    s.js("""
      page("options").document.forms[0].elements.showCounter.click();
    """)
    s.until('(async () => !(await bg().browser.storage.local.get("settings")).settings?.showCounter)()', "setting saved")
    s.stack(["A", "B"], select="A")
    s.expect("start options [Docs: *A (B)]")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("-k", help="only run tests whose name contains this")
    opts = parser.parse_args()

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Page)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    ff = Firefox()
    failed = []
    try:
        addon = ff.install(EXTENSION)
        s = Session(ff, {"port": server.server_address[1], "addon": addon})
        s.until('ext() && [...ext().extension.views].some((v) => v.viewType === "background")', "background page")
        for fn in TESTS:
            if opts.k and opts.k not in fn.__name__:
                continue
            try:
                s.reset()
                fn(s)
                print(f"ok    {fn.__name__}")
            except Exception as err:
                failed.append(fn.__name__)
                print(f"FAIL  {fn.__name__}\n{err if isinstance(err, AssertionError) else traceback.format_exc()}")
    finally:
        ff.close()
        server.shutdown()
        if os.environ.get("TABSTACKS_FIREFOX_LOG"):
            with open(os.environ["TABSTACKS_FIREFOX_LOG"], "w") as f:
                f.write(ff.log_text)
        errors = [line for line in ff.log_text.splitlines() if "tabstacks" in line.lower()]
        if errors:
            print("\nextension console:\n  " + "\n  ".join(errors[-20:]))

    print(f"\n{len(failed)} failed" if failed else "\nall passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
