// Pure, side-effect-free helpers.

// normalizeDomain is shared with the background worker — re-exported from the
// single source of truth so popup code can keep importing it from here.
export { normalizeDomain } from "../shared/core.js";

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
 * Coerce arbitrary input into a whole number of minutes within [min, max].
 * Returns null when the input isn't a finite number, so callers can reject it.
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @returns {number | null}
 */
export function clampMinutes(value, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, n));
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

/**
 * (Re)start a one-shot CSS animation class on an element, even if it's already
 * applied — removes it, forces a reflow, then re-adds it.
 * @param {HTMLElement} el
 * @param {string} className
 */
export function reanimate(el, className) {
  el.classList.remove(className);
  void el.offsetWidth; // force reflow so the animation can replay
  el.classList.add(className);
}
