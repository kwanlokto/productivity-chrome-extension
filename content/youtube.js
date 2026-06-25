// Focus Guard — YouTube content script.
// 1. Toggles <html> classes that drive youtube.css (Shorts/feed/related/etc.).
// 2. "Allowed channels only" mode: keeps a channel allowlist, hides non-allowlisted
//    videos in feeds/search/sidebar, and blocks non-allowlisted watch pages.

// Each "show" setting maps to the <html> classes that HIDE that feature when the
// toggle is OFF (see youtube.css). Defaults live in shared/core.js; this script
// reads the stored settings directly (a missing flag is falsy = off).
const CLASS_MAP = {
  showShorts: ["fg-hide-shorts"],
  showHomeFeed: ["fg-hide-home"],
  showRecommendations: ["fg-hide-related"],
  showComments: ["fg-hide-comments"]
};

// Live state, refreshed from storage.
let settings = {};
let allowedChannels = [];
// Per-session "watch anyway" bypass — video ids the user chose to watch.
const bypassed = new Set();

// The bundled sprout image as a web-accessible extension URL.
const SPROUT_URL = chrome.runtime.getURL("popup/sprout.png");

/** A fresh sprout <img> for the injected message/badge elements. */
function sproutImg() {
  const img = document.createElement("img");
  img.src = SPROUT_URL;
  img.alt = "";
  return img;
}

// ---------- CSS-class toggles ----------

/** Apply each feature's hide-classes when tweaks are on and the feature is OFF. */
function applyClasses() {
  const root = document.documentElement;
  for (const [key, classNames] of Object.entries(CLASS_MAP)) {
    // Toggles are "show" switches: hide the feature when it's switched off.
    const hide = Boolean(settings.enabled && !settings[key]);
    for (const className of classNames) root.classList.toggle(className, hide);
  }
}

/**
 * When the home feed is hidden, show a "home feed hidden" message (with the sprout
 * image) in its place. Injected as a real element so the image can't be clipped.
 */
function applyHomeMessage() {
  const home = document.querySelector('ytd-browse[page-subtype="home"]:not([hidden])');
  const active = Boolean(settings.enabled && !settings.showHomeFeed && home);
  const existing = document.getElementById("fg-home-msg");

  if (!active) {
    existing?.remove();
    return;
  }
  if (existing && existing.parentElement === home) return; // already in place

  existing?.remove();
  const msg = document.createElement("div");
  msg.id = "fg-home-msg";
  const p = document.createElement("p");
  p.textContent = "Home feed hidden by Focus Guard. Search for what you actually came for.";
  msg.append(sproutImg(), p);
  home.appendChild(msg);
}

// ---------- Channel matching ----------

/**
 * Normalize a channel handle/name into a comparison key: lowercase, no leading
 * @, no spaces. This matches the format the popup stores channels in, so a
 * stored "khanacademy" matches both the handle "khanacademy" and the display
 * name "Khan Academy".
 * @param {string} s
 * @returns {string}
 */
function channelKey(s) {
  return String(s || "").toLowerCase().replace(/^@/, "").replace(/\s+/g, "").trim();
}

/**
 * Is the channel (by handle or display name) on the allow list? Matches exactly
 * — no substring matching, which previously allowed unrelated channels through.
 * @param {{ handle: string, name: string }} info
 * @returns {boolean}
 */
function channelAllowed(info) {
  const handle = channelKey(info.handle);
  const name = channelKey(info.name);
  return allowedChannels.some((raw) => {
    const e = channelKey(raw);
    return e !== "" && (handle === e || name === e);
  });
}

/**
 * Pull a channel handle (/@handle) and display name out of a video card or
 * watch-page owner element.
 * @param {Element} scope element to search within
 * @returns {{ handle: string, name: string, hasInfo: boolean }}
 */
function getChannelInfo(scope) {
  const link =
    scope.querySelector('a[href^="/@"]') ||
    scope.querySelector("ytd-channel-name a") ||
    scope.querySelector('a.yt-simple-endpoint[href*="/@"]') ||
    scope.querySelector('a[href^="/channel/"], a[href^="/c/"]');
  let handle = "";
  let name = "";
  if (link) {
    const href = link.getAttribute("href") || "";
    const m = href.match(/\/@([^/?#]+)/);
    if (m) handle = m[1];
    name = (link.textContent || "").trim();
  }
  if (!name) {
    const nameEl = scope.querySelector(
      'ytd-channel-name #text, #channel-name #text, #text.ytd-channel-name'
    );
    if (nameEl) name = nameEl.textContent.trim();
  }
  return { handle, name, hasInfo: Boolean(handle || name) };
}

const ITEM_SELECTOR = [
  "ytd-rich-item-renderer",
  "ytd-video-renderer",
  "ytd-grid-video-renderer",
  "ytd-compact-video-renderer"
].join(",");

/** Hide feed/search/sidebar video cards that aren't from an allow-listed channel. */
function filterItems() {
  const active = settings.enabled && settings.allowedChannelsOnly;
  const items = document.querySelectorAll(ITEM_SELECTOR);
  let hiddenCount = 0;
  for (const item of items) {
    if (!active) {
      item.classList.remove("fg-edu-hidden");
      continue;
    }
    const info = getChannelInfo(item);
    // Channel not rendered yet — leave it; the observer will revisit.
    if (!info.hasInfo) continue;
    const block = !channelAllowed(info);
    item.classList.toggle("fg-edu-hidden", block);
    if (block) hiddenCount++;
  }
  applyFilterIndicator(active && hiddenCount > 0);
}

/**
 * Show a small fixed badge while the channel allow-list is filtering items, so a
 * feed/sidebar that looks empty has an on-page explanation.
 * @param {boolean} show
 */
function applyFilterIndicator(show) {
  let note = document.getElementById("fg-filter-note");
  if (!show) {
    note?.remove();
    return;
  }
  if (note) return; // already shown
  note = document.createElement("div");
  note.id = "fg-filter-note";
  const span = document.createElement("span");
  span.textContent = "Focus Guard — allowed channels only";
  note.append(sproutImg(), span);
  document.body.appendChild(note);
}

// ---------- Watch-page block overlay ----------

/**
 * Channel info for the video on the current watch page.
 * @returns {{ handle: string, name: string, hasInfo: boolean }}
 */
function getWatchChannelInfo() {
  const owner =
    document.querySelector("ytd-watch-metadata #owner") ||
    document.querySelector("#owner.ytd-watch-metadata") ||
    document.querySelector("ytd-video-owner-renderer");
  return owner ? getChannelInfo(owner) : { handle: "", name: "", hasInfo: false };
}

/** Remove the watch-page block overlay if present. */
function removeOverlay() {
  document.getElementById("fg-edu-overlay")?.remove();
}

/**
 * Build the overlay's message line for a channel.
 * @param {{ name: string }} info
 * @returns {string} HTML
 */
function overlayMessage(info) {
  const who = info.name ? escapeHtml(info.name) : "This channel";
  return `${who} isn't in your allowed channels list.`;
}

/**
 * Pause the video and show the "channel not allowed" block overlay. If an overlay
 * is already up (e.g. we navigated to another blocked video, or the channel
 * metadata just finished loading), its message is updated in place rather than
 * left showing the previous video's channel.
 * @param {string|null} videoId current video id (for the "watch anyway" bypass)
 * @param {{ name: string }} info channel info, for the message
 */
function showOverlay(videoId, info) {
  document.querySelector("video")?.pause();

  const existing = document.getElementById("fg-edu-overlay");
  if (existing) {
    existing.dataset.videoId = videoId || "";
    const msg = existing.querySelector(".fg-msg");
    if (msg) msg.innerHTML = overlayMessage(info);
    // Re-point "watch anyway" at the current video.
    existing.querySelector("#fg-watch-anyway").onclick = () => {
      if (videoId) bypassed.add(videoId);
      removeOverlay();
      document.querySelector("video")?.play();
    };
    return;
  }

  const overlay = document.createElement("div");
  overlay.id = "fg-edu-overlay";
  overlay.dataset.videoId = videoId || "";
  overlay.innerHTML = `
    <div class="fg-box">
      <div class="fg-emoji">📚</div>
      <h1>Channel not allowed</h1>
      <p class="fg-msg">${overlayMessage(info)}</p>
      <div class="fg-actions">
        <button id="fg-go-back">
          <svg class="fg-back-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M19 12H5" />
            <path d="M11 18l-6-6 6-6" />
          </svg>
          Go back
        </button>
        <button id="fg-watch-anyway">Watch anyway</button>
      </div>
    </div>`;
  document.documentElement.appendChild(overlay);

  overlay.querySelector("#fg-go-back").addEventListener("click", () => {
    if (history.length > 1) history.back();
    else location.href = "https://www.youtube.com";
  });
  overlay.querySelector("#fg-watch-anyway").onclick = () => {
    if (videoId) bypassed.add(videoId);
    removeOverlay();
    document.querySelector("video")?.play();
  };
}

/**
 * Escape a string for safe insertion into overlay HTML.
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

let lastWatchLog = "";

/** Show/clear the block overlay for the current watch page per the allow list. */
function enforceWatchPage() {
  if (location.pathname !== "/watch") {
    removeOverlay();
    return;
  }

  const active = settings.enabled && settings.allowedChannelsOnly;
  const videoId = new URLSearchParams(location.search).get("v");
  const info = getWatchChannelInfo();

  // Log once per (video, state) so we can see why something does/doesn't block.
  const logKey = `${videoId}|${active}|${info.handle}|${info.hasInfo}`;
  if (logKey !== lastWatchLog) {
    lastWatchLog = logKey;
    console.debug("[Focus Guard] watch page:", {
      enabled: settings.enabled,
      allowedChannelsOnly: settings.allowedChannelsOnly,
      channelHandle: info.handle,
      channelName: info.name,
      hasInfo: info.hasInfo,
      allowed: info.hasInfo ? channelAllowed(info) : "(channel not detected yet)",
      allowList: allowedChannels,
    });
  }

  if (!active) {
    removeOverlay();
    return;
  }
  if (videoId && bypassed.has(videoId)) {
    removeOverlay();
    return;
  }
  if (!info.hasInfo) return; // metadata not loaded yet; observer will retry
  if (channelAllowed(info)) {
    removeOverlay();
  } else {
    showOverlay(videoId, info);
  }
}

// ---------- Run loop ----------
let scheduled = false;

/** Coalesce rapid DOM mutations into one apply pass per animation frame. */
function refresh() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    applyClasses();
    applyHomeMessage();
    filterItems();
    enforceWatchPage();
  });
}

/** Load settings from storage and kick off the first pass. */
function loadAndStart() {
  chrome.storage.sync.get(["youtube", "allowedChannels"]).then((data) => {
    settings = data.youtube || {};
    allowedChannels = data.allowedChannels || [];
    refresh();
  });
}

loadAndStart();

// YouTube lazy-loads everything, so watch the DOM and re-filter as cards appear.
new MutationObserver(refresh).observe(document.documentElement, {
  childList: true,
  subtree: true
});

// SPA navigation between videos/pages.
window.addEventListener("yt-navigate-finish", refresh);

// Live-update when settings change in the popup.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.youtube) settings = changes.youtube.newValue || {};
  if (changes.allowedChannels) allowedChannels = changes.allowedChannels.newValue || [];
  if (changes.youtube || changes.allowedChannels) refresh();
});
