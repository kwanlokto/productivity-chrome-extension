// Focus Guard — background service worker
// Keeps declarativeNetRequest dynamic rules in sync with the user's blocked-domain list.
// Also handles snooze: temporarily removes a domain's rule for X minutes, then restores it.

const DEFAULT_BLOCKED = ["facebook.com", "instagram.com", "tiktok.com"];

const DEFAULT_YOUTUBE = {
  enabled: true,
  hideShorts: true,
  hideHomeFeed: true,
  hideWatchDistractions: true,
  allowedChannelsOnly: false
};

const DEFAULT_CHANNELS = [
  "khanacademy",
  "veritasium",
  "3blue1brown",
  "mitocw",
  "crashcourse",
  "TED",
  "TEDEd",
  "kurzgesagt"
];

function normalizeDomain(input) {
  if (!input) return "";
  let d = String(input).trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "");
  d = d.replace(/^www\./, "");
  d = d.split("/")[0].split("?")[0].split("#")[0];
  d = d.replace(/[^a-z0-9.\-]/g, "");
  return d;
}

// --- Snooze helpers ---
// Snoozed domains live in local storage as { domain -> { start, expiry } }.
// (Older entries may be a bare expiry timestamp — tolerate both.)
function expiryOf(entry) {
  return typeof entry === "number" ? entry : entry.expiry;
}

async function getSnoozed() {
  const { snoozed = {} } = await chrome.storage.local.get("snoozed");
  // Purge any already-expired entries.
  const now = Date.now();
  const active = Object.fromEntries(
    Object.entries(snoozed).filter(([, v]) => expiryOf(v) > now)
  );
  return active;
}

async function setSnoozed(snoozed) {
  await chrome.storage.local.set({ snoozed });
}

// --- Rule building ---
function buildRules(domains, snoozed) {
  return domains
    .filter((d) => !snoozed[d]) // skip currently snoozed domains
    .map((domain, i) => ({
      id: i + 1,
      priority: 1,
      action: {
        type: "redirect",
        redirect: {
          extensionPath: "/blocked.html?domain=" + encodeURIComponent(domain)
        }
      },
      condition: {
        urlFilter: "||" + domain + "^",
        resourceTypes: ["main_frame"]
      }
    }));
}

async function doSyncRules() {
  const { blockedDomains = DEFAULT_BLOCKED } = await chrome.storage.sync.get("blockedDomains");
  const snoozed = await getSnoozed();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  const addRules = buildRules(blockedDomains, snoozed);
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

let syncChain = Promise.resolve();
function syncRules() {
  syncChain = syncChain.then(doSyncRules, doSyncRules);
  return syncChain;
}

// Restore blocking when snooze expires.
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith("snooze:")) return;
  const domain = alarm.name.slice("snooze:".length);
  const snoozed = await getSnoozed();
  delete snoozed[domain];
  await setSnoozed(snoozed);
  await syncRules();
});


// --- Install / startup ---
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get(["blockedDomains", "youtube", "allowedChannels"]);
  const seed = {};
  if (!stored.blockedDomains) seed.blockedDomains = DEFAULT_BLOCKED;
  if (!stored.youtube) seed.youtube = DEFAULT_YOUTUBE;
  if (!stored.allowedChannels) seed.allowedChannels = DEFAULT_CHANNELS;
  if (Object.keys(seed).length) await chrome.storage.sync.set(seed);
  await syncRules();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.blockedDomains) syncRules();
  // NOTE: we deliberately do NOT re-sync on snooze changes. The popup owns the
  // rule add/remove for snooze/unsnooze directly; re-syncing here races with it
  // and can re-add a rule the popup just removed (re-blocking a snoozed site).
});

chrome.runtime.onStartup.addListener(syncRules);
