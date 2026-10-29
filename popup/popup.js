"use strict";

// 16px stroke icons, built with createElementNS so the page never touches innerHTML.
const ICONS = {
  search: [["circle", { cx: 7, cy: 7, r: 4.5 }], ["path", { d: "M10.5 10.5 14 14" }]],
  stack: [
    ["rect", { x: 1.2, y: 6, width: 8.8, height: 8.8, rx: 1.6 }],
    ["path", { d: "M4.1 3.6h7.2a1.6 1.6 0 0 1 1.6 1.6v7.2" }],
    ["path", { d: "M7 1.2h6.2a1.6 1.6 0 0 1 1.6 1.6V9" }],
  ],
  globe: [["circle", { cx: 8, cy: 8, r: 6.2 }], ["ellipse", { cx: 8, cy: 8, rx: 2.6, ry: 6.2 }], ["path", { d: "M1.8 8h12.4" }]],
  expand: [["path", { d: "M5 5.5 8 2.5l3 3M5 10.5l3 3 3-3" }]],
  collapse: [["path", { d: "M5 2.5l3 3 3-3M5 13.5l3-3 3 3" }]],
  ungroup: [["rect", { x: 1.8, y: 1.8, width: 5.4, height: 5.4, rx: 1.2 }], ["rect", { x: 8.8, y: 8.8, width: 5.4, height: 5.4, rx: 1.2 }]],
  trash: [["path", { d: "M2.8 4.5h10.4M6.3 4.5V2.8h3.4v1.7M4.3 4.5l.6 8.7h6.2l.6-8.7" }]],
  eject: [["path", { d: "M9.5 2.5h4v4M13.5 2.5 8 8M11.5 9.5v4h-9v-9h4" }]],
  x: [["path", { d: "M4.5 4.5l7 7M11.5 4.5l-7 7" }]],
  audio: [["path", { d: "M2.5 6.2h2.2L8 3.5v9L4.7 9.8H2.5zM10.6 5.8a3 3 0 0 1 0 4.4" }]],
  sliders: [
    ["path", { d: "M2.5 4.5h6M12.5 4.5h1M2.5 11.5h1M7.5 11.5h6" }],
    ["circle", { cx: 10.5, cy: 4.5, r: 1.8 }],
    ["circle", { cx: 5.5, cy: 11.5, r: 1.8 }],
  ],
};

function svg(name) {
  const NS = "http://www.w3.org/2000/svg";
  const root = document.createElementNS(NS, "svg");
  const attrs = { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", "stroke-width": 1.4, "stroke-linecap": "round", "stroke-linejoin": "round" };
  for (const [k, v] of Object.entries(attrs)) root.setAttribute(k, v);
  for (const [tag, props] of ICONS[name]) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(props)) el.setAttribute(k, v);
    root.append(el);
  }
  return root;
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = Array.isArray(v) ? v.filter(Boolean).join(" ") : v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el[k] = v;
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

const button = (iconName, title, onclick, extra) =>
  h("button", { class: ["icon", extra], title, onclick: (e) => (e.stopPropagation(), onclick(e)) }, svg(iconName));

const filterInput = document.getElementById("filter");
const stacksEl = document.getElementById("stacks");
const hintEl = document.getElementById("hint");
const stackSelectedButton = document.getElementById("stack-selected");

let windowId;
let mac = false;
let shortcuts = {};
let view = { stacks: [], selectedCount: 0 };
let cursor = null; // tab id under the keyboard cursor
let listMode = false; // Tab toggles between typing a filter and single-key actions on rows
let reloadPending = false;

const send = (type, data) => browser.runtime.sendMessage({ type, windowId, ...data });

async function load() {
  if (document.activeElement?.classList.contains("name")) {
    reloadPending = true; // don't yank a stack name out from under the user mid-rename
    return;
  }
  view = await send("state");
  render();
}

let reloadTimer;
function reloadSoon() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(load, 60);
}

const isCurrent = (stack) => stack.tabs.some((t) => t.id === view.activeTabId);

function render() {
  const words = filterInput.value.toLowerCase().split(/\s+/).filter(Boolean);
  const sections = [...view.stacks]
    .sort((a, b) => isCurrent(b) - isCurrent(a))
    .map((stack) => {
      const name = stack.name.toLowerCase();
      const tabs = stack.tabs.filter((t) => {
        const haystack = `${name} ${t.title} ${t.url}`.toLowerCase();
        return words.every((w) => haystack.includes(w));
      });
      return tabs.length && renderStack(stack, tabs);
    })
    .filter(Boolean);

  stacksEl.replaceChildren(...(sections.length ? sections : [renderEmpty(words.length > 0)]));

  const rows = [...stacksEl.querySelectorAll(".tab")];
  if (!rows.some((r) => Number(r.dataset.id) === cursor)) {
    const start = rows.find((r) => r.classList.contains("active")) ?? rows[0];
    cursor = start ? Number(start.dataset.id) : null;
  }
  paintCursor();

  stackSelectedButton.disabled = view.selectedCount < 2;
  stackSelectedButton.title = view.selectedCount < 2 ? "Select two or more tabs to stack them" : `Stack ${view.selectedCount} selected tabs ${shortcuts["stack-selected"]}`;
}

function renderStack(stack, tabs) {
  const accent = `var(--${GROUP_ACCENTS[stack.color] ?? "mauve"})`;
  const count = tabs.length < stack.tabs.length ? `${tabs.length} of ${stack.tabs.length}` : String(stack.tabs.length);
  const name = h("input", {
    class: "name",
    value: stack.name,
    placeholder: "Unnamed stack",
    spellcheck: false,
    title: "Rename stack",
    onkeydown: (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        e.target.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.target.value = stack.name;
        e.target.blur();
      }
    },
    onblur: async (e) => {
      const value = e.target.value.trim();
      if (value !== stack.name) await send("rename", { groupId: stack.id, name: value });
      if (reloadPending) reloadSoon();
      reloadPending = false;
      if (!listMode) filterInput.focus();
    },
  });

  const head = h(
    "div",
    { class: "head", ...dropTarget(stack.id, null) },
    h("span", { class: "dot" }),
    name,
    h("span", { class: "count" }, count),
    stack.expanded
      ? button("collapse", "Fold back into one tab", () => send("expand", { groupId: stack.id, expand: false }))
      : button("expand", "Show every tab in the tab bar", () => send("expand", { groupId: stack.id, expand: true })),
    button("ungroup", "Dissolve stack, keeping its tabs", () => send("dissolve", { groupId: stack.id })),
    button("trash", `Close all ${stack.tabs.length} tabs`, (e) => confirmThen(e.currentTarget, () => send("closeStack", { groupId: stack.id })), "danger"),
  );

  return h(
    "section",
    { class: ["stack", isCurrent(stack) && "current", stack.expanded && "expanded"], style: `--accent: ${accent}` },
    head,
    h("ol", { class: "members" }, tabs.map((tab) => renderTab(stack, tab))),
  );
}

function renderTab(stack, tab) {
  const site = siteOf(tab.url) ?? tab.url;
  return h(
    "li",
    {
      class: ["tab", tab.id === stack.frontId && "front", tab.active && "active", tab.discarded && "discarded"],
      dataset: { id: tab.id, group: stack.id },
      title: `${tab.title}\n${tab.url}`,
      draggable: true,
      onclick: () => activate(tab.id),
      onauxclick: (e) => e.button === 1 && closeTab(tab.id),
      ...dragSource(tab.id),
      ...dropTarget(stack.id, tab.id),
    },
    favicon(tab),
    h("div", { class: "text" }, h("span", { class: "title" }, tab.title || tab.url), h("span", { class: "site" }, site)),
    tab.audible && h("span", { class: "audible", title: "Playing audio" }, svg("audio")),
    button("eject", "Remove from stack", () => send("eject", { tabId: tab.id })),
    button("x", "Close tab", () => closeTab(tab.id)),
  );
}

function favicon(tab) {
  const letter = () => h("span", { class: "fav letter" }, (siteOf(tab.url) ?? tab.title ?? "?").trim().charAt(0).toUpperCase() || "?");
  if (!/^(https?|data):/.test(tab.favIconUrl ?? "")) return letter();
  return h("img", { class: "fav", src: tab.favIconUrl, alt: "", onerror: (e) => e.target.replaceWith(letter()) });
}

function renderEmpty(filtered) {
  if (filtered) return h("div", { class: "empty" }, h("p", {}, "No stacked tabs match."));
  return h(
    "div",
    { class: "empty" },
    svg("stack"),
    h("strong", {}, "No stacks in this window"),
    h("p", {}, `Drag a tab onto another tab, or select tabs and press ${shortcuts["stack-selected"] || "the stack shortcut"}.`),
    h("button", { class: "primary", onclick: () => send("stackBySite") }, "Stack tabs by site"),
  );
}

// Destructive buttons need a second click within a few seconds.
function confirmThen(el, action) {
  if (el.classList.contains("armed")) return action();
  const title = el.title;
  el.classList.add("armed");
  el.title = "Click again to confirm";
  setTimeout(() => {
    el.classList.remove("armed");
    el.title = title;
  }, 3000);
}

async function activate(tabId) {
  await send("activate", { tabId });
  window.close();
}

function closeTab(tabId) {
  if (tabId === cursor) {
    const rows = [...stacksEl.querySelectorAll(".tab")];
    const at = rows.findIndex((r) => Number(r.dataset.id) === tabId);
    const next = rows[at + 1] ?? rows[at - 1];
    cursor = next ? Number(next.dataset.id) : null;
  }
  send("close", { tabId });
}

// --- Keyboard ------------------------------------------------------------------------------

function paintCursor() {
  for (const row of stacksEl.querySelectorAll(".tab")) {
    const on = Number(row.dataset.id) === cursor;
    row.classList.toggle("cursor", on);
    if (on) row.scrollIntoView({ block: "nearest" });
  }
}

function moveCursor(delta) {
  const rows = [...stacksEl.querySelectorAll(".tab")];
  if (!rows.length) return;
  const at = rows.findIndex((r) => Number(r.dataset.id) === cursor);
  cursor = Number(rows[(at + delta + rows.length) % rows.length].dataset.id);
  paintCursor();
}

function setListMode(on) {
  listMode = on;
  document.body.classList.toggle("list-mode", on);
  if (on) filterInput.blur();
  else filterInput.focus();
  renderHint();
}

function renderHint() {
  const keys = listMode
    ? [["x", "close"], ["e", "unstack"], ["r", "rename"], ["⇥", "filter"]]
    : [["↑↓", "move"], ["↵", "switch"], ["⇥", "actions"]];
  hintEl.replaceChildren(...keys.map(([key, label]) => h("span", {}, h("kbd", {}, key), label)));
}

document.addEventListener("keydown", (e) => {
  if (e.target.classList?.contains("name")) return;
  const plainCtrl = e.ctrlKey && !e.metaKey && !e.altKey;
  const move =
    { ArrowDown: 1, ArrowUp: -1 }[e.key] ??
    (plainCtrl ? { j: 1, n: 1, k: -1, p: -1 }[e.key.toLowerCase()] : undefined) ??
    (listMode && !e.ctrlKey && !e.metaKey ? { j: 1, k: -1 }[e.key] : undefined);
  if (move) {
    e.preventDefault();
    return moveCursor(move);
  }
  if (e.key === "Enter" || (listMode && e.key === "o")) {
    e.preventDefault();
    if (cursor != null) activate(cursor);
    return;
  }
  if (e.key === "Tab") {
    e.preventDefault();
    return setListMode(!listMode);
  }
  if (!listMode) {
    if (e.key === "Escape" && filterInput.value) {
      e.preventDefault();
      filterInput.value = "";
      render();
    }
    return;
  }
  if (e.key === "Escape" || e.key === "/") {
    e.preventDefault();
    return setListMode(false);
  }
  const row = stacksEl.querySelector(".tab.cursor");
  if (!row || e.ctrlKey || e.metaKey || e.altKey) return;
  const tabId = Number(row.dataset.id);
  if (["x", "d", "Backspace", "Delete"].includes(e.key)) {
    e.preventDefault();
    closeTab(tabId);
  } else if (e.key === "e") {
    e.preventDefault();
    send("eject", { tabId });
  } else if (e.key === "r") {
    e.preventDefault();
    const name = row.closest(".stack").querySelector(".name");
    name.focus();
    name.select();
  } else if (e.key.length === 1) {
    setListMode(false); // any other character starts filtering
  }
});

filterInput.addEventListener("input", () => {
  cursor = null;
  render();
});

// --- Drag and drop -------------------------------------------------------------------------

const DRAG_TYPE = "application/x-tabstacks-tab";
let draggedTabId = null;

function dragSource(tabId) {
  return {
    ondragstart: (e) => {
      draggedTabId = tabId;
      e.dataTransfer.setData(DRAG_TYPE, String(tabId));
      e.dataTransfer.effectAllowed = "move";
      e.currentTarget.classList.add("dragging");
    },
    ondragend: (e) => {
      draggedTabId = null;
      e.currentTarget.classList.remove("dragging");
      clearDropMarks();
    },
  };
}

// A row drops before or after itself depending on which half the pointer is over; a stack
// header drops at the end of that stack.
function dropTarget(groupId, tabId) {
  const after = (e) => tabId != null && e.offsetY > e.currentTarget.offsetHeight / 2;
  return {
    ondragover: (e) => {
      if (draggedTabId == null || draggedTabId === tabId) return;
      e.preventDefault();
      e.stopPropagation();
      clearDropMarks();
      e.currentTarget.classList.add(tabId == null ? "drop-into" : after(e) ? "drop-after" : "drop-before");
    },
    ondrop: (e) => {
      if (draggedTabId == null) return;
      e.preventDefault();
      e.stopPropagation();
      let beforeTabId = tabId;
      if (after(e)) beforeTabId = Number(e.currentTarget.nextElementSibling?.dataset.id) || null;
      send("move", { tabId: draggedTabId, groupId, beforeTabId });
      clearDropMarks();
    },
  };
}

function clearDropMarks() {
  for (const el of stacksEl.querySelectorAll(".drop-before, .drop-after, .drop-into")) el.classList.remove("drop-before", "drop-after", "drop-into");
}

// --- Setup ---------------------------------------------------------------------------------

for (const el of document.querySelectorAll("[data-icon]")) el.append(svg(el.dataset.icon));

document.getElementById("stack-by-site").addEventListener("click", () => send("stackBySite"));
stackSelectedButton.addEventListener("click", () => send("stackSelected"));
document.getElementById("expand-all").addEventListener("click", () => send("expandAll", { expand: true }));
document.getElementById("collapse-all").addEventListener("click", () => send("expandAll", { expand: false }));
document.getElementById("settings").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

(async () => {
  const [win, platform, commands] = await Promise.all([browser.windows.getCurrent(), browser.runtime.getPlatformInfo(), browser.commands.getAll()]);
  windowId = win.id;
  mac = platform.os === "mac";
  shortcuts = Object.fromEntries(commands.map((c) => [c.name, formatShortcut(c.shortcut, mac)]));
  document.getElementById("stack-by-site").title = "Stack all loose tabs by site";
  renderHint();
  await load();
  filterInput.focus();

  for (const event of [browser.tabs.onCreated, browser.tabs.onRemoved, browser.tabs.onActivated, browser.tabs.onMoved, browser.tabs.onUpdated]) {
    event.addListener(reloadSoon);
  }
  for (const event of [browser.tabGroups.onCreated, browser.tabGroups.onRemoved, browser.tabGroups.onUpdated, browser.tabGroups.onMoved]) {
    event.addListener(reloadSoon);
  }
})();
