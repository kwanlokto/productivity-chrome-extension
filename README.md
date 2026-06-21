# 🌱 Focus Guard — Productivity Chrome Extension

A Manifest V3 Chrome extension that protects your attention by blocking
distracting sites and taming YouTube's doom-scroll machinery.

## Features

- **Site blocking** — Facebook, Instagram, and TikTok are blocked out of the box.
  Blocked visits are redirected to a calm reminder page, and a one-click **Unlock**
  lifts the block for a set number of minutes (then it re-blocks automatically).
- **Custom block list** — Add or remove any domain from the popup, or block the site
  you're currently on. Your list syncs across your Chrome profile via
  `chrome.storage.sync`.
- **YouTube focus** — Each surface is a toggle that *shows* it when on and *hides* it
  when off; all default off, so turning on YouTube tweaks clears the page until you
  switch back on what you actually want:
  - **Home Feed** — replaces the home grid with a gentle nudge to search intentionally
  - **Shorts** — hides Shorts shelves, the sidebar entry, and Shorts in search
  - **Recommendations** — hides the watch-page sidebar and end-screen cards
  - **Comments** — hides the comment section
  - **Allowed channels only** — show videos only from an allow-list; opening a
    non-allowed video shows a block screen with a "watch anyway" escape
- **Settings tab** — Change how long "Unlock" lifts a block for, save your settings
  to a JSON file, load them back, or reset everything to defaults.

## How it works

| Piece | Role |
|-------|------|
| [background.js](background.js) | Syncs `declarativeNetRequest` dynamic rules from your blocked-domain list and redirects matching `main_frame` loads to the blocked page; restores blocks when a snooze alarm fires. |
| [blocked.html](blocked.html) / [blocked.js](blocked.js) | The "stay focused" page shown when a blocked site is opened. |
| [popup/](popup/) | The toolbar UI (ES modules — see below). |
| [content/youtube.js](content/youtube.js) / [content/youtube.css](content/youtube.css) | Toggle `<html>` classes that hide distracting YouTube elements; re-applies across SPA navigation. |

### Popup modules

The popup ([popup/popup.html](popup/popup.html)) loads [popup/popup.js](popup/popup.js)
as an ES module, which is split by concern:

| Module | Responsibility |
|--------|----------------|
| [config.js](popup/config.js) | Constants (defaults, snooze length, ring geometry). |
| [util.js](popup/util.js) | Pure helpers: domain/channel normalization, clock formatting. |
| [storage.js](popup/storage.js) | All `chrome.storage` reads/writes (domains, YouTube settings, channels, snooze). |
| [rules.js](popup/rules.js) | Add/remove `declarativeNetRequest` blocking rules directly. |
| [tabs.js](popup/tabs.js) | `chrome.tabs` helpers (active tab, current domain, navigate, reload). |
| [actions.js](popup/actions.js) | High-level actions (add/remove/block/snooze/unsnooze) combining the above. |
| [sites-view.js](popup/sites-view.js) | "Blocked sites" tab: list + the circular status/action control. |
| [youtube-view.js](popup/youtube-view.js) | "YouTube" tab: focus toggles + allowed-channels list. |
| [settings-view.js](popup/settings-view.js) | "Settings" tab: unlock duration, backup/restore to a file, reset to defaults. |
| [popup.js](popup/popup.js) | Entry point: tab navigation + view init. |

Settings live in `chrome.storage.sync` under `blockedDomains` (array of bare
domains), `youtube` (the feature toggles), `allowedChannels` (allow-listed
handles), and `unlockMinutes` (how long "Unlock" lifts a block for). Active
snoozes live in `chrome.storage.local` under `snoozed`
(`{ domain: { start, expiry } }`).

## Install (developer / unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder.
4. Pin **Focus Guard** and click the icon to manage your block list and YouTube settings.

## Publish to the Chrome Web Store

### 1. Build the upload zip

The store wants a `.zip` with `manifest.json` at the **root** (not nested in a
folder). Two ways to produce it:

- **Locally** — zip the project, excluding repo/dev files:
  ```powershell
  # from the project root (PowerShell)
  $items = Get-ChildItem -Force |
    Where-Object { $_.Name -notin @('.git', '.github', 'dist', 'focus-guard.zip') }
  Compress-Archive -Path $items.FullName -DestinationPath focus-guard.zip -Force
  ```
- **Via CI** — the [build workflow](.github/workflows/build.yml) produces
  `focus-guard-v<version>.zip` on every push to `main` (downloadable from the run's
  **Artifacts**), and attaches it to a GitHub Release when you push a `v*` tag:
  ```powershell
  git tag v1.1.0
  git push origin v1.1.0
  ```

### 2. Register as a developer (one time)

1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Sign in and pay the **one-time \$5** registration fee.

### 3. Create the listing

1. Click **Add new item** and upload the zip from step 1.
2. Fill in the store listing:
   - **Description** and **category** (e.g. *Productivity*).
   - At least one **1280×800** (or 640×400) screenshot — the popup and the blocked
     page are good choices.
   - The **128×128** store icon (already in [icons/](icons/)).

### 4. Privacy & permissions review

This extension requests broad access, so the dashboard will require you to justify it:

- **`host_permissions: <all_urls>`** — needed so a `declarativeNetRequest` *redirect*
  rule can send any blocked site to the in-extension reminder page (redirect rules
  require host access to the request). Justify it as: *"Redirect user-chosen blocked
  domains to the extension's blocked page."*
- **`declarativeNetRequest`, `tabs`, `alarms`, `storage`** — blocking rules, reading
  the active tab to drive the popup, scheduling the snooze re-block, and saving
  settings, respectively.
- **Privacy policy URL** — required because of the broad host access. A short page
  stating that Focus Guard stores your block list and settings only in Chrome
  storage and **does not collect, transmit, or sell any data** is enough (host it
  anywhere, e.g. GitHub Pages).
- In **Privacy practices**, declare that no user data is collected.

### 5. Submit, then update

- Click **Submit for review**. Review typically takes hours to a few days; broad
  host permissions can draw extra scrutiny. Choose **Unlisted** if you don't want it
  publicly searchable.
- For every later upload, **bump `version`** in [manifest.json](manifest.json) — the
  store rejects a re-upload of an existing version number.

> **Tip:** to minimize review friction you can swap the `redirect` blocking rule for
> a plain `block` rule, which doesn't need `<all_urls>` — but you'd lose the custom
> blocked page in favor of Chrome's generic block screen.

## Notes

- YouTube changes its markup often; if an element stops being hidden, the selectors
  in [content/youtube.css](content/youtube.css) may need updating.
- Domain blocking matches the domain and all subdomains (e.g. blocking `facebook.com`
  also blocks `m.facebook.com`).
