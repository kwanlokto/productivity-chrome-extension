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

/** How long the "Unblock" action lifts a block for, in minutes. */
export const SNOOZE_MINUTES = 5;

/** Circumference of the countdown ring (must match the SVG circle r=54). */
export const RING_CIRCUMFERENCE = 2 * Math.PI * 54;
