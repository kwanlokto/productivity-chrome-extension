// Single source of truth for constants and pure helpers shared between the
// background service worker and the popup. (The content script reads settings
// straight from storage, so it doesn't import this.)

/* ------------------------------- Constants -------------------------------- */

/** Domains blocked out of the box on first install. */
export const DEFAULT_BLOCKED = ["facebook.com", "instagram.com", "tiktok.com"];

/** Default YouTube focus settings. Each "show*" flag defaults off. */
export const DEFAULT_YOUTUBE = {
  enabled: true,
  showShorts: false,
  showHomeFeed: false,
  showRecommendations: false,
  showComments: false,
  allowedChannelsOnly: false,
};

/** Channels allow-listed out of the box. */
export const DEFAULT_CHANNELS = [
  "khanacademy",
  "veritasium",
  "3blue1brown",
  "mitocw",
  "crashcourse",
  "TED",
  "TEDEd",
  "kurzgesagt",
];

/** Default for the "Unlock" duration, in minutes, until the user changes it. */
export const DEFAULT_UNLOCK_MINUTES = 5;

/** Allowed range for the configurable unlock duration (1 min … 24 h). */
export const MIN_UNLOCK_MINUTES = 1;
export const MAX_UNLOCK_MINUTES = 1440;

/** Default duration suggested when pausing the whole extension, in minutes. */
export const DEFAULT_PAUSE_MINUTES = 15;

/* -------------------------------- Helpers --------------------------------- */

/**
 * Reduce arbitrary user input to a bare registrable domain.
 * e.g. "https://www.Facebook.com/feed?x=1" -> "facebook.com"
 * @param {string} input
 * @returns {string} the cleaned domain, or "" if input was empty
 */
export function normalizeDomain(input) {
  if (!input) return "";
  let d = String(input).trim().toLowerCase();
  d = d.replace(/^https?:\/\//, ""); // strip scheme
  d = d.replace(/^www\./, ""); // strip leading www.
  d = d.split("/")[0].split("?")[0].split("#")[0]; // drop path/query/hash
  d = d.replace(/[^a-z0-9.\-]/g, ""); // keep only valid host chars
  return d;
}

/** Escape regex metacharacters in a domain. */
export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Regex matching http(s) URLs for a domain and its subdomains, capturing the
 * full URL. Anchored so "facebook.com.evil.com" does NOT match. This string is a
 * rule's identity — rules are matched/removed by it.
 * @param {string} domain
 * @returns {string}
 */
export function blockRegexFor(domain) {
  return "^https?://([^/]+\\.)?" + escapeRegex(domain) + "([:/?#].*)?$";
}

/**
 * Redirect target: blocked.html carrying the domain and the full original URL.
 * \0 is replaced by the whole matched URL; `url` is last so the blocked page can
 * read everything after "url=" as the original URL.
 * @param {string} domain
 * @returns {string}
 */
export function blockSubstitutionFor(domain) {
  return chrome.runtime.getURL("blocked.html") + "?domain=" + domain + "&url=\\0";
}
