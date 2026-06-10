// "Settings" tab: configurable unlock duration, backup/restore to a file, and
// reset-to-defaults.

import { MAX_UNLOCK_MINUTES, MIN_UNLOCK_MINUTES } from "./config.js";
import { clampMinutes } from "./util.js";
import {
  getUnlockMinutes,
  setUnlockMinutes,
  exportSettings,
  importSettings,
  resetSettings,
} from "./storage.js";

let unlockForm, unlockInput, exportBtn, importBtn, importFile, resetBtn, statusEl;

// The "Reset" button is a two-step confirm: first click arms it, second resets.
let resetArmed = false;
let resetTimer = null;
let statusTimer = null;

/* ------------------------------ Status line ------------------------------- */

/**
 * Flash a short status message under the controls.
 * @param {string} message
 * @param {"ok" | "error"} [kind]
 */
function setStatus(message, kind = "ok") {
  statusEl.textContent = message;
  statusEl.classList.toggle("is-error", kind === "error");
  statusEl.classList.toggle("is-ok", kind !== "error");
  clearTimeout(statusTimer);
  if (message) {
    statusTimer = setTimeout(() => {
      statusEl.textContent = "";
    }, 3500);
  }
}

/* ----------------------------- Unlock duration ---------------------------- */

/** Reflect the stored unlock duration into the input. */
async function loadUnlock() {
  unlockInput.value = String(await getUnlockMinutes());
}

function bindUnlockForm() {
  unlockForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const minutes = clampMinutes(
      unlockInput.value,
      MIN_UNLOCK_MINUTES,
      MAX_UNLOCK_MINUTES,
    );
    if (minutes == null) {
      setStatus(`Enter a number from ${MIN_UNLOCK_MINUTES} to ${MAX_UNLOCK_MINUTES}.`, "error");
      return;
    }
    await setUnlockMinutes(minutes);
    unlockInput.value = String(minutes); // show the clamped value
    setStatus(`Unlock duration saved — ${minutes} min.`);
  });
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
      setStatus("Settings saved to file.");
    } catch (e) {
      console.error("[Focus Guard] export failed:", e);
      setStatus("Couldn’t save settings.", "error");
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
      await importSettings(data);
      await loadUnlock();
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
  resetBtn.textContent = "Reset everything to defaults";
  resetBtn.classList.remove("is-armed");
}

function bindReset() {
  resetBtn.addEventListener("click", async () => {
    if (!resetArmed) {
      resetArmed = true;
      resetBtn.textContent = "Click again to confirm reset";
      resetBtn.classList.add("is-armed");
      resetTimer = setTimeout(disarmReset, 4000);
      return;
    }
    disarmReset();
    try {
      await resetSettings();
      await loadUnlock();
      setStatus("Everything reset to defaults.");
    } catch (e) {
      console.error("[Focus Guard] reset failed:", e);
      setStatus("Couldn’t reset settings.", "error");
    }
  });
}

/* -------------------------------- Init ------------------------------------ */

/** Initialize the Settings tab. */
export async function initSettingsView() {
  unlockForm = document.getElementById("unlock-form");
  unlockInput = document.getElementById("unlock-input");
  exportBtn = document.getElementById("export-btn");
  importBtn = document.getElementById("import-btn");
  importFile = document.getElementById("import-file");
  resetBtn = document.getElementById("reset-btn");
  statusEl = document.getElementById("settings-status");

  await loadUnlock();
  bindUnlockForm();
  bindExport();
  bindImport();
  bindReset();
}
