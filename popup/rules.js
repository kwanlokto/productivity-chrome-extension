// Direct declarativeNetRequest rule manipulation.
//
// The popup adds/removes individual blocking rules itself (rather than asking the
// background worker) so a rule change is guaranteed complete before we navigate a
// tab. Each rule redirects main-frame loads of a domain to blocked.html.

/**
 * The declarativeNetRequest urlFilter for a domain ("||domain^" matches the
 * domain and any subdomain).
 * @param {string} domain
 * @returns {string}
 */
export function ruleFilterFor(domain) {
  return "||" + domain + "^";
}

/**
 * Remove the blocking rule for a domain, if one exists.
 * @param {string} domain
 */
export async function removeBlockRule(domain) {
  const filter = ruleFilterFor(domain);
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const rule = existing.find((r) => r.condition.urlFilter === filter);
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
  const filter = ruleFilterFor(domain);
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  if (existing.some((r) => r.condition.urlFilter === filter)) return;

  const maxId = existing.reduce((m, r) => Math.max(m, r.id), 0);
  await chrome.declarativeNetRequest.updateDynamicRules({
    addRules: [
      {
        id: maxId + 1,
        priority: 1,
        action: {
          type: "redirect",
          redirect: {
            extensionPath: "/blocked.html?domain=" + encodeURIComponent(domain),
          },
        },
        condition: { urlFilter: filter, resourceTypes: ["main_frame"] },
      },
    ],
  });
}
