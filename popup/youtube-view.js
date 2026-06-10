// "YouTube" tab: focus toggles and the allowed-channels list.

import { normalizeChannel } from "./util.js";
import {
  getYoutubeSettings,
  setYoutubeSettings,
  getChannels,
  setChannels,
} from "./storage.js";

let channelListEl, channelEmptyEl, channelFormEl, channelInputEl;
let mainView, manageView, openChannelsBtn, backBtn;

/* ---------------------------- Enable/disable UI --------------------------- */

/**
 * The "Change allowed channels" button is only usable when YouTube tweaks are on
 * AND "Allowed channels only" is on — otherwise disable (dim) it.
 */
function applyChannelsEnabled() {
  const masterOn = document.querySelector('[data-yt="enabled"]').checked;
  const allowlistOn = document.querySelector(
    '[data-yt="allowedChannelsOnly"]',
  ).checked;
  openChannelsBtn.disabled = !(masterOn && allowlistOn);
}

/**
 * Disable + dim every sub-toggle when the master "Enable YouTube tweaks" is off.
 * @param {boolean} enabled
 */
function applyYoutubeEnabled(enabled) {
  document.querySelectorAll("[data-yt]").forEach((el) => {
    if (el.dataset.yt === "enabled") return; // never disable the master itself
    el.disabled = !enabled;
    el.closest(".toggle")?.classList.toggle("is-disabled", !enabled);
  });
  applyChannelsEnabled();
}

/* ------------------------------- Toggles ---------------------------------- */

/**
 * Bind every [data-yt] checkbox to its stored setting and persist on change.
 * @param {Record<string, boolean>} settings
 */
function bindToggles(settings) {
  document.querySelectorAll("[data-yt]").forEach((el) => {
    const key = el.dataset.yt;
    el.checked = Boolean(settings[key]);
    el.addEventListener("change", async () => {
      const current = await getYoutubeSettings();
      current[key] = el.checked;
      await setYoutubeSettings(current);
      if (key === "enabled") applyYoutubeEnabled(el.checked);
      if (key === "allowedChannelsOnly") applyChannelsEnabled();
    });
  });
  applyYoutubeEnabled(Boolean(settings.enabled));
}

/* --------------------------- Allowed channels ----------------------------- */

/**
 * Render the allowed-channels list.
 * @param {string[]} channels
 */
function renderChannels(channels) {
  channelListEl.innerHTML = "";
  channelEmptyEl.classList.toggle("hidden", channels.length > 0);

  for (const channel of channels) {
    const li = document.createElement("li");

    const span = document.createElement("span");
    span.textContent = "@" + channel;

    const btn = document.createElement("button");
    btn.textContent = "✕";
    btn.title = "Remove";
    btn.addEventListener("click", async () => {
      await setChannels((await getChannels()).filter((c) => c !== channel));
      renderChannels(await getChannels());
    });

    li.append(span, btn);
    channelListEl.appendChild(li);
  }
}

/**
 * Switch between the main (toggles) view and the manage-channels view.
 * @param {boolean} showManage
 */
function setChannelsView(showManage) {
  mainView.classList.toggle("hidden", showManage);
  manageView.classList.toggle("hidden", !showManage);
}

/** Wire the "Change allowed channels" / back navigation. */
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

  const [settings, channels] = await Promise.all([
    getYoutubeSettings(),
    getChannels(),
  ]);
  bindChannelsNav();
  bindToggles(settings); // calls applyChannelsEnabled — needs openChannelsBtn set
  renderChannels(channels);
  bindChannelForm();
}
