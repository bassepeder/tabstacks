"use strict";

const form = document.getElementById("settings");

async function save() {
  const settings = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const field = form.elements[key];
    settings[key] = field instanceof RadioNodeList ? field.value : field.checked;
  }
  await browser.storage.local.set({ settings });
}

(async () => {
  const settings = await getSettings();
  for (const [key, value] of Object.entries(settings)) {
    const field = form.elements[key];
    if (field instanceof RadioNodeList) field.value = value;
    else if (field) field.checked = value;
  }
  form.addEventListener("change", save);

  const [commands, platform] = await Promise.all([browser.commands.getAll(), browser.runtime.getPlatformInfo()]);
  const list = document.getElementById("shortcuts");
  for (const command of commands) {
    const description = command.name === "_execute_action" ? "Open the stack switcher" : command.description;
    const key = document.createElement("kbd");
    key.textContent = formatShortcut(command.shortcut, platform.os === "mac") || "not set";
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.append(key);
    dd.textContent = description;
    list.append(dt, dd);
  }

  document.getElementById("edit-shortcuts").addEventListener("click", async () => {
    try {
      await browser.commands.openShortcutSettings();
    } catch {
      document.getElementById("shortcuts-help").hidden = false;
    }
  });
})();
