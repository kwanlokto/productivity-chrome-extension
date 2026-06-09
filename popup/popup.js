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

// --- Domain list ---
function renderDomains(domains, snoozed = {}) {
  listEl.innerHTML = "";
  emptyEl.classList.toggle("hidden", domains.length > 0);

  for (const domain of domains) {
    const li = document.createElement("li");
    if (snoozed[domain]) li.classList.add("is-snoozed");

    const span = document.createElement("span");
    span.className = "domain-text";
    span.textContent = domain;

    const removeBtn = document.createElement("button");
    removeBtn.className = "btn-remove";
    removeBtn.title = "Remove";
    removeBtn.textContent = "✕";
    removeBtn.addEventListener("click", () => removeDomain(domain));

    li.append(span, removeBtn);
    listEl.appendChild(li);
  }
}

async function removeDomain(domain) {
  const domains = await getDomains();
  await setDomains(domains.filter((d) => d !== domain));
  await removeBlockRule(domain); // drop the rule now, before any navigation

  // If the current tab is stuck on OUR blocked page for this domain, send it through.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && tab.id) {
    try {
      const url = new URL(tab.url);
      const onBlockedPage =
        url.pathname.endsWith("blocked.html") && url.searchParams.get("domain") === domain;
      if (onBlockedPage) chrome.tabs.update(tab.id, { url: "https://" + domain });
    } catch {}
  }

  // Always refresh the popup UI — it stays open even when the tab navigates.
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
// All snooze operations run directly in the popup (no background messaging) so we
// know the rule is definitely updated before we navigate the tab.
// Each snooze is stored as { start, expiry } so the countdown ring knows the full
// window (and tolerates older number-only entries).

function expiryOf(entry) {
  return typeof entry === "number" ? entry : entry.expiry;
}

async function getSnoozed() {
  const { snoozed = {} } = await chrome.storage.local.get("snoozed");
  const now = Date.now();
  return Object.fromEntries(Object.entries(snoozed).filter(([, v]) => expiryOf(v) > now));
}

async function snooze(domain, minutes) {
  // 1. Persist the snooze so the background alarm handler and popup both read it.
  const start = Date.now();
  const expiresAt = start + minutes * 60 * 1000;
  const { snoozed = {} } = await chrome.storage.local.get("snoozed");
  snoozed[domain] = { start, expiry: expiresAt };
  await chrome.storage.local.set({ snoozed });

  // 2. Remove the blocking rule directly — guaranteed synchronous from our side.
  await removeBlockRule(domain);

  // 3. Navigate the blocked tab to the now-unblocked site (rule is already gone).
  //    Do this BEFORE the alarm so an alarm hiccup can never block the redirect.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.update(tab.id, { url: "https://" + domain });

  // 4. Schedule the automatic re-block when the snooze expires.
  try {
    await chrome.alarms.create("snooze:" + domain, { delayInMinutes: minutes });
  } catch (e) {
    console.warn("[Focus Guard] couldn't set re-block alarm:", e);
  }

  // 5. Update the popup UI for the case where it stays open.
  await updateStatusBar();
}

// Remove the blocking rule for a domain directly (no-op if none exists).
async function removeBlockRule(domain) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const rule = existing.find(r => r.condition.urlFilter === "||" + domain + "^");
  if (rule) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [rule.id] });
  }
}

// Add a blocking rule for a domain directly (no-op if one already exists).
async function addBlockRule(domain) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  if (existing.some(r => r.condition.urlFilter === "||" + domain + "^")) return;
  const maxId = existing.reduce((m, r) => Math.max(m, r.id), 0);
  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [{
      id: maxId + 1,
      priority: 1,
      action: {
        type: "redirect",
        redirect: { extensionPath: "/blocked.html?domain=" + encodeURIComponent(domain) }
      },
      condition: { urlFilter: "||" + domain + "^", resourceTypes: ["main_frame"] }
    }]
  });
}

async function unsnooze(domain) {
  // 1. Remove from snooze storage.
  const { snoozed = {} } = await chrome.storage.local.get("snoozed");
  delete snoozed[domain];
  await chrome.storage.local.set({ snoozed });

  // 2. Clear the alarm.
  await chrome.alarms.clear("snooze:" + domain);

  // 3. Re-add the blocking rule directly.
  await addBlockRule(domain);

  // 4. Reload — the restored rule will immediately redirect to blocked.html.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.reload(tab.id);

  await updateStatusBar();
}

// Block the site you're currently on, then bounce the tab to the blocked page.
async function blockCurrentSite(domain) {
  const domains = await getDomains();
  if (!domains.includes(domain)) {
    await setDomains([...domains, domain]);
  }
  await addBlockRule(domain); // immediate, so the reload is caught
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.reload(tab.id);

  // Refresh the popup UI — it stays open even as the tab reloads.
  const [fresh, snoozed] = await Promise.all([getDomains(), getSnoozed()]);
  renderDomains(fresh, snoozed);
  updateStatusBar();
}

// --- Current-tab status + circular action control ---
const SNOOZE_MINUTES = 5;
const RING_CIRCUMFERENCE = 2 * Math.PI * 54; // matches the SVG circle r=54

const actionWrap  = document.getElementById("action-circle-wrap");
const actionCircle = document.getElementById("action-circle");
const ringProgress = document.querySelector(".ring-progress");
const circleMain  = document.getElementById("circle-main");
const circleSub   = document.getElementById("circle-sub");

let countdownTimer = null;

function formatClock(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Configure the big circle for a given state.
function showCircle(stateClass, main, sub, onClick) {
  actionWrap.classList.remove("hidden");
  actionCircle.classList.remove("is-block", "is-unblock", "is-countdown");
  actionCircle.classList.add(stateClass);
  circleMain.textContent = main;
  circleSub.textContent = sub;
  actionCircle.onclick = onClick;
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
  ringProgress.classList.add("hidden");

  const [tabDomain, domains, snoozed] = await Promise.all([
    getCurrentTabDomain(),
    getDomains(),
    getSnoozed()
  ]);

  const blockable = tabDomain && tabDomain.includes(".");
  const matchedDomain = blockable ? domainMatchesBlocked(tabDomain, domains) : null;

  if (!blockable) {
    // Not a real page (chrome://, new tab, etc.) — nothing to act on.
    actionWrap.classList.add("hidden");
    return;
  }

  if (!matchedDomain) {
    // Not blocked — circle blocks the current site.
    showCircle("is-block", "Block", "this site", () => blockCurrentSite(tabDomain));
    return;
  }

  const snoozeEntry = snoozed[matchedDomain];

  if (snoozeEntry) {
    // Temporarily unblocked — circle is a live countdown; click re-blocks.
    showCircle("is-countdown", "", "Re-block", () => unsnooze(matchedDomain));
    ringProgress.classList.remove("hidden");

    const expiry = expiryOf(snoozeEntry);
    const start = typeof snoozeEntry === "object" && snoozeEntry.start
      ? snoozeEntry.start
      : expiry - SNOOZE_MINUTES * 60 * 1000;
    const total = Math.max(1, expiry - start);

    const tick = () => {
      const remaining = expiry - Date.now();
      if (remaining <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        updateStatusBar();
        return;
      }
      circleMain.textContent = formatClock(remaining);
      // Yellow ring = fraction of time remaining, so it shrinks as it counts down.
      const fraction = Math.max(0, Math.min(1, remaining / total));
      ringProgress.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - fraction));
    };
    tick();
    countdownTimer = setInterval(tick, 250);
  } else {
    // Blocked — circle unblocks for SNOOZE_MINUTES.
    showCircle("is-unblock", "Unblock", `${SNOOZE_MINUTES} min`, () => snooze(matchedDomain, SNOOZE_MINUTES));
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
