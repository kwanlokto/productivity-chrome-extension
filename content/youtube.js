// Focus Guard — YouTube content script.
// Toggles <html> classes that drive youtube.css, based on stored settings.
// Runs at document_start and re-applies across YouTube's SPA navigations.

const DEFAULT_YOUTUBE = {
  enabled: true,
  hideShorts: true,
  hideHomeFeed: true,
  hideRelated: true,
  hideComments: false,
  grayscale: false
};

const CLASS_MAP = {
  hideShorts: "fg-hide-shorts",
  hideHomeFeed: "fg-hide-home",
  hideRelated: "fg-hide-related",
  hideComments: "fg-hide-comments",
  grayscale: "fg-grayscale"
};

function apply(settings) {
  const s = { ...DEFAULT_YOUTUBE, ...settings };
  const root = document.documentElement;
  for (const [key, className] of Object.entries(CLASS_MAP)) {
    // A feature is on only when the master switch AND its own toggle are enabled.
    root.classList.toggle(className, Boolean(s.enabled && s[key]));
  }
}

// Disable YouTube autoplay-next toggle when recommendations are hidden.
function disableAutoplay(settings) {
  if (!settings.enabled || !settings.hideRelated) return;
  const btn = document.querySelector(".ytp-autonav-toggle-button[aria-checked='true']");
  if (btn) btn.click();
}

chrome.storage.sync.get("youtube").then(({ youtube }) => {
  const settings = { ...DEFAULT_YOUTUBE, ...youtube };
  apply(settings);

  // Re-apply on SPA navigation and try to kill autoplay once the player loads.
  window.addEventListener("yt-navigate-finish", () => {
    apply(settings);
    setTimeout(() => disableAutoplay(settings), 1500);
  });
  setTimeout(() => disableAutoplay(settings), 2500);
});

// Live-update when the user changes settings in the popup.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.youtube) {
    apply(changes.youtube.newValue || {});
  }
});
