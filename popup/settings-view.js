// "Settings" tab: the unlock and break lengths, backup/restore to a file, and
// reset-to-defaults.

import { MAX_UNLOCK_MINUTES, MIN_UNLOCK_MINUTES } from "./config.js";
import { clampMinutes } from "./util.js";
import {
  getUnlockMinutes,
  setUnlockMinutes,
  getPauseMinutes,
  setPauseMinutes,
  exportSettings,
  importSettings,
  resetSettings,
} from "./storage.js";

const MIN = MIN_UNLOCK_MINUTES;
const MAX = MAX_UNLOCK_MINUTES;

let exportBtn, importBtn, importFile, resetBtn, resetLabel, statusEl;

/** The two minute fields, set up in initSettingsView. */
let unlockField, pauseField;

// The "Reset" button is a two-step confirm: first click arms it, second resets.
let resetArmed = false;
let resetTimer = null;
let statusTimer = null;

/* ------------------------------ Status line ------------------------------- */

/**
 * Flash a short status message over the bottom of the tab.
 * @param {string} message
 * @param {"ok" | "error"} [kind]
 */
function setStatus(message, kind = "ok") {
  statusEl.textContent = message;
  statusEl.classList.toggle("is-error", kind === "error");
  clearTimeout(statusTimer);
  if (message) {
    statusTimer = setTimeout(() => {
      statusEl.textContent = "";
    }, 3500);
  }
}

/* ------------------------------ Minute fields ----------------------------- */

/**
 * Wire a minutes field with its − / + buttons. Typing saves when the field is
 * committed (blur or Enter); − and + step by one minute and save straight away.
 * @param {{ input: HTMLInputElement, less: HTMLButtonElement,
 *   more: HTMLButtonElement, get: () => Promise<number>,
 *   set: (minutes: number) => Promise<void>, name: string }} parts
 *   `name` starts the "… saved" message.
 * @returns {{ input: HTMLInputElement, load: () => Promise<void> }}
 */
function minutesField({ input, less, more, get, set, name }) {
  function paintSteppers() {
    const n = Number(input.value);
    less.disabled = !(n > MIN);
    more.disabled = !(n < MAX);
  }

  async function load() {
    input.value = String(await get());
    paintSteppers();
  }

  /** Persist the entered value. Empty/invalid input reverts to the saved value. */
  async function save({ quiet = false } = {}) {
    if (input.value.trim() === "") {
      await load();
      return;
    }
    const minutes = clampMinutes(input.value, MIN, MAX);
    if (minutes == null) {
      await load();
      setStatus(`Enter a number from ${MIN} to ${MAX}.`, "error");
      return;
    }
    await set(minutes);
    input.value = String(minutes); // show the clamped value
    paintSteppers();
    if (!quiet) setStatus(`${name} saved — ${minutes} min.`);
  }

  function step(delta) {
    const current = clampMinutes(input.value, MIN, MAX) ?? MIN;
    input.value = String(clampMinutes(current + delta, MIN, MAX));
    save({ quiet: true });
  }

  input.addEventListener("change", () => save());
  // Enter has no form to submit, so blur to trigger the same `change` path.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") input.blur();
  });
  input.addEventListener("input", paintSteppers);
  less.addEventListener("click", () => step(-1));
  more.addEventListener("click", () => step(1));

  return { input, load };
}

/* ----------------------------- Backup / restore --------------------------- */

function bindExport() {
  exportBtn.addEventListener("click", async () => {
    try {
      const data = await exportSettings();
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "focus-guard-settings.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("Settings exported to a file.");
    } catch (e) {
      console.error("[Focus Guard] export failed:", e);
      setStatus("Couldn’t export settings.", "error");
    }
  });
}

function bindImport() {
  importBtn.addEventListener("click", () => importFile.click());
  importFile.addEventListener("change", async () => {
    const file = importFile.files?.[0];
    importFile.value = ""; // let the same file be picked again later
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      await importSettings(data); // the storage listener refreshes the fields
      setStatus("Settings loaded.");
    } catch (e) {
      console.error("[Focus Guard] import failed:", e);
      const message =
        e instanceof SyntaxError
          ? "That file isn’t valid JSON."
          : e.message || "Couldn’t load settings.";
      setStatus(message, "error");
    }
  });
}

/* --------------------------------- Reset ---------------------------------- */

function disarmReset() {
  resetArmed = false;
  clearTimeout(resetTimer);
  resetLabel.textContent = "Reset to defaults";
  resetBtn.classList.remove("is-armed");
}

function bindReset() {
  resetBtn.addEventListener("click", async () => {
    if (!resetArmed) {
      resetArmed = true;
      resetLabel.textContent = "Click again to confirm";
      resetBtn.classList.add("is-armed");
      resetTimer = setTimeout(disarmReset, 4000);
      return;
    }
    disarmReset();
    try {
      await resetSettings(); // the storage listener refreshes the fields
      setStatus("Everything reset to defaults.");
    } catch (e) {
      console.error("[Focus Guard] reset failed:", e);
      setStatus("Couldn’t reset settings.", "error");
    }
  });
}

/* ------------------------------ Storage sync ------------------------------ */

/**
 * Keep the minute fields in sync when they change from elsewhere: Import,
 * Reset, or another device via Chrome sync. A field the user is editing is left
 * alone.
 */
function bindStorageSync() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.unlockMinutes && document.activeElement !== unlockField.input) {
      unlockField.load();
    }
    if (changes.pauseMinutes && document.activeElement !== pauseField.input) {
      pauseField.load();
    }
  });
}

/* -------------------------------- Init ------------------------------------ */

/** Initialize the Settings tab. */
export async function initSettingsView() {
  exportBtn = document.getElementById("export-btn");
  importBtn = document.getElementById("import-btn");
  importFile = document.getElementById("import-file");
  resetBtn = document.getElementById("reset-btn");
  resetLabel = document.getElementById("reset-label");
  statusEl = document.getElementById("settings-status");

  unlockField = minutesField({
    input: document.getElementById("unlock-input"),
    less: document.getElementById("unlock-less"),
    more: document.getElementById("unlock-more"),
    get: getUnlockMinutes,
    set: setUnlockMinutes,
    name: "Unlock length",
  });
  pauseField = minutesField({
    input: document.getElementById("pause-input"),
    less: document.getElementById("pause-less"),
    more: document.getElementById("pause-more"),
    get: getPauseMinutes,
    set: setPauseMinutes,
    name: "Break length",
  });

  await unlockField.load();
  await pauseField.load();
  bindExport();
  bindImport();
  bindReset();
  bindStorageSync();
}
