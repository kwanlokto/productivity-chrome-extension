// "YouTube" tab: focus toggles and the allowed-channels list.

import { normalizeChannel } from "./util.js";
import {
  getYoutubeSettings,
  setYoutubeSettings,
  getChannels,
  setChannels,
} from "./storage.js";

let channelListEl, channelEmptyEl, channelFormEl, channelInputEl;

/* ---------------------------- Enable/disable UI --------------------------- */

/**
 * The allowed-channels section is only usable when YouTube tweaks are on AND
 * "Allowed channels only" is on — otherwise dim and disable it.
 */
function applyChannelsEnabled() {
  const masterOn = document.querySelector('[data-yt="enabled"]').checked;
  const allowlistOn = document.querySelector(
    '[data-yt="allowedChannelsOnly"]',
  ).checked;
  const on = masterOn && allowlistOn;

  document.getElementById("channels-section")?.classList.toggle("is-disabled", !on);
  channelInputEl.disabled = !on;
  channelFormEl.querySelector("button").disabled = !on;
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

  const [settings, channels] = await Promise.all([
    getYoutubeSettings(),
    getChannels(),
  ]);
  bindToggles(settings);
  renderChannels(channels);
  bindChannelForm();
}
