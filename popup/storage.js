// All chrome.storage access lives here, so the rest of the app never touches
// storage keys directly.
//
// - blockedDomains / youtube / allowedChannels: chrome.storage.sync (synced across
//   the user's Chrome profile).
// - snoozed: chrome.storage.local (transient, device-local).

import {
  DEFAULT_BLOCKED,
  DEFAULT_YOUTUBE,
  DEFAULT_CHANNELS,
  DEFAULT_UNLOCK_MINUTES,
  MIN_UNLOCK_MINUTES,
  MAX_UNLOCK_MINUTES,
} from "./config.js";
import { clampMinutes, normalizeChannel, normalizeDomain } from "./util.js";

const SNOOZE_KEY = "snoozed";

/* ----------------------------- Blocked domains ---------------------------- */

/**
 * @returns {Promise<string[]>} the user's blocked domains (defaults if unset)
 */
export async function getDomains() {
  const { blockedDomains = DEFAULT_BLOCKED } =
    await chrome.storage.sync.get("blockedDomains");
  return blockedDomains;
}

/**
 * @param {string[]} domains
 */
export async function setDomains(domains) {
  await chrome.storage.sync.set({ blockedDomains: domains });
}

/* ----------------------------- YouTube focus ------------------------------ */

/**
 * @returns {Promise<typeof DEFAULT_YOUTUBE>} stored settings merged over defaults
 */
export async function getYoutubeSettings() {
  const { youtube = DEFAULT_YOUTUBE } = await chrome.storage.sync.get("youtube");
  return { ...DEFAULT_YOUTUBE, ...youtube };
}

/**
 * @param {typeof DEFAULT_YOUTUBE} settings
 */
export async function setYoutubeSettings(settings) {
  await chrome.storage.sync.set({ youtube: settings });
}

/* ---------------------------- Allowed channels ---------------------------- */

/**
 * @returns {Promise<string[]>} allow-listed channel handles
 */
export async function getChannels() {
  const { allowedChannels = [] } =
    await chrome.storage.sync.get("allowedChannels");
  return allowedChannels;
}

/**
 * @param {string[]} channels
 */
export async function setChannels(channels) {
  await chrome.storage.sync.set({ allowedChannels: channels });
}

/* ---------------------------- Unlock duration ----------------------------- */

/**
 * How long the "Unlock" action lifts a block for, in minutes. Configurable on the
 * Settings tab; falls back to the default when unset.
 * @returns {Promise<number>}
 */
export async function getUnlockMinutes() {
  const { unlockMinutes = DEFAULT_UNLOCK_MINUTES } =
    await chrome.storage.sync.get("unlockMinutes");
  return (
    clampMinutes(unlockMinutes, MIN_UNLOCK_MINUTES, MAX_UNLOCK_MINUTES) ??
    DEFAULT_UNLOCK_MINUTES
  );
}

/**
 * @param {number} minutes
 */
export async function setUnlockMinutes(minutes) {
  const clamped =
    clampMinutes(minutes, MIN_UNLOCK_MINUTES, MAX_UNLOCK_MINUTES) ??
    DEFAULT_UNLOCK_MINUTES;
  await chrome.storage.sync.set({ unlockMinutes: clamped });
}

/* --------------------------- Export / import / reset ---------------------- */

/**
 * Snapshot all synced settings into a plain object suitable for saving to a file.
 * @returns {Promise<{ blockedDomains: string[], youtube: typeof DEFAULT_YOUTUBE,
 *   allowedChannels: string[], unlockMinutes: number }>}
 */
export async function exportSettings() {
  const stored = await chrome.storage.sync.get([
    "blockedDomains",
    "youtube",
    "allowedChannels",
    "unlockMinutes",
  ]);
  return {
    blockedDomains: stored.blockedDomains ?? DEFAULT_BLOCKED,
    youtube: { ...DEFAULT_YOUTUBE, ...(stored.youtube ?? {}) },
    allowedChannels: stored.allowedChannels ?? DEFAULT_CHANNELS,
    unlockMinutes:
      clampMinutes(
        stored.unlockMinutes ?? DEFAULT_UNLOCK_MINUTES,
        MIN_UNLOCK_MINUTES,
        MAX_UNLOCK_MINUTES,
      ) ?? DEFAULT_UNLOCK_MINUTES,
  };
}

/**
 * Validate and apply settings loaded from a file. Unknown/garbage fields are
 * ignored; each recognized field is normalized the same way the UI would.
 * @param {unknown} raw parsed JSON
 * @throws {Error} if nothing recognizable is present
 */
export async function importSettings(raw) {
  if (!raw || typeof raw !== "object") {
    throw new Error("That file isn’t a Focus Guard settings file.");
  }

  /** @type {Record<string, unknown>} */
  const patch = {};

  if (Array.isArray(raw.blockedDomains)) {
    patch.blockedDomains = [
      ...new Set(
        raw.blockedDomains.map(normalizeDomain).filter((d) => d.includes(".")),
      ),
    ];
  }

  if (raw.youtube && typeof raw.youtube === "object") {
    const youtube = { ...DEFAULT_YOUTUBE };
    for (const key of Object.keys(DEFAULT_YOUTUBE)) {
      youtube[key] = Boolean(raw.youtube[key]);
    }
    patch.youtube = youtube;
  }

  if (Array.isArray(raw.allowedChannels)) {
    patch.allowedChannels = [
      ...new Set(raw.allowedChannels.map(normalizeChannel).filter(Boolean)),
    ];
  }

  if (raw.unlockMinutes != null) {
    const minutes = clampMinutes(
      raw.unlockMinutes,
      MIN_UNLOCK_MINUTES,
      MAX_UNLOCK_MINUTES,
    );
    if (minutes != null) patch.unlockMinutes = minutes;
  }

  if (Object.keys(patch).length === 0) {
    throw new Error("No Focus Guard settings found in that file.");
  }
  await chrome.storage.sync.set(patch);
}

/**
 * Restore every setting to its out-of-the-box default and clear active snoozes.
 * The background worker re-syncs the blocking rules off the storage change.
 */
export async function resetSettings() {
  await chrome.storage.sync.set({
    blockedDomains: [...DEFAULT_BLOCKED],
    youtube: { ...DEFAULT_YOUTUBE },
    allowedChannels: [...DEFAULT_CHANNELS],
    unlockMinutes: DEFAULT_UNLOCK_MINUTES,
  });
  await chrome.storage.local.remove(SNOOZE_KEY);
}

/* -------------------------------- Snooze ---------------------------------- */

/**
 * Read the expiry timestamp out of a snooze entry. Entries are normally
 * `{ start, expiry }`, but older ones may be a bare timestamp number.
 * @param {number | { start: number, expiry: number }} entry
 * @returns {number} expiry time in ms
 */
export function expiryOf(entry) {
  return typeof entry === "number" ? entry : entry.expiry;
}

/**
 * Read the raw snooze map (may include expired entries).
 * @returns {Promise<Record<string, { start: number, expiry: number }>>}
 */
async function readSnoozeMap() {
  const { [SNOOZE_KEY]: map = {} } = await chrome.storage.local.get(SNOOZE_KEY);
  return map;
}

/**
 * Snooze map with expired entries filtered out.
 * @returns {Promise<Record<string, { start: number, expiry: number }>>}
 */
export async function getActiveSnooze() {
  const map = await readSnoozeMap();
  const now = Date.now();
  return Object.fromEntries(
    Object.entries(map).filter(([, v]) => expiryOf(v) > now),
  );
}

/**
 * Record a snooze for a domain.
 * @param {string} domain
 * @param {number} start  ms timestamp the snooze began
 * @param {number} expiry ms timestamp the snooze ends
 */
export async function addSnooze(domain, start, expiry) {
  const map = await readSnoozeMap();
  map[domain] = { start, expiry };
  await chrome.storage.local.set({ [SNOOZE_KEY]: map });
}

/**
 * Clear a domain's snooze.
 * @param {string} domain
 */
export async function removeSnooze(domain) {
  const map = await readSnoozeMap();
  delete map[domain];
  await chrome.storage.local.set({ [SNOOZE_KEY]: map });
}
