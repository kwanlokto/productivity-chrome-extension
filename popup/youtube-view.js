// "YouTube" tab: focus toggles and the allowed-channels list.

import { normalizeChannel, reanimate } from "./util.js";
import {
  getYoutubeSettings,
  setYoutubeSettings,
  getChannels,
  setChannels,
} from "./storage.js";

let channelListEl, channelEmptyEl, channelFormEl, channelInputEl, channelsEditor;
let mainView, manageView, openChannelsBtn, backBtn;

/* ---------------------------- Enable/disable UI --------------------------- */

/**
 * The "Change allowed channels" button only needs YouTube tweaks to be on — the
 * allow-list "Enable" toggle now lives inside the channel editor itself.
 */
function applyOpenButtonEnabled() {
  const masterOn = document.querySelector('[data-yt="enabled"]').checked;
  openChannelsBtn.disabled = !masterOn;
}

/**
 * The channel editor (add form + list) is only usable when YouTube tweaks are on
 * AND the allow-list is enabled — otherwise dim it and make it non-interactive
 * (so it reads as "all channels allowed").
 */
function applyChannelEditorEnabled() {
  const masterOn = document.querySelector('[data-yt="enabled"]').checked;
  const allowlistOn = document.querySelector(
    '[data-yt="allowedChannelsOnly"]',
  ).checked;
  const on = masterOn && allowlistOn;
  channelsEditor.classList.toggle("is-disabled", !on);
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
  applyOpenButtonEnabled();
  applyChannelEditorEnabled();
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
      if (key === "allowedChannelsOnly") applyChannelEditorEnabled();
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
 * Switch between the main (toggles) view and the manage-channels view, sliding
 * the incoming view in (from the right going forward, from the left going back).
 * @param {boolean} showManage
 */
function setChannelsView(showManage) {
  if (showManage) {
    mainView.classList.add("hidden");
    manageView.classList.remove("hidden");
    reanimate(manageView, "slide-in-right");
  } else {
    manageView.classList.add("hidden");
    mainView.classList.remove("hidden");
    reanimate(mainView, "slide-in-left");
  }
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
  channelsEditor = document.getElementById("channels-editor");

  mainView = document.getElementById("youtube-main");
  manageView = document.getElementById("youtube-manage");
  openChannelsBtn = document.getElementById("open-channels");
  backBtn = document.getElementById("back-to-youtube");

  const [settings, channels] = await Promise.all([
    getYoutubeSettings(),
    getChannels(),
  ]);
  bindChannelsNav();
  bindToggles(settings); // applies enable/disable states — needs DOM refs set
  renderChannels(channels);
  bindChannelForm();
}
