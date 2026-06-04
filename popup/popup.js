// Popup: manage the blocked-domain list and YouTube focus settings.

const DEFAULT_BLOCKED = ["facebook.com", "instagram.com", "tiktok.com"];
const DEFAULT_YOUTUBE = {
  enabled: true,
  hideShorts: true,
  hideHomeFeed: true,
  hideRelated: true,
  hideComments: false,
  grayscale: false,
  allowedChannelsOnly: false
};

const listEl = document.getElementById("domain-list");
const emptyEl = document.getElementById("empty");
const formEl = document.getElementById("add-form");
const inputEl = document.getElementById("domain-input");

function normalizeDomain(input) {
  if (!input) return "";
  let d = String(input).trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "");
  d = d.replace(/^www\./, "");
  d = d.split("/")[0].split("?")[0].split("#")[0];
  d = d.replace(/[^a-z0-9.\-]/g, "");
  return d;
}

async function getDomains() {
  const { blockedDomains = DEFAULT_BLOCKED } = await chrome.storage.sync.get("blockedDomains");
  return blockedDomains;
}

async function setDomains(domains) {
  await chrome.storage.sync.set({ blockedDomains: domains });
}

function renderDomains(domains) {
  listEl.innerHTML = "";
  emptyEl.classList.toggle("hidden", domains.length > 0);
  for (const domain of domains) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = domain;
    const btn = document.createElement("button");
    btn.textContent = "✕";
    btn.title = "Remove";
    btn.addEventListener("click", () => removeDomain(domain));
    li.append(span, btn);
    listEl.appendChild(li);
  }
}

async function removeDomain(domain) {
  const domains = await getDomains();
  await setDomains(domains.filter((d) => d !== domain));
  renderDomains(await getDomains());
}

formEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const domain = normalizeDomain(inputEl.value);
  if (!domain || !domain.includes(".")) {
    inputEl.value = "";
    inputEl.placeholder = "enter a valid domain";
    return;
  }
  const domains = await getDomains();
  if (!domains.includes(domain)) {
    await setDomains([...domains, domain]);
    renderDomains(await getDomains());
  }
  inputEl.value = "";
});

// --- YouTube settings ---
async function getYoutube() {
  const { youtube = DEFAULT_YOUTUBE } = await chrome.storage.sync.get("youtube");
  return { ...DEFAULT_YOUTUBE, ...youtube };
}

// The Allowed channels list is only usable when YouTube tweaks are on AND
// "Allowed channels only" is on — otherwise disable + gray it out.
function applyChannelsEnabled() {
  const masterOn = document.querySelector('[data-yt="enabled"]').checked;
  const allowlistOn = document.querySelector('[data-yt="allowedChannelsOnly"]').checked;
  const on = masterOn && allowlistOn;
  const channelsSection = document.getElementById("channels-section");
  channelsSection?.classList.toggle("is-disabled", !on);
  channelInputEl.disabled = !on;
  channelFormEl.querySelector("button").disabled = !on;
}

// Disable + gray out every YouTube sub-option when the master toggle is off.
function applyYoutubeEnabled(enabled) {
  document.querySelectorAll('[data-yt]').forEach((el) => {
    if (el.dataset.yt === "enabled") return; // never disable the master itself
    el.disabled = !enabled;
    el.closest(".toggle")?.classList.toggle("is-disabled", !enabled);
  });
  applyChannelsEnabled();
}

function bindYoutubeToggles(settings) {
  document.querySelectorAll("[data-yt]").forEach((el) => {
    const key = el.dataset.yt;
    el.checked = Boolean(settings[key]);
    el.addEventListener("change", async () => {
      const current = await getYoutube();
      current[key] = el.checked;
      await chrome.storage.sync.set({ youtube: current });
      if (key === "enabled") applyYoutubeEnabled(el.checked);
      if (key === "allowedChannelsOnly") applyChannelsEnabled();
    });
  });
  applyYoutubeEnabled(Boolean(settings.enabled));
}

// --- Allowed channels ---
const channelListEl = document.getElementById("channel-list");
const channelEmptyEl = document.getElementById("channel-empty");
const channelFormEl = document.getElementById("channel-form");
const channelInputEl = document.getElementById("channel-input");

function normalizeChannel(input) {
  return String(input || "").trim().replace(/^@/, "").replace(/\s+/g, "").toLowerCase();
}

async function getChannels() {
  const { allowedChannels = [] } = await chrome.storage.sync.get("allowedChannels");
  return allowedChannels;
}

async function setChannels(channels) {
  await chrome.storage.sync.set({ allowedChannels: channels });
}

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
    btn.addEventListener("click", () => removeChannel(channel));
    li.append(span, btn);
    channelListEl.appendChild(li);
  }
}

async function removeChannel(channel) {
  const channels = await getChannels();
  await setChannels(channels.filter((c) => c !== channel));
  renderChannels(await getChannels());
}

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

// --- Tab switching ---
function bindTabs() {
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      tabs.forEach((t) => t.classList.toggle("is-active", t === tab));
      panels.forEach((p) => p.classList.toggle("is-active", p.dataset.panel === target));
    });
  });
}

(async function init() {
  bindTabs();
  renderDomains(await getDomains());
  bindYoutubeToggles(await getYoutube());
  renderChannels(await getChannels());
})();
