// Loaded by the background page, the popup and the options page.
"use strict";

const NO_GROUP = -1; // browser.tabGroups.TAB_GROUP_ID_NONE

const DEFAULT_SETTINGS = {
  showCounter: true, // "Docs · 2/5" in the group label
  dissolveSingles: true, // ungroup a stack once it's down to one tab
  focusStackOnClose: true, // closing the front tab shows the next tab in the stack
  autoCollapse: true, // an expanded stack folds back up when you leave it
  newTabs: "join", // tabs opened from a stacked tab: "join" the stack or open "beside" it
  labelClick: "expand", // clicking a stack's label: "expand" it in place or "collapse" it like Firefox does
};

async function getSettings() {
  const { settings } = await browser.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...settings };
}

// The counter lives in the group title, so strip it before treating the title as a name.
const COUNTER_RE = /(?:^|\s+·\s+)(?:\d+\/\d+|all \d+)$/;

function stackName(title) {
  return (title || "").replace(COUNTER_RE, "").trim();
}

function stackTitle(name, position, count, expanded, showCounter) {
  if (!showCounter) return name;
  const counter = expanded ? `all ${count}` : `${position}/${count}`;
  return name ? `${name} · ${counter}` : counter;
}

function siteOf(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return /^https?:$/.test(protocol) && hostname ? hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

const byIndex = (a, b) => a.index - b.index;

// "MacCtrl+Shift+Period" -> "⌃⇧." on macOS, "Alt+Shift+." elsewhere.
function formatShortcut(shortcut, mac) {
  if (!shortcut) return "";
  const modifiers = mac ? { MacCtrl: "⌃", Ctrl: "⌘", Command: "⌘", Alt: "⌥", Shift: "⇧" } : {};
  const keys = { Period: ".", Comma: ",", Up: "↑", Down: "↓", Left: "←", Right: "→" };
  return shortcut
    .split("+")
    .map((part) => modifiers[part] ?? keys[part] ?? part)
    .join(mac ? "" : "+");
}

// Firefox group colors mapped onto Catppuccin, which the popup uses. Badge colors are Mocha.
const GROUP_ACCENTS = {
  blue: "blue",
  cyan: "sky",
  grey: "overlay1",
  green: "green",
  orange: "peach",
  pink: "pink",
  purple: "mauve",
  red: "red",
  yellow: "yellow",
};

const BADGE_COLORS = {
  blue: "#89b4fa",
  cyan: "#89dceb",
  grey: "#7f849c",
  green: "#a6e3a1",
  orange: "#fab387",
  pink: "#f5c2e7",
  purple: "#cba6f7",
  red: "#f38ba8",
  yellow: "#f9e2af",
};
