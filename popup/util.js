// Pure, side-effect-free helpers.

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

/**
 * Normalize a YouTube channel handle for storage/matching.
 * e.g. "@Veritasium " -> "veritasium"
 * @param {string} input
 * @returns {string}
 */
export function normalizeChannel(input) {
  return String(input || "")
    .trim()
    .replace(/^@/, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/**
 * Format a millisecond duration as a "m:ss" clock string.
 * @param {number} ms
 * @returns {string} e.g. "4:07"
 */
export function formatClock(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
