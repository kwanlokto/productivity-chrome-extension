// All chrome.storage access lives here, so the rest of the app never touches
// storage keys directly.
//
// - blockedDomains / youtube / allowedChannels: chrome.storage.sync (synced across
//   the user's Chrome profile).
// - snoozed: chrome.storage.local (transient, device-local).

import { DEFAULT_BLOCKED, DEFAULT_YOUTUBE } from "./config.js";

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
