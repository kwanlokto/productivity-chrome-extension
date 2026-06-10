// Shared constants for the popup.

/** Domains blocked out of the box on first install. */
export const DEFAULT_BLOCKED = ["facebook.com", "instagram.com", "tiktok.com"];

/** Default YouTube focus settings (mirrors the defaults in background.js). */
export const DEFAULT_YOUTUBE = {
  enabled: false,
  showShorts: false,
  showHomeFeed: false,
  showRecommendations: false,
  showComments: false,
  allowedChannelsOnly: false,
};

/** Channels allow-listed out of the box (mirrors the defaults in background.js). */
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

/** How long the "Unlock" action lifts a block for, in minutes, until the user
 *  changes it on the Settings tab. */
export const DEFAULT_UNLOCK_MINUTES = 5;

/** Allowed range for the configurable unlock duration (1 min … 24 h). */
export const MIN_UNLOCK_MINUTES = 1;
export const MAX_UNLOCK_MINUTES = 1440;

/** Circumference of the countdown ring (must match the SVG circle r=54). */
export const RING_CIRCUMFERENCE = 2 * Math.PI * 54;
