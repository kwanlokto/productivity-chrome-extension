// chrome.tabs helpers for reading and steering the active tab.

import { normalizeDomain } from "./util.js";

/**
 * @returns {Promise<chrome.tabs.Tab | undefined>} the active tab in the current window
 */
export async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/**
 * The domain the active tab represents. When the tab is sitting on our own
 * blocked.html, the original domain is read from its `?domain=` param rather than
 * the extension URL.
 * @returns {Promise<string>} a bare domain, or "" if none/unavailable
 */
export async function getCurrentTabDomain() {
  const tab = await getActiveTab();
  if (!tab?.url) return "";
  try {
    const url = new URL(tab.url);
    if (url.pathname.endsWith("blocked.html")) {
      const d = url.searchParams.get("domain");
      if (d) return d;
    }
  } catch {
    /* not a parseable URL — fall through */
  }
  return normalizeDomain(tab.url);
}

/**
 * Find which blocked-list entry (if any) the tab's domain belongs to, matching
 * the domain itself and any subdomain.
 * @param {string} tabDomain
 * @param {string[]} blockedDomains
 * @returns {string | null} the matched blocked domain, or null
 */
export function domainMatchesBlocked(tabDomain, blockedDomains) {
  return (
    blockedDomains.find(
      (d) => tabDomain === d || tabDomain.endsWith("." + d),
    ) || null
  );
}

/**
 * If the active tab is our blocked page, return the full original URL captured in
 * its `url=` parameter (everything after "url=", since the original URL may itself
 * contain "?"/"&"). Otherwise null.
 * @returns {Promise<string | null>}
 */
export async function getBlockedOriginalUrl() {
  const tab = await getActiveTab();
  if (!tab?.url || !tab.url.includes("blocked.html")) return null;
  const i = tab.url.indexOf("url=");
  if (i < 0) return null;
  const raw = tab.url.slice(i + "url=".length);
  return raw || null;
}

/**
 * Navigate the active tab to a URL.
 * @param {string} url
 */
export async function navigateActiveTab(url) {
  const tab = await getActiveTab();
  if (tab?.id) await chrome.tabs.update(tab.id, { url });
}

/** Reload the active tab. */
export async function reloadActiveTab() {
  const tab = await getActiveTab();
  if (tab?.id) await chrome.tabs.reload(tab.id);
}
