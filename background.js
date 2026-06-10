// Focus Guard — background service worker
// Keeps declarativeNetRequest dynamic rules in sync with the user's blocked-domain list.
// Also handles snooze: temporarily removes a domain's rule for X minutes, then restores it.

const DEFAULT_BLOCKED = ["facebook.com", "instagram.com", "tiktok.com"];

const DEFAULT_YOUTUBE = {
  enabled: false,
  showShorts: false,
  showHomeFeed: false,
  showRecommendations: false,
  showComments: false,
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

/**
 * Reduce user input to a bare registrable domain (mirror of the popup helper).
 * @param {string} input
 * @returns {string}
 */
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

/**
 * Read the expiry timestamp out of a snooze entry (object or legacy number).
 * @param {number | { expiry: number }} entry
 * @returns {number}
 */
function expiryOf(entry) {
  return typeof entry === "number" ? entry : entry.expiry;
}

/**
 * Active snooze map with expired entries purged.
 * @returns {Promise<Record<string, unknown>>}
 */
async function getSnoozed() {
  const { snoozed = {} } = await chrome.storage.local.get("snoozed");
  // Purge any already-expired entries.
  const now = Date.now();
  const active = Object.fromEntries(
    Object.entries(snoozed).filter(([, v]) => expiryOf(v) > now)
  );
  return active;
}

/**
 * Persist the snooze map.
 * @param {Record<string, unknown>} snoozed
 */
async function setSnoozed(snoozed) {
  await chrome.storage.local.set({ snoozed });
}

// --- Rule building ---
// Rules use regexFilter (not urlFilter) so we can capture the WHOLE original URL
// (\0) and pass it to the blocked page. That lets "unblock" return you to the
// exact page rather than just the domain root. Keep these two helpers in sync with
// the copies in popup/rules.js.

/** Escape regex metacharacters in a domain. */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Regex matching http(s) URLs for a domain and its subdomains, capturing the
 * full URL. Anchored so "facebook.com.evil.com" does NOT match.
 * @param {string} domain
 */
function blockRegexFor(domain) {
  return "^https?://([^/]+\\.)?" + escapeRegex(domain) + "([:/?#].*)?$";
}

/**
 * Redirect target: blocked.html with the domain and the full original URL.
 * \0 is replaced by the whole matched URL. `url` is last so the blocked page can
 * read everything after "url=" as the original URL.
 * @param {string} domain
 */
function blockSubstitutionFor(domain) {
  return chrome.runtime.getURL("blocked.html") + "?domain=" + domain + "&url=\\0";
}

/**
 * Build one redirect-to-blocked-page rule per blocked, non-snoozed domain.
 * @param {string[]} domains
 * @param {Record<string, unknown>} snoozed
 * @returns {chrome.declarativeNetRequest.Rule[]}
 */
function buildRules(domains, snoozed) {
  return domains
    .filter((d) => !snoozed[d]) // skip currently snoozed domains
    .map((domain, i) => ({
      id: i + 1,
      priority: 1,
      action: {
        type: "redirect",
        redirect: { regexSubstitution: blockSubstitutionFor(domain) }
      },
      condition: {
        regexFilter: blockRegexFor(domain),
        resourceTypes: ["main_frame"]
      }
    }));
}

/** Replace all dynamic rules with a fresh set built from current state. */
async function doSyncRules() {
  const { blockedDomains = DEFAULT_BLOCKED } = await chrome.storage.sync.get("blockedDomains");
  const snoozed = await getSnoozed();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  const addRules = buildRules(blockedDomains, snoozed);
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

// Serialize sync calls so concurrent triggers can't race into a duplicate-id error.
let syncChain = Promise.resolve();

/** Queue a rule re-sync behind any in-flight one. */
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
