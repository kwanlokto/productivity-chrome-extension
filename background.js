// Focus Guard — background service worker
// Keeps declarativeNetRequest dynamic rules in sync with the user's blocked-domain list.

const DEFAULT_BLOCKED = ["facebook.com", "instagram.com", "tiktok.com"];

const DEFAULT_YOUTUBE = {
  enabled: true,
  hideShorts: true,
  hideHomeFeed: true,
  hideRelated: true,
  hideComments: false,
  grayscale: false
};

// Normalize user input into a bare registrable domain, e.g.
// "https://www.Facebook.com/feed" -> "facebook.com"
function normalizeDomain(input) {
  if (!input) return "";
  let d = String(input).trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "");
  d = d.replace(/^www\./, "");
  d = d.split("/")[0].split("?")[0].split("#")[0];
  d = d.replace(/[^a-z0-9.\-]/g, "");
  return d;
}

// Build one declarativeNetRequest rule per blocked domain.
function buildRules(domains) {
  return domains.map((domain, i) => ({
    id: i + 1,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {
        extensionPath: "/blocked.html?domain=" + encodeURIComponent(domain)
      }
    },
    condition: {
      // ||domain^ matches the domain and any subdomain.
      urlFilter: "||" + domain + "^",
      resourceTypes: ["main_frame"]
    }
  }));
}

// Replace all existing dynamic rules with a fresh set generated from storage.
async function doSyncRules() {
  const { blockedDomains = DEFAULT_BLOCKED } = await chrome.storage.sync.get("blockedDomains");
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  const addRules = buildRules(blockedDomains);
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

// Serialize sync calls. Multiple triggers (install + the storage write it causes,
// plus startup) can otherwise run concurrently, each read an empty rule set, and
// then both try to add id 1 -> "Rule with id 1 does not have a unique ID."
let syncChain = Promise.resolve();
function syncRules() {
  syncChain = syncChain.then(doSyncRules, doSyncRules);
  return syncChain;
}

// Seed defaults on first install, then sync.
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get(["blockedDomains", "youtube"]);
  const seed = {};
  if (!stored.blockedDomains) seed.blockedDomains = DEFAULT_BLOCKED;
  if (!stored.youtube) seed.youtube = DEFAULT_YOUTUBE;
  if (Object.keys(seed).length) await chrome.storage.sync.set(seed);
  await syncRules();
});

// Re-sync whenever the blocked list changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.blockedDomains) {
    syncRules();
  }
});

// Make sure rules exist after a browser restart / SW wake-up.
chrome.runtime.onStartup.addListener(syncRules);
