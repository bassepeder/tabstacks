// A stack is a native tab group with every member hidden except one, the "front" tab.
// Firefox owns membership (drag a tab onto a tab, "Add Tab to Group", session restore);
// this page re-applies the one-visible-tab rule after anything that could break it.
"use strict";

const state = {
  front: {}, // groupId -> tabId shown in the tab bar
  counts: {}, // groupId -> member count at the last pass, to spot a stack shrinking to one tab
  expanded: [], // groupIds showing every member, like Vivaldi's accordion stacks
  active: {}, // windowId -> active tabId, as of the latest event
  tabs: {}, // tabId -> { groupId, index }, as of the latest event or pass
};
let settings = { ...DEFAULT_SETTINGS };

// The page is an event page, so state survives suspension in storage.session.
let isReady = false;
const ready = (async () => {
  try {
    const [{ state: saved }, loaded] = await Promise.all([browser.storage.session.get("state"), getSettings()]);
    Object.assign(state, saved);
    settings = loaded;
  } catch (err) {
    console.error("tabstacks: could not restore state", err);
  }
  isReady = true;
})();

// Bookkeeping that depends on event order runs as each event arrives, not when the queue
// gets to it, or a slow pass could let a tab close before we noticed it was active.
const inOrder = (fn) => (isReady ? fn() : ready.then(fn));

const persist = () => browser.storage.session.set({ state });

// Every tab mutation runs through one queue so passes never interleave.
let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(() => ready).then(task);
  queue = run.catch((err) => console.error("tabstacks:", err));
  return run;
}

const dirty = new Set();
function scheduleReconcile(windowId) {
  if (windowId == null || windowId < 0 || dirty.has(windowId)) return;
  dirty.add(windowId);
  enqueue(() => {
    dirty.delete(windowId);
    return reconcile(windowId);
  });
}

async function reconcileAll() {
  for (const { id } of await browser.windows.getAll({ windowTypes: ["normal"] })) scheduleReconcile(id);
}

function groupMembers(tabs) {
  const members = new Map();
  for (const tab of [...tabs].sort(byIndex)) {
    if (tab.groupId == null || tab.groupId === NO_GROUP) continue;
    if (!members.has(tab.groupId)) members.set(tab.groupId, []);
    members.get(tab.groupId).push(tab);
  }
  return members;
}

async function reconcile(windowId) {
  let tabs, groups;
  try {
    [tabs, groups] = await Promise.all([browser.tabs.query({ windowId }), browser.tabGroups.query({ windowId })]);
  } catch {
    return; // the window closed
  }
  const members = groupMembers(tabs);
  const active = tabs.find((t) => t.active);
  for (const t of tabs) state.tabs[t.id] = { groupId: t.groupId, index: t.index };

  for (const group of groups) {
    const list = members.get(group.id);
    // A tab or group can vanish mid-pass; the next event settles it, so keep going.
    if (list) await settle(group, list, active).catch((err) => console.warn("tabstacks: could not settle group", group.id, err));
  }
  await persist();
  await updateAction(windowId, active, groups, members);
}

async function settle(group, list, active) {
  const previous = state.counts[group.id];
  state.counts[group.id] = list.length;

  if (list.length === 1 && previous > 1 && settings.dissolveSingles) {
    const [last] = list;
    if (last.hidden) await browser.tabs.show(last.id);
    await browser.tabs.ungroup(last.id);
    forget(group.id);
    dissolvedInto[group.id] = last.id;
    return;
  }

  const expanded = state.expanded.includes(group.id);
  const front = pickFront(group.id, list, active);
  state.front[group.id] = front.id;

  if (expanded) {
    const hidden = list.filter((t) => t.hidden).map((t) => t.id);
    if (hidden.length) await browser.tabs.show(hidden);
  } else {
    if (front.hidden) await browser.tabs.show(front.id);
    const extra = list.filter((t) => t !== front && !t.hidden).map((t) => t.id);
    if (extra.length) await browser.tabs.hide(extra);
  }

  const position = list.indexOf(front) + 1;
  const title = stackTitle(stackName(group.title), position, list.length, expanded, settings.showCounter);
  if (title !== group.title) await browser.tabGroups.update(group.id, { title });
}

function pickFront(groupId, list, active) {
  if (active?.groupId === groupId) return active;
  const visible = list.filter((t) => !t.hidden);
  const remembered = list.find((t) => t.id === state.front[groupId]);
  if (remembered && (!remembered.hidden || !visible.length)) return remembered;
  const pool = visible.length ? visible : list;
  return pool.reduce((a, b) => (b.lastAccessed > a.lastAccessed ? b : a));
}

function forget(groupId) {
  delete state.front[groupId];
  delete state.counts[groupId];
  state.expanded = state.expanded.filter((id) => id !== groupId);
}

async function updateAction(windowId, active, groups, members) {
  const group = active && groups.find((g) => g.id === active.groupId);
  const list = group && members.get(group.id);
  const title = list ? `${stackName(group.title) || "Stack"}: tab ${list.indexOf(active) + 1} of ${list.length}` : "Tab Stacks";
  await Promise.all([
    browser.action.setBadgeText({ windowId, text: list ? String(list.length) : "" }),
    browser.action.setTitle({ windowId, title }),
    group && browser.action.setBadgeBackgroundColor({ windowId, color: BADGE_COLORS[group.color] ?? BADGE_COLORS.purple }),
    browser.action.setBadgeTextColor({ windowId, color: "#11111b" }),
  ]);
}

// --- Actions -------------------------------------------------------------------------------

async function activeTab(windowId) {
  const [tab] = await browser.tabs.query(windowId == null ? { currentWindow: true, active: true } : { windowId, active: true });
  return tab;
}

async function stackMembers(groupId, windowId) {
  return (await browser.tabs.query({ windowId })).filter((t) => t.groupId === groupId).sort(byIndex);
}

async function focusTab(tabId) {
  await browser.tabs.show(tabId);
  await browser.tabs.update(tabId, { active: true });
}

async function cycle(windowId, delta) {
  const current = await activeTab(windowId);
  if (!current || current.groupId === NO_GROUP) return;
  const list = await stackMembers(current.groupId, current.windowId);
  const at = list.findIndex((t) => t.id === current.id);
  const next = list[(at + delta + list.length) % list.length];
  if (next.id !== current.id) await focusTab(next.id);
}

// Stacks the tabs, joining whichever stack one of them is already in.
async function stackTabs(tabs) {
  tabs = tabs.filter((t) => !t.pinned);
  if (!tabs.length) return;
  const tabIds = tabs.map((t) => t.id);
  const existing = tabs.find((t) => t.groupId !== NO_GROUP);
  if (existing) {
    await browser.tabs.group({ tabIds, groupId: existing.groupId });
  } else {
    const groupId = await browser.tabs.group({ tabIds });
    const sites = new Set(tabs.map((t) => siteOf(t.url)));
    const [site] = sites;
    if (sites.size === 1 && site) await browser.tabGroups.update(groupId, { title: site });
  }
  scheduleReconcile(tabs[0].windowId);
}

async function selectedTabs(windowId, clicked) {
  const selected = await browser.tabs.query({ windowId, highlighted: true });
  return !clicked || selected.some((t) => t.id === clicked.id) ? selected : [clicked];
}

// Stacks loose tabs that share a site, adding to an existing stack named after that site.
async function stackBySite(windowId) {
  const [tabs, groups] = await Promise.all([browser.tabs.query({ windowId, pinned: false }), browser.tabGroups.query({ windowId })]);
  const named = new Map(groups.map((g) => [stackName(g.title).toLowerCase(), g.id]));
  const bySite = new Map();
  for (const tab of tabs.sort(byIndex)) {
    const site = tab.groupId === NO_GROUP && siteOf(tab.url);
    if (site) bySite.set(site, [...(bySite.get(site) ?? []), tab.id]);
  }
  for (const [site, tabIds] of bySite) {
    const groupId = named.get(site);
    if (groupId != null) await browser.tabs.group({ tabIds, groupId });
    else if (tabIds.length > 1) await browser.tabGroups.update(await browser.tabs.group({ tabIds }), { title: site });
  }
  scheduleReconcile(windowId);
}

async function eject(tabId) {
  const tab = await browser.tabs.get(tabId);
  if (tab.groupId === NO_GROUP) return;
  await browser.tabs.ungroup(tab.id);
  if (tab.hidden) await browser.tabs.show(tab.id);
  scheduleReconcile(tab.windowId);
}

async function setExpanded(groupId, expand) {
  if (groupId == null || groupId === NO_GROUP) return;
  const group = await browser.tabGroups.get(groupId);
  state.expanded = state.expanded.filter((id) => id !== groupId);
  if (expand) state.expanded.push(groupId);
  if (expand && group.collapsed) await browser.tabGroups.update(groupId, { collapsed: false });
  await reconcile(group.windowId);
}

async function setAllExpanded(windowId, expand) {
  const ids = (await browser.tabGroups.query({ windowId })).map((g) => g.id);
  state.expanded = state.expanded.filter((id) => !ids.includes(id));
  if (expand) state.expanded.push(...ids);
  await reconcile(windowId);
}

async function dissolve(groupId) {
  const group = await browser.tabGroups.get(groupId);
  const list = await stackMembers(groupId, group.windowId);
  forget(groupId);
  const hidden = list.filter((t) => t.hidden).map((t) => t.id);
  if (hidden.length) await browser.tabs.show(hidden);
  await browser.tabs.ungroup(list.map((t) => t.id));
}

async function closeStack(groupId) {
  const group = await browser.tabGroups.get(groupId);
  await browser.tabs.remove((await stackMembers(groupId, group.windowId)).map((t) => t.id));
}

async function rename(groupId, name) {
  const group = await browser.tabGroups.update(groupId, { title: name.trim() });
  await reconcile(group.windowId);
}

// Moves a tab into a stack, before `beforeTabId` or at the end.
async function moveTab(tabId, groupId, beforeTabId) {
  let tab = await browser.tabs.get(tabId);
  if (tab.groupId !== groupId) {
    await browser.tabs.group({ tabIds: [tabId], groupId });
    tab = await browser.tabs.get(tabId);
  }
  if (beforeTabId != null && beforeTabId !== tabId) {
    const before = await browser.tabs.get(beforeTabId);
    await browser.tabs.move(tabId, { index: tab.index < before.index ? before.index - 1 : before.index });
    if ((await browser.tabs.get(tabId)).groupId !== groupId) await browser.tabs.group({ tabIds: [tabId], groupId });
  }
  await reconcile(tab.windowId);
}

async function describe(windowId) {
  const [tabs, groups] = await Promise.all([browser.tabs.query({ windowId }), browser.tabGroups.query({ windowId })]);
  const members = groupMembers(tabs);
  const stacks = groups
    .filter((g) => members.has(g.id))
    .map((g) => ({
      id: g.id,
      name: stackName(g.title),
      color: g.color,
      expanded: state.expanded.includes(g.id),
      frontId: state.front[g.id],
      tabs: members.get(g.id).map((t) => ({
        id: t.id,
        title: t.title,
        url: t.url,
        favIconUrl: t.favIconUrl,
        active: t.active,
        hidden: t.hidden,
        discarded: t.discarded,
        audible: t.audible,
      })),
    }))
    .sort((a, b) => members.get(a.id)[0].index - members.get(b.id)[0].index);
  return {
    windowId,
    activeTabId: tabs.find((t) => t.active)?.id,
    selectedCount: tabs.filter((t) => t.highlighted && !t.pinned).length,
    stacks,
  };
}

// --- Events --------------------------------------------------------------------------------

// When the active tab closes, Firefox picks the next one itself and never picks a hidden tab.
// If the closed tab was a stack's front, move focus to its neighbour in the stack instead.
async function refocusClosedStack(windowId, closed) {
  const stacked = closed.groupId != null && closed.groupId !== NO_GROUP && !state.expanded.includes(closed.groupId);
  if (!stacked || !settings.focusStackOnClose) return;
  const siblings = await stackMembers(closed.groupId, windowId);
  let next = siblings.find((t) => t.index >= closed.index) ?? siblings.at(-1);
  // A pass may already have dissolved a two-tab stack; its survivor still gets focus.
  if (!next && dissolvedInto[closed.groupId] != null) next = await browser.tabs.get(dissolvedInto[closed.groupId]).catch(() => null);
  delete dissolvedInto[closed.groupId];
  if (next && !next.active) await focusTab(next.id);
}

// groupId -> the one tab left when that stack dissolved.
const dissolvedInto = {};

// windowId -> the tab that was active when a selection arrived without a previousTabId,
// which Firefox does when the previous tab is closing. onRemoved confirms it.
const closing = {};

browser.tabs.onActivated.addListener(({ tabId, previousTabId, windowId }) =>
  inOrder(() => {
    const before = state.active[windowId];
    state.active[windowId] = tabId;
    delete closing[windowId];
    if (before == null || before === tabId) return scheduleReconcile(windowId);
    if (previousTabId == null) closing[windowId] = { tabId: before, ...state.tabs[before] };
    const left = state.tabs[before]?.groupId;
    enqueue(async () => {
      const tab = await browser.tabs.get(tabId).catch(() => null);
      if (settings.autoCollapse && left != null && left !== NO_GROUP && tab && left !== tab.groupId) {
        state.expanded = state.expanded.filter((id) => id !== left);
      }
      await reconcile(windowId);
    });
  }),
);

browser.tabs.onRemoved.addListener((tabId, { windowId, isWindowClosing }) =>
  inOrder(() => {
    const info = state.tabs[tabId];
    delete state.tabs[tabId];
    if (isWindowClosing) return;
    let closed = null;
    if (state.active[windowId] === tabId) {
      // The close arrived before the new selection.
      delete state.active[windowId];
      closed = info && { tabId, ...info };
    } else if (closing[windowId]?.tabId === tabId) {
      closed = closing[windowId];
      delete closing[windowId];
    }
    enqueue(async () => {
      if (closed) await refocusClosedStack(windowId, closed);
      await reconcile(windowId);
    });
  }),
);

browser.tabs.onCreated.addListener((tab) =>
  inOrder(() => {
    state.tabs[tab.id] = { groupId: tab.groupId, index: tab.index };
    if (tab.openerTabId != null) {
      enqueue(async () => {
        if (settings.newTabs !== "beside") return;
        const [fresh, opener] = await Promise.all([browser.tabs.get(tab.id), browser.tabs.get(tab.openerTabId)]).catch(() => []);
        if (fresh && opener && opener.groupId !== NO_GROUP && fresh.groupId === opener.groupId) await eject(tab.id);
      });
    }
    scheduleReconcile(tab.windowId);
  }),
);

browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (!("groupId" in change || "hidden" in change || "pinned" in change)) return;
  inOrder(() => {
    state.tabs[tabId] = { groupId: tab.groupId, index: tab.index };
    scheduleReconcile(tab.windowId);
  });
});
browser.tabs.onMoved.addListener((tabId, { windowId }) => scheduleReconcile(windowId));
browser.tabs.onAttached.addListener((tabId, { newWindowId }) => scheduleReconcile(newWindowId));
browser.tabs.onDetached.addListener((tabId, { oldWindowId }) => scheduleReconcile(oldWindowId));

browser.tabGroups.onCreated.addListener((group) => scheduleReconcile(group.windowId));
browser.tabGroups.onMoved.addListener((group) => scheduleReconcile(group.windowId));
browser.tabGroups.onRemoved.addListener((group) =>
  enqueue(() => {
    forget(group.id);
    return persist();
  }),
);
// Clicking a group label collapses it. On a stack, turn that into the accordion toggle.
browser.tabGroups.onUpdated.addListener((group) => {
  if (!group.collapsed) return scheduleReconcile(group.windowId);
  enqueue(async () => {
    if (settings.labelClick !== "expand") return reconcile(group.windowId);
    await browser.tabGroups.update(group.id, { collapsed: false });
    await setExpanded(group.id, !state.expanded.includes(group.id));
  });
});

browser.windows.onRemoved.addListener((windowId) =>
  enqueue(() => {
    delete state.active[windowId];
    return persist();
  }),
);

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  enqueue(async () => {
    settings = await getSettings();
  });
  reconcileAll();
});

const commands = {
  "next-in-stack": (tab) => cycle(tab.windowId, 1),
  "prev-in-stack": (tab) => cycle(tab.windowId, -1),
  "stack-selected": async (tab) => stackTabs(await selectedTabs(tab.windowId)),
  "toggle-expand": (tab) => setExpanded(tab.groupId, !state.expanded.includes(tab.groupId)),
  "remove-from-stack": (tab) => eject(tab.id),
};

browser.commands.onCommand.addListener((name) =>
  enqueue(async () => {
    const tab = await activeTab();
    if (tab) await commands[name]?.(tab);
  }),
);

const messages = {
  state: ({ windowId }) => describe(windowId),
  activate: ({ tabId }) => focusTab(tabId),
  close: ({ tabId }) => browser.tabs.remove(tabId),
  eject: ({ tabId }) => eject(tabId),
  rename: ({ groupId, name }) => rename(groupId, name),
  expand: ({ groupId, expand }) => setExpanded(groupId, expand),
  expandAll: ({ windowId, expand }) => setAllExpanded(windowId, expand),
  dissolve: ({ groupId }) => dissolve(groupId),
  closeStack: ({ groupId }) => closeStack(groupId),
  stackSelected: async ({ windowId }) => stackTabs(await selectedTabs(windowId)),
  stackBySite: ({ windowId }) => stackBySite(windowId),
  move: ({ tabId, groupId, beforeTabId }) => moveTab(tabId, groupId, beforeTabId),
};

browser.runtime.onMessage.addListener((message) => {
  const handler = messages[message?.type];
  return handler && enqueue(() => handler(message));
});

// --- Menus ---------------------------------------------------------------------------------

function createMenus() {
  browser.menus.removeAll();
  const item = (id, title, contexts = ["tab"]) => browser.menus.create({ id, title, contexts });
  item("stack-selected", "Stack Selected Tabs");
  item("toggle-expand", "Expand Stack");
  item("remove-from-stack", "Remove from Stack");
  item("dissolve", "Dissolve Stack");
  browser.menus.create({ id: "separator", type: "separator", contexts: ["tab"] });
  item("stack-by-site", "Stack All Tabs by Site", ["tab", "action"]);
  item("expand-all", "Expand All Stacks", ["action"]);
  item("collapse-all", "Collapse All Stacks", ["action"]);
}

let menuInstance = 0;
browser.menus.onShown.addListener(async (info, tab) => {
  if (!info.contexts.includes("tab") || !tab) return;
  const instance = ++menuInstance;
  await ready;
  const targets = await selectedTabs(tab.windowId, tab);
  if (instance !== menuInstance) return;
  const stacked = tab.groupId !== NO_GROUP;
  const expanded = state.expanded.includes(tab.groupId);
  await Promise.all([
    browser.menus.update("stack-selected", { visible: targets.length > 1, title: `Stack ${targets.length} Tabs` }),
    browser.menus.update("toggle-expand", { visible: stacked, title: expanded ? "Collapse Stack" : "Expand Stack" }),
    browser.menus.update("remove-from-stack", { visible: stacked }),
    browser.menus.update("dissolve", { visible: stacked }),
    browser.menus.update("separator", { visible: stacked || targets.length > 1 }),
  ]);
  browser.menus.refresh();
});
browser.menus.onHidden.addListener(() => menuInstance++);

browser.menus.onClicked.addListener((info, tab) =>
  enqueue(async () => {
    switch (info.menuItemId) {
      case "stack-selected":
        return stackTabs(await selectedTabs(tab.windowId, tab));
      case "toggle-expand":
        return setExpanded(tab.groupId, !state.expanded.includes(tab.groupId));
      case "remove-from-stack":
        return eject(tab.id);
      case "dissolve":
        return dissolve(tab.groupId);
      case "stack-by-site":
        return stackBySite(tab.windowId);
      case "expand-all":
      case "collapse-all":
        return setAllExpanded(tab.windowId, info.menuItemId === "expand-all");
    }
  }),
);

browser.runtime.onInstalled.addListener(createMenus);
browser.runtime.onStartup.addListener(() => {}); // wake at startup so restored stacks get folded
ready.then(reconcileAll);
