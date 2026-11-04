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

There are four runtime contexts. Their module systems differ:

| Context | Files | Module type |
|---|---|---|
| Background service worker | `background.js` | ES module (`"type": "module"` in manifest) |
| Popup | `popup/*.js`, entry `popup/popup.js` | ES modules |
| YouTube content script | `content/youtube.js` + `content/youtube.css` | **Classic script.** It cannot `import`. |
| Blocked page | `blocked.html` + `blocked.js` | Classic script |

`shared/core.js` is the single source of truth for defaults, `normalizeDomain`, and the rule regex and redirect builders (`blockRegexFor`, `blockSubstitutionFor`). The background imports it directly. The popup re-exports it through `popup/config.js` and `popup/util.js`. The content script can't import it, so it reads storage directly and duplicates a little logic: `channelKey` mirrors `normalizeChannel`, and a missing `show*` flag counts as false (off). Keep these copies in sync by hand.

### Storage

All popup storage access goes through `popup/storage.js`.

- `chrome.storage.sync`: `blockedDomains` (bare domains), `youtube` (see `DEFAULT_YOUTUBE`), `allowedChannels`, `unlockMinutes`, and `pauseMinutes` (how long the header switch turns Focus Guard off for).
- `chrome.storage.local`: `snoozed` and `pausedUntil` (a ms timestamp for the whole-extension pause).
  - `snoozed` has the shape `{ [domain]: { start, expiry, cap } }`. Older entries may be a bare expiry number. Always read entries through `expiryOf` / `startOf` / `capOf`.

A new synced setting must be added to `exportSettings`, `importSettings`, and `resetSettings` in `storage.js`, and usually also to the `onInstalled` seed in `background.js`.

### Blocking rules: two writers, by design

Each blocked domain gets one `declarativeNetRequest` dynamic **redirect** rule on `main_frame`. It uses `regexFilter` so that `\0` captures the full original URL.

- **The background** (`doSyncRules`) wipes and rebuilds every rule. It runs on install, on startup, on changes to `blockedDomains`, and on changes to `pausedUntil`. Calls are serialized through `syncChain` to avoid duplicate-id errors.
- **The popup** (`popup/rules.js`, called from `popup/actions.js`) adds and removes individual rules itself. This guarantees the rule change is finished before it navigates or reloads a tab. It also covers the case where the MV3 worker is asleep. Pause and resume follow the same pattern: the popup applies them immediately, and the background reacts to the storage change for other tabs.
- **Rules are identified by their `regexFilter` string, not by id.** The two writers assign ids differently (`i + 1` vs `maxId + 1`).
- **The background deliberately does not resync rules when `snoozed` changes.** The popup owns rule changes for snooze and unsnooze, and a resync there would race with it and re-block a site the user just unlocked. Don't add one.

### Blocked page URL contract

The redirect target is `blocked.html?domain=<domain>&url=<full original URL>`, and `url` **must stay last**. Readers take everything after `url=` as the original URL (`getBlockedOriginalUrl` in `popup/tabs.js`, `releaseAllBlockedTabs` in `background.js`) rather than using `URLSearchParams`, because the original URL can contain its own `?` and `&`.

### Alarms and the popup port

- `snooze:<domain>` restores the block when an unlock ends and reloads open tabs on that domain.
- `fg-pause-end` clears `pausedUntil`. The storage listener then rebuilds the rules.
- `open-30` fires 30s before the nearest snooze expires. It opens the popup (which shows the countdown ring), but only when the active tab is on the expiring domain.
- On load, the popup connects a runtime port named `"popup"`. The background uses it to tell whether the popup is open, so it can reopen the popup while the user stays on the expiring site.

### YouTube content script

- Every YouTube setting is a `show*` flag: `true` shows the feature, and the default `false` hides it. The script hides a feature only when `enabled && !paused`.
- `CLASS_MAP` in `content/youtube.js` maps each flag to `fg-hide-*` classes on `<html>`, and `content/youtube.css` keys its selectors off those classes.
- The script re-runs on every DOM mutation (coalesced to one pass per animation frame) and on `yt-navigate-finish`, because YouTube is a lazy-loading SPA.
- YouTube changes its markup often. When an element stops hiding, check the selectors in `youtube.css` first.

To add a YouTube toggle:
1. Add the flag to `DEFAULT_YOUTUBE` in `shared/core.js`.
2. Add a `CLASS_MAP` entry in `content/youtube.js`.
3. Add CSS rules in `content/youtube.css`.
4. Add a checkbox with `data-yt="<flag>"` to `popup/popup.html`. `popup/youtube-view.js` binds every `[data-yt]` element automatically, and `importSettings` iterates over the `DEFAULT_YOUTUBE` keys.

### Popup structure

`popup.js` wires the tab navigation and calls each view's `init*`. The views (`sites-view.js`, `youtube-view.js`, `settings-view.js`) contain the DOM code. They call `actions.js`, which combines storage, rules, and tabs operations and contains no DOM code. The views then re-render, and they also subscribe to `chrome.storage.onChanged` so changes made elsewhere show up.

`header-view.js` owns the header's on/off switch for the whole extension (the `pausedUntil` pause), which applies across all tabs. While the extension is paused, it dims `#app-body` (everything below the header) and sets `inert` on it, so nothing there can be clicked, focused, or read by assistive tech. It also shows the `#off-notice` message over the dimmed area; the notice sits outside `#app-body` so it isn't dimmed or inert itself. Controls inside the tabs therefore don't need their own "paused" handling.

**Fixed popup size:** the popup is a fixed 340 × 560px on every tab and view, so it never jumps in size as you switch tabs. If a view needs more room, it scrolls inside the area below the tab bar (the active `.panel`); the header and tabs stay put. The list views (blocked sites, allowed channels) fill the panel instead: their "← heading" row and Add field stay put, and the list scrolls on its own. Don't change the size without updating this rule, the README's Notes, and `tests/popup-size.spec.js`, which enforces it.

### Tests

`tests/fixtures.js` starts a fresh Chromium profile per test, with the repo root loaded unpacked:
- The `openPopup({ sync, local })` fixture seeds `chrome.storage` through the background service worker, then opens `popup/popup.html` in a tab. Seeding waits until the extension's install-time defaults are written, so they can't overwrite a test's seed.
- The `readStorage(area, keys)` fixture reads storage back.

Two consequences of opening the popup as a tab rather than as a real popup:
- **Active tab:** the popup counts itself as the active tab, so the circle always shows "can't block". Anything that depends on the active tab being a real site needs a manual check.
- **Timed opening:** `chrome.action.openPopup` behavior, like the 30-second reminder, can't be tested.

Write tests against what a user sees: role- and label-based locators, visible text, and resulting storage.

## Permissions

`host_permissions: <all_urls>` is required because a `declarativeNetRequest` **redirect** rule needs host access. Switching to a plain `block` rule would remove that requirement but lose the custom blocked page. Keep this trade-off in mind before changing manifest permissions, since they are justified in the Chrome Web Store listing.

## Agent skills

### Issue tracker

Issues are tracked in this repo's GitHub Issues, using the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default roles, each label named after its role: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `GLOSSARY.md` plus `docs/adr/`, both created lazily. See `docs/agents/domain.md`.
