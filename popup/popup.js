// Popup: manage the blocked-domain list and YouTube focus settings.

const DEFAULT_BLOCKED = ["facebook.com", "instagram.com", "tiktok.com"];
const DEFAULT_YOUTUBE = {
  enabled: true,
  hideShorts: true,
  hideHomeFeed: true,
  hideWatchDistractions: true,
  allowedChannelsOnly: false
};

const listEl    = document.getElementById("domain-list");
const emptyEl   = document.getElementById("empty");
const formEl    = document.getElementById("add-form");
const inputEl   = document.getElementById("domain-input");

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

// --- Domain list with inline editing ---
function renderDomains(domains, snoozed = {}) {
  listEl.innerHTML = "";
  emptyEl.classList.toggle("hidden", domains.length > 0);

  for (const domain of domains) {
    const isSnoozed = Boolean(snoozed[domain]);
    const li = document.createElement("li");
    if (isSnoozed) li.classList.add("is-snoozed");

    // Domain display / edit field
    const span = document.createElement("span");
    span.className = "domain-text";
    span.textContent = domain;

    // Edit button
    const editBtn = document.createElement("button");
    editBtn.className = "btn-edit";
    editBtn.title = "Edit";
    editBtn.textContent = "✎";
    editBtn.addEventListener("click", () => startEdit(li, domain, domains));

    // Remove button
    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-remove";
    removeBtn.title = "Remove";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => removeDomain(domain));

    li.append(span, editBtn, removeBtn);
    listEl.appendChild(li);
  }
}

function startEdit(li, oldDomain, domains) {
  // Swap the text span for an inline input.
  li.classList.add("is-editing");
  li.innerHTML = "";

  const input = document.createElement("input");
  input.className = "domain-edit-input";
  input.value = oldDomain;
  input.select();

  const saveBtn = document.createElement("button");
  saveBtn.className = "btn-save";
  saveBtn.textContent = "Save";

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "btn-cancel";
  cancelBtn.textContent = "✕";

  const save = async () => {
    const newDomain = normalizeDomain(input.value);
    if (!newDomain || !newDomain.includes(".") || newDomain === oldDomain) {
      cancel();
      return;
    }
    const updated = domains.map((d) => (d === oldDomain ? newDomain : d));
    await setDomains(updated);
    const [fresh, snoozed] = await Promise.all([getDomains(), getSnoozed()]);
    renderDomains(fresh, snoozed);
    updateStatusBar();
  };

  const cancel = async () => {
    const [fresh, snoozed] = await Promise.all([getDomains(), getSnoozed()]);
    renderDomains(fresh, snoozed);
  };

  saveBtn.addEventListener("click", save);
  cancelBtn.addEventListener("click", cancel);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
    if (e.key === "Escape") cancel();
  });

  li.append(input, saveBtn, cancelBtn);
  input.focus();
}

async function removeDomain(domain) {
  const domains = await getDomains();
  await setDomains(domains.filter((d) => d !== domain));
  const [fresh, snoozed] = await Promise.all([getDomains(), getSnoozed()]);
  renderDomains(fresh, snoozed);
  updateStatusBar();
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
  }
  inputEl.value = "";
  const [fresh, snoozed] = await Promise.all([getDomains(), getSnoozed()]);
  renderDomains(fresh, snoozed);
  updateStatusBar();
});

// --- Snooze ---
async function getSnoozed() {
  return chrome.runtime.sendMessage({ type: "getSnoozed" });
}

async function snooze(domain, minutes) {
  await chrome.runtime.sendMessage({ type: "snooze", domain, minutes });
  // Navigate the blocked tab to the now-unblocked site.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.update(tab.id, { url: "https://" + domain });
  // Popup closes when the tab navigates — no need to re-render.
}

async function unsnooze(domain) {
  await chrome.runtime.sendMessage({ type: "unsnooze", domain });
  // Reload the tab — the restored blocking rule will redirect it to blocked.html.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.reload(tab.id);
}

// --- Current-tab status bar ---
const statusDot       = document.getElementById("status-dot");
const statusLabel     = document.getElementById("status-label");
const statusCountdown = document.getElementById("status-countdown");
const snoozeBar       = document.getElementById("snooze-bar");
const unsnoozeBar     = document.getElementById("unsnooze-bar");

let countdownTimer = null;

function formatMs(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

async function getCurrentTabDomain() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return "";
  // When a site is blocked we land on blocked.html?domain=... — use that param
  // instead of the extension URL itself.
  try {
    const url = new URL(tab.url);
    if (url.pathname.endsWith("blocked.html")) {
      const d = url.searchParams.get("domain");
      if (d) return d;
    }
  } catch {}
  return normalizeDomain(tab.url);
}

function domainMatchesBlocked(tabDomain, blockedDomains) {
  return blockedDomains.find((d) => tabDomain === d || tabDomain.endsWith("." + d)) || null;
}

async function updateStatusBar() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  statusCountdown.classList.add("hidden");
  statusCountdown.textContent = "";

  const [tabDomain, domains, snoozed] = await Promise.all([
    getCurrentTabDomain(),
    getDomains(),
    getSnoozed()
  ]);

  const matchedDomain = tabDomain ? domainMatchesBlocked(tabDomain, domains) : null;

  if (!tabDomain || !matchedDomain) {
    // Not a blocked site
    statusDot.className = "dot dot-green";
    statusLabel.textContent = tabDomain ? `${tabDomain} is not blocked` : "No active tab";
    snoozeBar.classList.add("hidden");
    unsnoozeBar.classList.add("hidden");
    return;
  }

  const snoozeExpiry = snoozed[matchedDomain];

  if (snoozeExpiry) {
    // Currently snoozed (unblocked temporarily)
    statusDot.className = "dot dot-yellow";
    statusLabel.textContent = `${matchedDomain} — temporarily unblocked`;
    snoozeBar.classList.add("hidden");
    unsnoozeBar.classList.remove("hidden");

    document.getElementById("unsnooze-btn").onclick = () => unsnooze(matchedDomain);

    // Live countdown
    const tick = () => {
      const remaining = snoozeExpiry - Date.now();
      if (remaining <= 0) {
        statusCountdown.classList.add("hidden");
        clearInterval(countdownTimer);
        updateStatusBar();
        return;
      }
      statusCountdown.textContent = formatMs(remaining) + " left";
      statusCountdown.classList.remove("hidden");
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  } else {
    // Actively blocked
    statusDot.className = "dot dot-red";
    statusLabel.textContent = `${matchedDomain} — blocked`;
    snoozeBar.classList.remove("hidden");
    unsnoozeBar.classList.add("hidden");

    document.querySelectorAll(".snooze-btn").forEach((btn) => {
      btn.onclick = () => snooze(matchedDomain, Number(btn.dataset.min));
    });
  }
}

// --- YouTube settings ---
async function getYoutube() {
  const { youtube = DEFAULT_YOUTUBE } = await chrome.storage.sync.get("youtube");
  return { ...DEFAULT_YOUTUBE, ...youtube };
}

function applyChannelsEnabled() {
  const masterOn   = document.querySelector('[data-yt="enabled"]').checked;
  const allowlistOn = document.querySelector('[data-yt="allowedChannelsOnly"]').checked;
  const on = masterOn && allowlistOn;
  const channelsSection = document.getElementById("channels-section");
  channelsSection?.classList.toggle("is-disabled", !on);
  channelInputEl.disabled = !on;
  channelFormEl.querySelector("button").disabled = !on;
}

function applyYoutubeEnabled(enabled) {
  document.querySelectorAll('[data-yt]').forEach((el) => {
    if (el.dataset.yt === "enabled") return;
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
const channelListEl  = document.getElementById("channel-list");
const channelEmptyEl = document.getElementById("channel-empty");
const channelFormEl  = document.getElementById("channel-form");
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
    btn.addEventListener("click", async () => {
      await setChannels((await getChannels()).filter((c) => c !== channel));
      renderChannels(await getChannels());
    });
    li.append(span, btn);
    channelListEl.appendChild(li);
  }
}

channelFormEl.addEventListener("submit", async (e) => {
  e.preventDefault();
  const channel = normalizeChannel(channelInputEl.value);
  if (!channel) { channelInputEl.value = ""; return; }
  const channels = await getChannels();
  if (!channels.includes(channel)) {
    await setChannels([...channels, channel]);
    renderChannels(await getChannels());
  }
  channelInputEl.value = "";
});

// --- Tab switching ---
function bindTabs() {
  const tabs   = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".panel");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      tabs.forEach((t)   => t.classList.toggle("is-active", t === tab));
      panels.forEach((p) => p.classList.toggle("is-active", p.dataset.panel === target));
    });
  });
}

// --- Init ---
(async function init() {
  bindTabs();
  const [domains, snoozed, ytSettings, channels] = await Promise.all([
    getDomains(),
    getSnoozed(),
    getYoutube(),
    getChannels()
  ]);
  renderDomains(domains, snoozed);
  bindYoutubeToggles(ytSettings);
  renderChannels(channels);
  updateStatusBar();
})();
