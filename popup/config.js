// Popup constants. Shared defaults come from shared/core.js (one source of truth
// for the background worker and the popup); only popup-specific bits live here.

export {
  DEFAULT_BLOCKED,
  DEFAULT_YOUTUBE,
  DEFAULT_CHANNELS,
  DEFAULT_UNLOCK_MINUTES,
  MIN_UNLOCK_MINUTES,
  MAX_UNLOCK_MINUTES,
  DEFAULT_PAUSE_MINUTES,
} from "../shared/core.js";

/** Circumference of the countdown ring (must match the SVG circle r=54). */
export const RING_CIRCUMFERENCE = 2 * Math.PI * 54;
