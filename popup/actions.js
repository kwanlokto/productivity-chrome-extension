// High-level user actions: each combines storage, blocking rules, and tab
// navigation into one operation. These contain no DOM code — the views call them
// and then re-render.

import {
  getDomains,
  setDomains,
  addSnooze,
  removeSnooze,
  extendSnooze as extendSnoozeStorage,
} from "./storage.js";
import { addBlockRule, removeBlockRule } from "./rules.js";
import {
  getActiveTab,
  getBlockedOriginalUrl,
  navigateActiveTab,
  reloadActiveTab,
} from "./tabs.js";

/**
 * Add a domain to the blocked list. The background worker picks up the storage
 * change and creates the actual blocking rule.
 * @param {string} domain
 */
export async function addDomain(domain) {
  const domains = await getDomains();
  if (!domains.includes(domain)) {
    await setDomains([...domains, domain]);
  }
}

/**
 * Remove a domain from the blocked list and its rule. If the active tab is stuck
 * on our blocked page for this domain, send it through to the real site.
 * @param {string} domain
 */
export async function removeDomain(domain) {
  await setDomains((await getDomains()).filter((d) => d !== domain));
  await removeBlockRule(domain);

  const tab = await getActiveTab();
  if (tab?.url && tab.id) {
    try {
      const url = new URL(tab.url);
      const onBlockedPage =
        url.pathname.endsWith("blocked.html") &&
        url.searchParams.get("domain") === domain;
      if (onBlockedPage) {
        const original = await getBlockedOriginalUrl();
        await navigateActiveTab(original || "https://" + domain);
      }
    } catch {
      /* unparseable tab URL — nothing to redirect */
    }
  }
}

/**
 * Block the site the user is currently on, then reload so the new rule catches
 * it and redirects to the blocked page.
 * @param {string} domain
 */
export async function blockCurrentSite(domain) {
  await addDomain(domain);
  await addBlockRule(domain); // immediate, so the reload below is caught
  await reloadActiveTab();
}

/**
 * Temporarily lift a domain's block for `minutes`, navigate the tab to the real
 * site, and schedule the automatic re-block.
 * @param {string} domain
 * @param {number} minutes
 */
export async function snooze(domain, minutes) {
  const start = Date.now();
  const durationMs = minutes * 60 * 1000;
  const expiry = start + durationMs;
  await addSnooze(domain, start, expiry, durationMs); // cap "+1 min" at this duration

  // Drop the rule, THEN navigate — so the load isn't redirected back.
  await removeBlockRule(domain);
  const original = await getBlockedOriginalUrl();
  await navigateActiveTab(original || "https://" + domain);

  // Schedule the re-block. Guard it so an alarm hiccup can't undo the redirect.
  try {
    await chrome.alarms.create("snooze:" + domain, { delayInMinutes: minutes });
  } catch (e) {
    console.warn("[Focus Guard] couldn't set re-block alarm:", e);
  }
}

/**
 * Add time to an in-progress unlock and push back its automatic re-block.
 * @param {string} domain
 * @param {number} minutes
 */
export async function extendSnooze(domain, minutes) {
  const newExpiry = await extendSnoozeStorage(domain, minutes * 60 * 1000);
  if (newExpiry == null) return; // not snoozed (e.g. it just expired)
  try {
    await chrome.alarms.create("snooze:" + domain, { when: newExpiry });
  } catch (e) {
    console.warn("[Focus Guard] couldn't reschedule re-block alarm:", e);
  }
}

/**
 * End a snooze early: restore the block, cancel the alarm, and reload so the tab
 * is redirected back to the blocked page.
 * @param {string} domain
 */
export async function unsnooze(domain) {
  await removeSnooze(domain);
  await chrome.alarms.clear("snooze:" + domain);
  await addBlockRule(domain);
  await reloadActiveTab();
}
