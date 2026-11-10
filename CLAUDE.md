# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Focus Guard: a Manifest V3 Chrome extension that blocks distracting sites (redirecting them to an in-extension reminder page, with timed "Unlock" snoozes) and hides distracting YouTube UI. Plain JavaScript, HTML, and CSS. There is **no build step and no linter**. The only tooling is Playwright, used for tests; `package.json` exists only for that.

## Development workflow

- **Run locally:** at `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and select the repo root (the folder containing `manifest.json`).
- **After editing:** click the reload icon on the extension card. Changes to the content script also need the YouTube tab reloaded. Debug the background worker through "Inspect views: service worker" on the extension card. Debug the popup by right-clicking it and choosing Inspect.
- **Tests:** first-time setup is `npm install` then `npx playwright install chromium`. Run everything with `npm test`, one file with `npx playwright test tests/power-switch.spec.js`, and one test with `-g "<part of its name>"`. Tests only cover the popup page (see **Tests** below). Background-only and active-tab behavior is still checked by hand in Chrome. Logs use the `[Focus Guard]` prefix.
- **Release:** bump `version` in `manifest.json` (the Chrome Web Store rejects re-uploads of an existing version). Then push a `v*` tag, and `.github/workflows/build.yml` attaches `focus-guard-v<version>.zip` to a GitHub Release. Every push to `main` also uploads the unpacked build as an Actions artifact. For a local store zip, use the PowerShell `Compress-Archive` snippet in README.md.
- **Packaging:** the extension ships the whole repo root, minus an exclude list. Anything new at the root that isn't part of the extension (tooling, docs) must be added to both the `rsync --exclude` list in `build.yml` and the `$exclude` list in README.md's zip snippet.

## Architecture

There are five runtime contexts. Their module systems differ:

| Context | Files | Module type |
|---|---|---|
| Background service worker | `background.js` | ES module (`"type": "module"` in manifest) |
| Popup | `popup/*.js`, entry `popup/popup.js` | ES modules |
| YouTube content script | `content/youtube.js` + `content/youtube.css` | **Classic script.** It cannot `import`. |
| Blocked page | `blocked.html` + `blocked.js` | Classic script |
| Warning bar | `content/unlock-warning.js`, injected into an unlocked site's tabs by the background (`chrome.scripting`) | **Classic script.** It cannot `import`. |

`shared/core.js` is the single source of truth for defaults, `normalizeDomain`, `WARNING_MS` (an unlock's last minute), and the rule regex and redirect builders (`blockRegexFor`, `blockSubstitutionFor`). The background imports it directly. The popup re-exports it through `popup/config.js` and `popup/util.js`. The content scripts can't import it, so they read storage directly and duplicate a little logic. In `content/youtube.js`, `channelKey` mirrors `normalizeChannel`, and a missing `show*` flag counts as false (off). `content/unlock-warning.js` copies `WARNING_MS`, the `expiryOf` / `capOf` snooze-entry readers, and the popup's colors. Keep these copies in sync by hand.

The background also imports `extendSnooze` from `popup/storage.js`, so "+1 min" on the warning bar follows exactly the popup's rule (never past the unlock's original length).

### Storage

All popup storage access goes through `popup/storage.js`.

- `chrome.storage.sync`: `blockedDomains` (bare domains), `youtube` (see `DEFAULT_YOUTUBE`), `allowedChannels`, `unlockMinutes`, and `pauseMinutes` (how long the header switch turns Focus Guard off for).
- `chrome.storage.local`: `snoozed` and `pausedUntil` (a ms timestamp for the whole-extension pause).
  - `snoozed` has the shape `{ [domain]: { start, expiry, cap } }`. Older entries may be a bare expiry number. Always read entries through `expiryOf` / `startOf` / `capOf`.
  - An unlock only exists for a domain on the blocked list. Removing a domain ends its unlock: `removeDomain` in `popup/actions.js` does it straight away, and the background's `dropOrphanedSnoozes` covers imports and other synced devices whenever `blockedDomains` changes.
- `chrome.storage.session`: `dismissedWarnings` (`{ [tabId]: unlockKey }`), the tabs where the warning bar was hidden for the rest of an unlock.

A new synced setting must be added to `exportSettings`, `importSettings`, and `resetSettings` in `storage.js`, and usually also to the `onInstalled` seed in `background.js`.

### Blocking rules: two writers, by design

Each blocked domain gets one `declarativeNetRequest` dynamic **redirect** rule on `main_frame`. It uses `regexFilter` so that `\0` captures the full original URL.

- **The background** (`doSyncRules`) wipes and rebuilds every rule. It runs on install, on startup, on changes to `blockedDomains`, and on changes to `pausedUntil`. Calls are serialized through `syncChain` to avoid duplicate-id errors.
- **The popup** (`popup/rules.js`, called from `popup/actions.js`) adds and removes individual rules itself. This guarantees the rule change is finished before it navigates or reloads a tab. It also covers the case where the MV3 worker is asleep. Pause and resume follow the same pattern: the popup applies them immediately, and the background reacts to the storage change for other tabs.
- **Rules are identified by their `regexFilter` string, not by id.** The two writers assign ids differently (`i + 1` vs `maxId + 1`).
- **The background deliberately does not resync rules when `snoozed` changes.** The popup owns rule changes for snooze and unsnooze, and a resync there would race with it and re-block a site the user just unlocked. Don't add one. (A `snoozed` change only repaints the toolbar badges.)

### Blocked page URL contract

The redirect target is `blocked.html?domain=<domain>&url=<full original URL>`, and `url` **must stay last**. Readers take everything after `url=` as the original URL (`getBlockedOriginalUrl` in `popup/tabs.js`, `releaseAllBlockedTabs` in `background.js`) rather than using `URLSearchParams`, because the original URL can contain its own `?` and `&`.

### Alarms and the toolbar badge

- `snooze:<domain>` restores the block when an unlock ends and reloads open tabs on that domain (unless the domain has left the list or Focus Guard is off).
- `fg-pause-end` clears `pausedUntil`. The storage listener then rebuilds the rules.
- `badge-tick` repaints the toolbar badge. While a site is unlocked, each of its tabs shows the time left on the Focus Guard icon: `5m` … `1m` in amber, then `59s` … `1s` in red (the last minute, `WARNING_MS`). Badge colors are set per tab. Other tabs, and every tab while Focus Guard is off, show nothing. `updateBadges` schedules the next change itself: an alarm for waits of 30s or more (the minimum alarm delay), a `setTimeout` for shorter ones.
- **The warning bar.** When a tab's unlock reaches its last minute, `paintTab` injects `content/unlock-warning.js` into it (once per page and unlock, tracked in `warnedTabs`; again after the tab loads a new page). The bar lives in an open shadow root at the top center of the page, and from then on follows the unlock from storage by itself: it hides when "+1 min" takes the unlock out of its last minute, returns when the last minute starts again, and goes away when the unlock ends or Focus Guard is switched off. Its buttons message the background (`fg-extend-unlock`, `fg-dismiss-warning`), which takes the domain from the sending tab, never from the message. Hiding the bar records the tab in `dismissedWarnings`, so it isn't injected again for that unlock.
- **The popup never opens by itself.** Versions before 1.3.0 reopened it during the last 30s of an unlock (the `open-30` alarm and a `"popup"` runtime port). `RETIRED_ALARMS` clears that alarm on install and startup; don't bring the behavior back.

### YouTube content script

- Every YouTube setting is a `show*` flag: `true` shows the feature, and the default `false` hides it. The script hides a feature only when `enabled && !paused`.
- `CLASS_MAP` in `content/youtube.js` maps each flag to `fg-hide-*` classes on `<html>`, and `content/youtube.css` keys its selectors off those classes.
- The script re-runs on every DOM mutation (coalesced to one pass per animation frame) and on `yt-navigate-finish`, because YouTube is a lazy-loading SPA.
- YouTube changes its markup often. When an element stops hiding, check the selectors in `youtube.css` first.

To add a YouTube toggle:
1. Add the flag to `DEFAULT_YOUTUBE` in `shared/core.js`.
2. Add a `CLASS_MAP` entry in `content/youtube.js`.
3. Add CSS rules in `content/youtube.css`.
4. Add a row to the YouTube card in `popup/popup.html`: a `<label class="row">` holding the name and an `<input type="checkbox" role="switch" class="switch" data-yt="<flag>">`. `popup/youtube-view.js` binds every `[data-yt]` element automatically, and `importSettings` iterates over the `DEFAULT_YOUTUBE` keys. A row is 45px and the YouTube tab has only 8px to spare, so make room first (see **Fixed popup size**); `tests/popup-size.spec.js` fails if the tab overflows.

### Popup structure

`popup.js` wires the tab navigation and calls each view's `init*`. The views (`sites-view.js`, `youtube-view.js`, `settings-view.js`) contain the DOM code. They call `actions.js`, which combines storage, rules, and tabs operations and contains no DOM code. The views then re-render, and they also subscribe to `chrome.storage.onChanged` so changes made elsewhere show up.

`header-view.js` owns the header's on/off switch for the whole extension (the `pausedUntil` pause), which applies across all tabs. While the extension is paused, it dims the tab bar and sets `inert` on it, and jumps to the Sites tab (through the `onSwitchedOff` callback from `popup.js`). The Sites tab then shows the break: `sites-view.js` puts the time left in the circle with a "Turn on now" button, disables the "Blocked sites" row, and closes the list if it was open. The YouTube and Settings tabs can't be reached while paused, so they need no "paused" handling of their own.

**The circle** (`sites-view.js`, `updateStatusCircle`) has five states, each a `.circle.is-*` class: `unblock` (a blocked site: Unlock plus 2×/3×), `countdown` (an unlocked site: "0:42 until blocked", "+1 min", "Block now"; in the last minute `.is-warning` turns it and the "Unlocked" label red), `block` (a site that isn't blocked), `none` (a page that can't be blocked), and `off` (the break). Only `unblock` and `block` make the circle itself clickable; in the others it only displays.

**Alignment:** every label, field text, list item and section title starts on one inner edge, 31px from the popup's left (the 16px margin, a 1px border, 14px of padding), and every trailing control (switch, stepper, arrow, ✕) ends on one right edge, 309px. So rows don't get leading icons, and new rows use the same 14px padding. The header, tabs and card outlines sit on the outer edge (16px / 324px). The deliberate exceptions are the centered Sites tab and the centered titles of the list screens. `tests/alignment.spec.js` checks both edges on every view.

**Fixed popup size:** the popup is a fixed 340 × 420px on every tab and view, so it never jumps in size as you switch tabs. 420 is exactly the height of the tallest views, so no view is left with dead space: every row, card and gap in `popup.css` has a fixed height, and the views add up to the panel's height. The circle area absorbs the difference between circle states (states without buttons under the circle center it). The list views (blocked sites, allowed channels) fill the panel: their "← heading" row and Add field stay put, and the list scrolls on its own inside its box. Adding a row to a view means taking the height from somewhere else in it. Don't change the size without updating this rule, the README's Notes, and `tests/popup-size.spec.js`, which checks the size and that no panel overflows.

**Theme:** the popup, the blocked page and the warning bar follow Chrome's light or dark setting. `popup/popup.css` and the `<style>` in `blocked.html` each define the colors as tokens on `:root`, light first and dark under `prefers-color-scheme: dark`; `content/unlock-warning.js` writes the same values directly into its shadow-root styles. The shared colors use the same values in all three; keep them in sync by hand.

### Tests

`tests/fixtures.js` starts a fresh Chromium profile per test, with the repo root loaded unpacked:
- The `openPopup({ sync, local, activeTab })` fixture seeds `chrome.storage` through the background service worker, then opens `popup/popup.html` in a tab. Seeding waits until the extension's install-time defaults are written, so they can't overwrite a test's seed.
- The `readStorage(area, keys)` fixture reads storage back.
- The `background` fixture is the service worker. `tests/badge.spec.js` and `tests/warning-bar.spec.js` use it with real tabs, whose pages are served by `context.route`. The badge tests read `chrome.action.getBadgeText` / `getBadgeBackgroundColor`; the warning-bar tests find the bar on the page (Playwright reaches into its open shadow root).
- `unlockSite(background, domain, msLeft)` (exported from `fixtures.js`) puts a domain on the list, unlocked. It writes the unlock before the list, so the background's rule rebuild doesn't add a rule that would bounce the test page to the blocked page.

**Active tab:** opened as a tab, the popup counts itself as the active tab, so the circle shows "Nothing to block here". Pass `activeTab: { url, title }` to make the popup see that page as the active tab instead; it overrides `chrome.tabs.query` inside the popup page. The fake tab has no id, so actions skip their navigate/reload step: what the circle shows and what lands in storage can be tested, but the tab actually reloading onto the blocked page (or back to the site) still needs a manual check in Chrome.

Write tests against what a user sees: role- and label-based locators, visible text, and resulting storage.

## Permissions

`scripting` lets the background inject the warning bar into an unlocked site's tabs, and only there, only in the last minute. The alternative, a content script declared for every page, needs no permission but loads on every page the user opens.

`host_permissions: <all_urls>` is required because a `declarativeNetRequest` **redirect** rule needs host access. Switching to a plain `block` rule would remove that requirement but lose the custom blocked page. Keep this trade-off in mind before changing manifest permissions, since they are justified in the Chrome Web Store listing.

## Agent skills

### Issue tracker

Issues are tracked in this repo's GitHub Issues, using the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default roles, each label named after its role: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` plus `docs/adr/`, both created lazily. See `docs/agents/domain.md`.
