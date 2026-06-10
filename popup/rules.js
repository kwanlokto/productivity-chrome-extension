// Direct declarativeNetRequest rule manipulation.
//
// The popup adds/removes individual blocking rules itself (rather than asking the
// background worker) so a rule change is guaranteed complete before we navigate a
// tab. Each rule redirects main-frame loads of a domain to blocked.html, capturing
// the FULL original URL via a regex rule (\0) so "unblock" can return there.
//
// These helpers must stay in sync with the copies in background.js.

/** Escape regex metacharacters in a domain. */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Regex matching http(s) URLs for a domain and its subdomains, capturing the
 * full URL. This is the rule's identity — we match rules by it.
 * @param {string} domain
 * @returns {string}
 */
export function blockRegexFor(domain) {
  return "^https?://([^/]+\\.)?" + escapeRegex(domain) + "([:/?#].*)?$";
}

/**
 * Redirect target: blocked.html with the domain and the full original URL (\0).
 * @param {string} domain
 * @returns {string}
 */
function blockSubstitutionFor(domain) {
  return chrome.runtime.getURL("blocked.html") + "?domain=" + domain + "&url=\\0";
}

/**
 * Remove the blocking rule for a domain, if one exists.
 * @param {string} domain
 */
export async function removeBlockRule(domain) {
  const regex = blockRegexFor(domain);
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const rule = existing.find((r) => r.condition.regexFilter === regex);
  if (rule) {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [rule.id],
    });
  }
}

/**
 * Add a blocking rule for a domain. No-op if one already exists.
 * @param {string} domain
 */
export async function addBlockRule(domain) {
  const regex = blockRegexFor(domain);
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  if (existing.some((r) => r.condition.regexFilter === regex)) return;

  const maxId = existing.reduce((m, r) => Math.max(m, r.id), 0);
  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [
      {
        id: maxId + 1,
        priority: 1,
        action: {
          type: "redirect",
          redirect: { regexSubstitution: blockSubstitutionFor(domain) },
        },
        condition: { regexFilter: regex, resourceTypes: ["main_frame"] },
      },
    ],
  });
}
