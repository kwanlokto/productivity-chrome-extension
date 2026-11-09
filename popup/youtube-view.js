// "YouTube" tab: focus switches and the allowed-channels list.

import { normalizeChannel, reanimate } from "./util.js";
import {
  getYoutubeSettings,
  setYoutubeSettings,
  getChannels,
  setChannels,
} from "./storage.js";

const REMOVE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

let channelListEl, channelEmptyEl, channelFormEl, channelInputEl;
let mainView, manageView, openChannelsBtn, backBtn, channelsSummary, allowlistHint;

// How many channels are allowed, for the "Allowed channels" row.
let channelCount = 0;

/** @param {string} key a DEFAULT_YOUTUBE key */
const toggleFor = (key) => document.querySelector(`[data-yt="${key}"]`);

/* ---------------------------- Enable/disable UI --------------------------- */

/**
 * Say what the allow-list is doing: on the "Allowed channels" row ("Off", or how
 * many channels), and under its switch. The list itself stays editable either
 * way, so it can be set up before it's turned on.
 */
function paintAllowlist() {
  const on = toggleFor("allowedChannelsOnly").checked;
  allowlistHint.textContent = on
    ? "On · other channels are hidden"
    : "Off · every channel is shown";
  channelsSummary.textContent = on
    ? `${channelCount} ${channelCount === 1 ? "channel" : "channels"}`
    : "Off";
}

/**
 * Disable and dim every sub-option, and the way into the channel list, while
 * "YouTube focus" is off.
 * @param {boolean} enabled
 */
function applyYoutubeEnabled(enabled) {
  document.querySelectorAll("[data-yt]").forEach((el) => {
    if (el.dataset.yt === "enabled") return; // never disable the master itself
    el.disabled = !enabled;
    el.closest(".row")?.classList.toggle("is-disabled", !enabled);
  });
  openChannelsBtn.disabled = !enabled;
}

/* ------------------------------- Toggles ---------------------------------- */

/**
 * Reflect stored settings into the switches. Pure paint — binds nothing, so it's
 * safe to call on every refresh.
 * @param {Record<string, boolean>} settings
 */
function applyToggleStates(settings) {
  document.querySelectorAll("[data-yt]").forEach((el) => {
    el.checked = Boolean(settings[el.dataset.yt]);
  });
  applyYoutubeEnabled(Boolean(settings.enabled));
  paintAllowlist();
}

/**
 * Bind every [data-yt] switch to persist on change. Call once — state itself is
 * painted by applyToggleStates.
 */
function bindToggles() {
  document.querySelectorAll("[data-yt]").forEach((el) => {
    const key = el.dataset.yt;
    el.addEventListener("change", async () => {
      const current = await getYoutubeSettings();
      current[key] = el.checked;
      await setYoutubeSettings(current);
      if (key === "enabled") applyYoutubeEnabled(el.checked);
      if (key === "allowedChannelsOnly") paintAllowlist();
    });
  });
}

/* --------------------------- Allowed channels ----------------------------- */

/**
 * Render the allowed-channels list.
 * @param {string[]} channels
 */
function renderChannels(channels) {
  channelCount = channels.length;
  channelListEl.replaceChildren();
  channelListEl.classList.toggle("hidden", channels.length === 0);
  channelEmptyEl.classList.toggle("hidden", channels.length > 0);

  for (const channel of channels) {
    const li = document.createElement("li");

    const name = document.createElement("span");
    name.className = "item-name";
    name.textContent = "@" + channel;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "remove-btn";
    btn.title = "Remove";
    btn.setAttribute("aria-label", `Remove @${channel}`);
    btn.innerHTML = REMOVE_ICON;
    btn.addEventListener("click", async () => {
      await setChannels((await getChannels()).filter((c) => c !== channel));
      renderChannels(await getChannels());
    });

    li.append(name, btn);
    channelListEl.appendChild(li);
  }
  paintAllowlist();
}

/**
 * Switch between the main (switches) view and the channel list, sliding the
 * incoming view in (from the right going forward, from the left going back).
 * @param {boolean} showManage
 */
function setChannelsView(showManage) {
  const [from, to] = showManage ? [mainView, manageView] : [manageView, mainView];
  from.classList.add("hidden");
  to.classList.remove("hidden");
  reanimate(to, showManage ? "slide-in-right" : "slide-in-left");
}

/** Wire the "Allowed channels" row and the list's Back button. */
function bindChannelsNav() {
  openChannelsBtn.addEventListener("click", () => setChannelsView(true));
  backBtn.addEventListener("click", () => setChannelsView(false));
}

/** Wire up the add-channel form. */
function bindChannelForm() {
  channelFormEl.addEventListener("submit", async (e) => {
    e.preventDefault();
    const channel = normalizeChannel(channelInputEl.value);
    if (!channel) {
      channelInputEl.value = "";
      return;
    }
    const channels = await getChannels();
    if (!channels.includes(channel)) {
      await setChannels([...channels, channel]);
      renderChannels(await getChannels());
    }
    channelInputEl.value = "";
  });
}

/**
 * Re-read the YouTube settings + channels and repaint. Used on init and whenever
 * another surface (the Settings tab's reset/import) rewrites them.
 */
async function refreshFromStorage() {
  const [settings, channels] = await Promise.all([
    getYoutubeSettings(),
    getChannels(),
  ]);
  renderChannels(channels);
  applyToggleStates(settings);
}

/** Repaint when the YouTube settings or channel list change from elsewhere. */
function bindStorageSync() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && (changes.youtube || changes.allowedChannels)) {
      refreshFromStorage();
    }
  });
}

/** Initialize the YouTube tab. */
export async function initYoutubeView() {
  channelListEl = document.getElementById("channel-list");
  channelEmptyEl = document.getElementById("channel-empty");
  channelFormEl = document.getElementById("channel-form");
  channelInputEl = document.getElementById("channel-input");

  mainView = document.getElementById("youtube-main");
  manageView = document.getElementById("youtube-manage");
  openChannelsBtn = document.getElementById("open-channels");
  backBtn = document.getElementById("back-to-youtube");
  channelsSummary = document.getElementById("channels-summary");
  allowlistHint = document.getElementById("allowlist-hint");

  bindChannelsNav();
  bindToggles(); // bind once; state is painted by refreshFromStorage
  bindChannelForm();
  bindStorageSync();
  await refreshFromStorage(); // needs DOM refs set
}
